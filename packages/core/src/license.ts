import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * `permissive`: cases taken from the source may go into a repo under any license. `copyleft`
 * (GPL family, MPL, EPL, CC-BY-SA…): they carry the source's terms, so they must not be committed
 * into a repo under an incompatible license. `unknown`: nothing recognized, so treat as copyleft.
 */
export type LicenseCategory = 'permissive' | 'copyleft' | 'unknown';

/** Result of the license check made for every import source, kept with the import. */
export interface LicenseCheck {
  /** SPDX IDs that apply, sorted. Empty when nothing was declared or recognized. */
  licenses: string[];
  category: LicenseCategory;
  /** `declared` by the caller, `detected` from license files, or `none` found. */
  method: 'declared' | 'detected' | 'none';
  /** License files read, for `detected`. */
  files: string[];
  /** Set unless the category is `permissive`: what to watch out for. */
  warning?: string;
}

const COPYLEFT = /^(A?GPL|LGPL|MPL|EPL|EUPL|OSL|CC-BY-SA|CC-BY-NC|CDDL)-|^(SSPL|CPAL)/;
const PERMISSIVE = /^(MIT|ISC|0BSD|BSD-[23]-Clause|Apache-2\.0|Zlib|Unlicense|CC0-1\.0|BSL-1\.0|PSF-2\.0|Python-2\.0|Unicode-|ICU$|X11$|curl$|CC-BY-[0-9])/;

/** Category of one SPDX ID; anything unlisted is `unknown`. */
export function licenseCategory(spdx: string): LicenseCategory {
  const id = spdx.replace(/-(only|or-later)$|\+$/, '');
  if (COPYLEFT.test(id)) return 'copyleft';
  if (PERMISSIVE.test(id)) return 'permissive';
  return 'unknown';
}

const flat = (text: string) => text.replace(/\s+/g, ' ');

// Phrases from each license's own text (titles are matched in capitals, as the texts print them,
// so the LGPL's mentions of "the GNU General Public License" don't count as the GPL).
const SIGNATURES: [string, (t: string) => boolean][] = [
  ['AGPL-3.0', (t) => /GNU AFFERO GENERAL PUBLIC LICENSE/.test(t)],
  ['LGPL-3.0', (t) => /GNU LESSER GENERAL PUBLIC LICENSE Version 3/.test(t)],
  ['LGPL-2.1', (t) => /GNU LESSER GENERAL PUBLIC LICENSE Version 2\.1/.test(t)],
  ['LGPL-2.0', (t) => /GNU LIBRARY GENERAL PUBLIC LICENSE/.test(t)],
  ['GPL-3.0', (t) => /GNU GENERAL PUBLIC LICENSE Version 3/.test(t)],
  ['GPL-2.0', (t) => /GNU GENERAL PUBLIC LICENSE Version 2/.test(t)],
  ['MPL-2.0', (t) => /Mozilla Public License,? [Vv]ersion 2\.0/.test(t)],
  ['EPL-2.0', (t) => /Eclipse Public License - v 2\.0/.test(t)],
  ['CC-BY-SA-4.0', (t) => /Attribution-ShareAlike 4\.0/.test(t)],
  ['CC-BY-SA-3.0', (t) => /Attribution-ShareAlike 3\.0/.test(t)],
  ['Apache-2.0', (t) => /Apache License,? Version 2\.0/i.test(t)],
  ['MIT', (t) => /Permission is hereby granted, free of charge, to any person obtaining a copy of this software/.test(t)],
  ['ISC', (t) => /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/.test(t)],
  ['BSD-3-Clause', (t) => /Redistribution and use in source and binary forms/.test(t) && /Neither the name/i.test(t)],
  ['BSD-2-Clause', (t) => /Redistribution and use in source and binary forms/.test(t) && !/Neither the name/i.test(t)],
  ['Unlicense', (t) => /This is free and unencumbered software released into the public domain/.test(t)],
  ['Zlib', (t) => /Altered source versions must be plainly marked as such/.test(t)],
];

/** SPDX IDs of the licenses whose text appears in `text`, sorted. Unrecognized text gives []. */
export function identifyLicenses(text: string): string[] {
  const t = flat(text);
  return SIGNATURES.filter(([, matches]) => matches(t)).map(([id]) => id).sort();
}

/** The most cautious category among several licenses (all of which apply at once). */
function combined(licenses: readonly string[]): LicenseCategory {
  const categories = licenses.map(licenseCategory);
  if (categories.includes('copyleft')) return 'copyleft';
  return categories.length === 0 || categories.includes('unknown') ? 'unknown' : 'permissive';
}

function warningFor(category: LicenseCategory, licenses: readonly string[]): string | undefined {
  if (category === 'permissive') return undefined;
  if (category === 'copyleft') {
    return `Imported cases carry the source's license (${licenses.join(', ')}): don't commit them into a repo under an incompatible license.`;
  }
  return licenses.length > 0
    ? `Unrecognized license (${licenses.join(', ')}): check it before committing imported cases.`
    : 'No license found for this source: check it before committing imported cases.';
}

const LICENSE_FILE = /^(licen[cs]e|copying)([-._].*)?$/i;

const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');

/**
 * License files that govern `path`: those in the nearest directory, from `path` (or its directory)
 * up, that has any. The search stops at a repository root (a directory holding `.git`) or the file
 * system root.
 */
export async function findLicenseFiles(path: string): Promise<string[]> {
  let dir = resolve(path);
  try {
    if (!(await stat(dir)).isDirectory()) dir = dirname(dir);
  } catch (e) {
    if (!isMissing(e)) throw e;
    dir = dirname(dir);
  }
  for (;;) {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    const files: string[] = [];
    for (const name of names.filter((n) => LICENSE_FILE.test(n)).sort()) {
      try {
        if ((await stat(join(dir, name))).isFile()) files.push(join(dir, name));
      } catch (e) {
        if (!isMissing(e)) throw e; // a dangling symlink
      }
    }
    if (files.length > 0 || names.includes('.git')) return files;
    const parent = dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

/**
 * Checks the license of an import source. A `declared` SPDX expression (`MIT`, `GPL-3.0 OR MIT`
 * is split on AND/OR/WITH and treated as all applying) wins; otherwise the license files found by
 * `findLicenseFiles` are read and recognized.
 */
export async function checkLicense(path: string, declared?: string): Promise<LicenseCheck> {
  if (declared !== undefined && declared.trim() !== '') {
    const licenses = [...new Set(declared.split(/\s+(?:AND|OR|WITH)\s+|[()]/i).map((s) => s.trim()).filter(Boolean))].sort();
    const category = combined(licenses);
    return withWarning({ licenses, category, method: 'declared', files: [] });
  }
  const files = await findLicenseFiles(path);
  const licenses = new Set<string>();
  for (const file of files) for (const id of identifyLicenses(await readFile(file, 'utf8'))) licenses.add(id);
  const sorted = [...licenses].sort();
  const method = files.length > 0 ? 'detected' : 'none';
  return withWarning({ licenses: sorted, category: combined(sorted), method, files });
}

function withWarning(check: LicenseCheck): LicenseCheck {
  const warning = warningFor(check.category, check.licenses);
  return warning === undefined ? check : { ...check, warning };
}
