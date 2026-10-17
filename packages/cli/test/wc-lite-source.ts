// The wc-lite port's source as the compiler sees it for a set of its cargo features, without the
// `#[cfg]` attributes that select the bad ports' code.

/** A `#[cfg(…)]` line whose predicate names a bad port's feature. */
const BAD_CFG = /^\s*#\[cfg\((((?:not|any)\()?feature = "bad-.*)\)\]\s*$/;

/** Whether a cfg predicate (`feature = "…"`, `not(…)`, `any(…)`, `all(…)`) holds with `features` on. */
function holds(predicate: string, features: ReadonlySet<string>): boolean {
  let p = predicate.replace(/feature = "([a-z-]+)"/g, (_, f: string) => String(features.has(f)));
  for (let prev = ''; prev !== p; ) {
    prev = p;
    p = p
      .replace(/not\((true|false)\)/g, (_, v: string) => String(v === 'false'))
      .replace(/any\(((?:true|false)(?:, (?:true|false))*)\)/g, (_, vs: string) => String(vs.includes('true')))
      .replace(/all\(((?:true|false)(?:, (?:true|false))*)\)/g, (_, vs: string) => String(!vs.includes('false')));
  }
  if (p !== 'true' && p !== 'false') throw new Error(`can't evaluate #[cfg(${predicate})]`);
  return p === 'true';
}

/**
 * `source` with the bad ports' `features` compiled in and every other bad port's code left out:
 * each `#[cfg]` on a bad port's feature goes, with the item under it when its predicate doesn't
 * hold, and the comment lines just above a bad port's own code (its "Bug: …" note) go either
 * way. With `blank`, those lines are emptied instead of removed, so line numbers stay.
 */
export function portSource(source: string, options: { features?: readonly string[]; blank?: boolean } = {}): string {
  const features = new Set(options.features ?? []);
  const drop = options.blank === true ? '' : undefined;
  const lines = source.split('\n');
  const out: (string | undefined)[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const cfg = BAD_CFG.exec(line);
    if (cfg === null) {
      out.push(line);
      continue;
    }
    // A bad port's own code (not the good port's, under `not(…)`): the notes above it go.
    if (cfg[2] !== 'not(') for (let k = out.length - 1; k >= 0 && /^\s*\/\//.test(out[k] ?? ''); k--) out[k] = drop;
    out.push(drop);
    if (holds(cfg[1]!, features)) continue;
    // The item: up to its matching closing brace when it opens one, else to the end of the statement.
    let depth = 0;
    for (i++; i < lines.length; i++) {
      const code = lines[i]!.replace(/\/\/.*$/, '');
      for (const ch of code) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
      out.push(drop);
      if (depth === 0 && /[;}]\s*$/.test(code)) break;
    }
  }
  return out.filter((l) => l !== undefined).join('\n');
}
