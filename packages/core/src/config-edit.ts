import { isMap, isScalar, isSeq, parseDocument, stringify, type Document } from 'yaml';
import type { NormalizerSpec } from './normalize.js';

/**
 * A normalizer as an entry of the `normalizers` list: its name alone when it has no options, scope
 * or features, otherwise a map (`{ pids: null, scope: stderr }`). Reads back as the same spec.
 */
export function normalizerEntry(spec: NormalizerSpec): unknown {
  const options = Object.keys(spec.options).length === 0 ? null : spec.options;
  if (options === null && spec.scope === undefined && spec.features === undefined) return spec.name;
  return {
    [spec.name]: options,
    ...(spec.scope === undefined ? {} : { scope: spec.scope.length === 1 ? spec.scope[0] : spec.scope }),
    ...(spec.features === undefined ? {} : { features: spec.features }),
  };
}

/** One line of YAML for an entry; maps in flow style. */
function entryText(entry: unknown): string {
  return typeof entry === 'string' ? stringify(entry).trimEnd() : stringify(entry, { collectionStyle: 'flow' }).trimEnd();
}

/**
 * The text of `port-anything.yaml` with these normalizers appended to its `normalizers` list, each
 * with a comment. A block list gets new lines after its last entry, and a missing list is added at
 * the end, so the rest of the file stays byte for byte as it was. Other layouts (a flow list, an
 * empty key) are edited through the YAML document, which keeps comments but may reformat.
 */
export function appendNormalizers(source: string, additions: readonly { spec: NormalizerSpec; comment: string }[]): string {
  if (additions.length === 0) return source;
  const entries = additions.map((a) => normalizerEntry(a.spec));
  const doc = parseDocument(source);
  const before = (doc.toJS() as { normalizers?: unknown[] } | null)?.normalizers ?? [];
  const expected = JSON.stringify([...before, ...entries]);
  const lines = (indent: string) => additions.map((a, i) => `${indent}${entryText(entries[i])} # ${a.comment}\n`).join('');

  let edited: string | undefined;
  const pair = isMap(doc.contents) ? doc.contents.items.find((p) => isScalar(p.key) && p.key.value === 'normalizers') : undefined;
  if (isMap(doc.contents) && pair === undefined) {
    edited = `${source}${source === '' || source.endsWith('\n') ? '' : '\n'}normalizers:\n${lines('  - ')}`;
  } else if (pair !== undefined && isSeq(pair.value) && !pair.value.flow && pair.value.items.length > 0) {
    const items = pair.value.items as { range?: [number, number, number] }[];
    const [first, last] = [items[0]!.range, items.at(-1)!.range];
    if (first && last) {
      const prefix = source.slice(source.lastIndexOf('\n', first[0] - 1) + 1, first[0]);
      let end = last[1]; // a block map's range takes the blank lines after it
      while (end > last[0] && /\s/.test(source[end - 1]!)) end--;
      const lineEnd = source.indexOf('\n', end);
      if (/^[ ]*-[ ]+$/.test(prefix)) {
        const at = lineEnd === -1 ? source.length : lineEnd + 1;
        edited = `${source.slice(0, at)}${lineEnd === -1 ? '\n' : ''}${lines(prefix)}${source.slice(at)}`;
      }
    }
  }
  // Use the text edit only if it reads back as intended; otherwise edit the document.
  if (edited !== undefined && JSON.stringify((parseDocument(edited).toJS() as { normalizers?: unknown[] }).normalizers) === expected) return edited;
  return documentEdit(doc, additions, entries);
}

function documentEdit(doc: Document, additions: readonly { comment: string }[], entries: unknown[]): string {
  let seq = doc.get('normalizers', true);
  if (!isSeq(seq)) {
    seq = doc.createNode([]);
    doc.set('normalizers', seq);
  }
  const list = seq as ReturnType<Document['createNode']> & { items: unknown[] };
  for (const [i, entry] of entries.entries()) {
    const node = doc.createNode(entry, { flow: true });
    node.comment = ` ${additions[i]!.comment}`;
    list.items.push(node);
  }
  return doc.toString();
}

/**
 * The text of `port-anything.yaml` with these `corpus` keys set (the section is added when
 * missing), edited through the YAML document so comments stay. Unchanged text when every key
 * already has its value.
 */
export function setCorpusSettings(source: string, values: Readonly<Record<string, string | number>>): string {
  const doc = parseDocument(source);
  const corpus = (doc.toJS() as { corpus?: Record<string, unknown> } | null)?.corpus ?? {};
  const changed = Object.entries(values).filter(([key, value]) => corpus[key] !== value);
  if (changed.length === 0) return source;
  for (const [key, value] of changed) doc.setIn(['corpus', key], value);
  return doc.toString();
}
