import type { Score } from '@port-anything/core';
import { percent } from './html.js';

const LABEL = 'parity';

/** The right half of the badge: "97.3% · 31 features · 12.8k cases". */
function message(score: Score): string {
  const features = score.headlineFeatures.length;
  const cases = score.raw.cases;
  return `${score.headline === null ? 'n/a' : percent(score.headline)} · ${features} feature${features === 1 ? '' : 's'} · ${shortCount(cases)} case${cases === 1 ? '' : 's'}`;
}

/**
 * The badge's text, "parity 97.3% · 31 features · 12.8k cases": the headline as the report shows
 * it, the features it is the mean of, and every case of the run (shortened, rounded down).
 */
export function badgeText(score: Score): string {
  return `${LABEL} ${message(score)}`;
}

/** 999 → "999", 12_850 → "12.8k", 1_000 → "1k", 2_340_000 → "2.3M": rounded down, so never more than the count. */
export function shortCount(n: number): string {
  if (n < 1000) return String(n);
  // In tenths of the unit, as an integer, so no float rounding can round up.
  const [tenths, unit] = n < 1_000_000 ? [Math.floor(n / 100), 'k'] : [Math.floor(n / 100_000), 'M'];
  return `${tenths / 10}${unit}`;
}

/** Shields' colours: brightgreen at 100%, yellow from 90%, red below, grey without a headline. */
function color(headline: number | null): string {
  if (headline === null) return '#9f9f9f';
  return headline >= 1 ? '#4c1' : headline >= 0.9 ? '#dfb317' : '#e05d44';
}

// Advance widths of Verdana at 11px, the badge font; other characters count as `DEFAULT_WIDTH`.
// Approximate: `textLength` stretches the text to the computed width whatever font renders it.
const WIDTHS: Record<string, number> = {
  ' ': 3.9, '·': 3.9, '.': 3.9, '/': 4.9, '%': 11.9,
  a: 6.7, b: 6.9, c: 5.8, d: 6.9, e: 6.6, f: 3.9, g: 6.9, h: 7.0, i: 3.0, j: 3.8, k: 6.5, l: 3.0, m: 10.7,
  n: 7.0, o: 6.7, p: 6.9, q: 6.9, r: 4.7, s: 5.7, t: 4.3, u: 7.0, v: 6.5, w: 9.0, x: 6.5, y: 6.5, z: 5.8,
  M: 9.9,
};
const DEFAULT_WIDTH = 7.0;
const PADDING = 6;

const textWidth = (text: string) => Math.round([...text].reduce((sum, ch) => sum + (WIDTHS[ch] ?? DEFAULT_WIDTH), 0));

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * A shields-style ("flat") badge for one candidate, as a standalone SVG: "parity" on grey, the
 * rest of `badgeText` coloured by the headline. Nothing fetched; the same score gives the same bytes.
 */
export function renderBadgeSvg(score: Score): string {
  const text = badgeText(score);
  const right = message(score);
  const lw = textWidth(LABEL) + 2 * PADDING;
  const rw = textWidth(right) + 2 * PADDING;
  const w = lw + rw;
  // Text is drawn at 10× and scaled down, as shields does, for finer positioning.
  const label = (s: string, x: number, width: number) =>
    `<text aria-hidden="true" x="${x * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(width - 2 * PADDING) * 10}">${xml(s)}</text>` +
    `<text x="${x * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${(width - 2 * PADDING) * 10}">${xml(s)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${xml(text)}">
<title>${xml(text)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="${color(score.headline)}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">${label(LABEL, lw / 2, lw)}${label(right, lw + rw / 2, rw)}</g>
</svg>
`;
}
