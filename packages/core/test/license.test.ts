import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkLicense, findLicenseFiles, identifyLicenses, licenseCategory } from '../src/license.js';

// Opening lines of each license, enough for the signatures; the full texts are not needed.
const MIT = `Copyright (c) 2026 Someone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal`;
const GPL3 = `                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007`;
const GPL2 = `GNU GENERAL PUBLIC LICENSE
Version 2, June 1991`;
const LGPL3 = `                   GNU LESSER GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007

  This version of the GNU Lesser General Public License incorporates
the terms and conditions of version 3 of the GNU General Public
License, supplemented by the additional permissions listed below.`;
const APACHE = `                                 Apache License
                           Version 2.0, January 2004`;
const BSD3 = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
3. Neither the name of the copyright holder nor the names of its contributors`;
const CC_BY_SA = 'Creative Commons Attribution-ShareAlike 4.0 International Public License';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-license-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('identifyLicenses', () => {
  it('recognizes common license texts, whatever their line breaks', () => {
    expect(identifyLicenses(MIT)).toEqual(['MIT']);
    expect(identifyLicenses(GPL3)).toEqual(['GPL-3.0']);
    expect(identifyLicenses(GPL2)).toEqual(['GPL-2.0']);
    expect(identifyLicenses(APACHE)).toEqual(['Apache-2.0']);
    expect(identifyLicenses(BSD3)).toEqual(['BSD-3-Clause']);
    expect(identifyLicenses(CC_BY_SA)).toEqual(['CC-BY-SA-4.0']);
  });

  it("doesn't take the LGPL's mentions of the GPL for the GPL", () => {
    expect(identifyLicenses(LGPL3)).toEqual(['LGPL-3.0']);
  });

  it('lists every license in a file that bundles several', () => {
    expect(identifyLicenses(`${MIT}\n\nThe vendored parser:\n${GPL2}`)).toEqual(['GPL-2.0', 'MIT']);
  });

  it('returns nothing for text it does not know', () => {
    expect(identifyLicenses('All rights reserved.')).toEqual([]);
  });
});

describe('licenseCategory', () => {
  it('sorts SPDX IDs into permissive, copyleft and unknown', () => {
    expect(licenseCategory('MIT')).toBe('permissive');
    expect(licenseCategory('Apache-2.0')).toBe('permissive');
    expect(licenseCategory('BSD-2-Clause')).toBe('permissive');
    expect(licenseCategory('GPL-3.0-or-later')).toBe('copyleft');
    expect(licenseCategory('LGPL-2.1-only')).toBe('copyleft');
    expect(licenseCategory('CC-BY-SA-4.0')).toBe('copyleft');
    expect(licenseCategory('CC-BY-4.0')).toBe('permissive');
    expect(licenseCategory('LicenseRef-proprietary')).toBe('unknown');
  });
});

describe('findLicenseFiles', () => {
  it('takes the nearest directory with license files, from a file or a directory', async () => {
    await mkdir(join(dir, 'repo', 'tests', 'data'), { recursive: true });
    await writeFile(join(dir, 'repo', 'COPYING'), GPL3);
    await writeFile(join(dir, 'repo', 'LICENSE-MIT'), MIT);
    await writeFile(join(dir, 'repo', 'tests', 'data', 'case.json'), '{}');
    const expected = [join(dir, 'repo', 'COPYING'), join(dir, 'repo', 'LICENSE-MIT')];
    expect(await findLicenseFiles(join(dir, 'repo', 'tests', 'data', 'case.json'))).toEqual(expected);
    expect(await findLicenseFiles(join(dir, 'repo', 'tests'))).toEqual(expected);
  });

  it('stops at a repository root', async () => {
    await mkdir(join(dir, 'repo', '.git'), { recursive: true });
    await mkdir(join(dir, 'repo', 'tests'));
    await writeFile(join(dir, 'LICENSE'), MIT);
    expect(await findLicenseFiles(join(dir, 'repo', 'tests'))).toEqual([]);
  });

  it('ignores a dangling symlink named like a license file', async () => {
    await symlink(join(dir, 'missing'), join(dir, 'LICENSE'));
    await writeFile(join(dir, 'COPYING'), MIT);
    expect(await findLicenseFiles(dir)).toEqual([join(dir, 'COPYING')]);
  });

  it('ignores directories named like license files', async () => {
    await mkdir(join(dir, 'license'));
    await writeFile(join(dir, 'LICENSE.txt'), MIT);
    expect(await findLicenseFiles(dir)).toEqual([join(dir, 'LICENSE.txt')]);
  });
});

describe('checkLicense', () => {
  it('detects a permissive license without a warning', async () => {
    await writeFile(join(dir, 'LICENSE'), MIT);
    await writeFile(join(dir, 'cases.test'), '');
    expect(await checkLicense(join(dir, 'cases.test'))).toEqual({
      licenses: ['MIT'],
      category: 'permissive',
      method: 'detected',
      files: [join(dir, 'LICENSE')],
    });
  });

  it('warns about copyleft sources', async () => {
    await writeFile(join(dir, 'COPYING'), GPL3);
    const check = await checkLicense(dir);
    expect(check).toMatchObject({ licenses: ['GPL-3.0'], category: 'copyleft', method: 'detected' });
    expect(check.warning).toMatch(/GPL-3\.0.*don't commit/);
  });

  it('treats a source mixing permissive and copyleft licenses as copyleft', async () => {
    await writeFile(join(dir, 'LICENSE'), `${MIT}\n${GPL2}`);
    expect(await checkLicense(dir)).toMatchObject({ licenses: ['GPL-2.0', 'MIT'], category: 'copyleft' });
  });

  it('reports a source with no license file as unknown', async () => {
    await mkdir(join(dir, '.git'));
    const check = await checkLicense(dir);
    expect(check).toMatchObject({ licenses: [], category: 'unknown', method: 'none', files: [] });
    expect(check.warning).toMatch(/No license found/);
  });

  it('reports an unrecognized license file as unknown', async () => {
    await writeFile(join(dir, 'LICENSE'), 'All rights reserved.');
    expect(await checkLicense(dir)).toMatchObject({ licenses: [], category: 'unknown', method: 'detected' });
  });

  it('prefers a declared SPDX expression to detection', async () => {
    await writeFile(join(dir, 'LICENSE'), GPL3);
    expect(await checkLicense(dir, 'MIT')).toEqual({ licenses: ['MIT'], category: 'permissive', method: 'declared', files: [] });
    expect(await checkLicense(dir, '(MIT OR Apache-2.0)')).toMatchObject({ licenses: ['Apache-2.0', 'MIT'], category: 'permissive' });
    expect(await checkLicense(dir, 'MIT AND GPL-2.0-only')).toMatchObject({ category: 'copyleft' });
    expect(await checkLicense(dir, 'LicenseRef-mine')).toMatchObject({ category: 'unknown' });
    expect(await checkLicense(dir, 'MIT and GPL-3.0')).toMatchObject({ licenses: ['GPL-3.0', 'MIT'], category: 'copyleft' });
  });
});
