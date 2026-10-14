import { scoreCandidate, type ScoredCase } from '@port-anything/core';
import { describe, expect, it } from 'vitest';
import { badgeText, percent, renderBadgeSvg, shortCount } from '../src/index.js';

// Needs @port-anything/core built (`pnpm build`), like the CLI tests.

const id = (n: number) => `sha256:${n.toString(16).padStart(8, '0')}${'a'.repeat(56)}`;

/** `n` cases per feature, the first `diverging[i]` of feature i diverging. */
function score(features: readonly string[], n: number, diverging: readonly number[] = []) {
  const cases: ScoredCase[] = features.flatMap((feature, f) =>
    Array.from({ length: n }, (_, k) => ({ caseId: id(f * n + k), features: [feature], origin: 'recorded' as const, verdict: k < (diverging[f] ?? 0) ? ('diverge' as const) : ('match' as const) })),
  );
  return scoreCandidate(cases, { minCasesPerFeature: 20 });
}

describe('badgeText', () => {
  it('matches the headline the report shows (done when)', () => {
    // base 24/25, opt.n 22/25, opt.w 25/25 → mean 0.9466…
    const s = score(['base', 'opt.n', 'opt.w'], 25, [1, 3]);
    expect(s.headline).toBeCloseTo(0.94666, 4);
    expect(badgeText(s)).toBe(`parity ${percent(s.headline!)} · 3 features · 75 cases`);
    expect(badgeText(s)).toBe('parity 94.6% · 3 features · 75 cases');
  });

  it('counts the headline features only, and every case of the run', () => {
    // opt.help is self-description and opt.x under-sampled: neither is in the headline, both in the case count.
    const cases: ScoredCase[] = [
      ...Array.from({ length: 30 }, (_, k) => ({ caseId: id(k), features: ['base'], origin: 'generated' as const, verdict: 'match' as const })),
      ...Array.from({ length: 4 }, (_, k) => ({ caseId: id(100 + k), features: ['opt.help'], origin: 'generated' as const, verdict: 'diverge' as const })),
      ...Array.from({ length: 5 }, (_, k) => ({ caseId: id(200 + k), features: ['opt.x'], origin: 'generated' as const, verdict: 'diverge' as const })),
    ];
    expect(badgeText(scoreCandidate(cases, { minCasesPerFeature: 20 }))).toBe('parity 100.0% · 1 feature · 39 cases');
  });

  it('says n/a without a headline', () => {
    expect(badgeText(score(['base'], 1))).toBe('parity n/a · 0 features · 1 case');
  });

  it('shortens large case counts, rounding down', () => {
    expect([0, 999, 1000, 1099, 12_850, 12_899, 999_999, 1_000_000, 2_399_999].map(shortCount)).toEqual(['0', '999', '1k', '1k', '12.8k', '12.8k', '999.9k', '1M', '2.3M']);
    expect(badgeText(score(['base', 'opt.n'], 6400))).toBe('parity 100.0% · 2 features · 12.8k cases');
  });
});

describe('renderBadgeSvg', () => {
  const s = score(['base', 'opt.n', 'opt.w'], 25, [1, 3]);
  const svg = renderBadgeSvg(s);

  it('carries the badge text as its accessible name and title, and shows both halves', () => {
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="20" role="img" aria-label="parity 94\.6% · 3 features · 75 cases">\n<title>parity 94\.6% · 3 features · 75 cases<\/title>/);
    const shown = [...svg.matchAll(/<text x="[\d.]+" y="140"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(' ');
    expect(shown).toBe(badgeText(s));
  });

  it('is coloured by the headline', () => {
    const fill = (svg: string) => /<rect x="\d+" width="\d+" height="20" fill="([^"]+)"/.exec(svg)![1];
    expect(fill(svg)).toBe('#dfb317');
    expect(fill(renderBadgeSvg(score(['base'], 20)))).toBe('#4c1');
    expect(fill(renderBadgeSvg(score(['base'], 20, [3])))).toBe('#e05d44');
    expect(fill(renderBadgeSvg(score(['base'], 2)))).toBe('#9f9f9f');
  });

  it('is as wide as its two halves, and fetches nothing', () => {
    const width = Number(/^<svg [^>]*width="(\d+)"/.exec(svg)![1]);
    const rects = [...svg.matchAll(/<rect (?:x="\d+" )?width="(\d+)" height="20" fill="#(?:555|[0-9a-f]{3,6})"/g)].map((m) => Number(m[1]));
    expect(rects.reduce((a, b) => a + b, 0)).toBe(width);
    expect(svg).not.toMatch(/<image|<script|href=|@import|https:\/\//);
  });

  it('renders the same bytes for the same score', () => {
    expect(renderBadgeSvg(s)).toBe(svg);
  });
});
