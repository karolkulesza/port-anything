import { describe, expect, it } from 'vitest';
import { weakCorpusDiagnosis } from '../src/corpus-diagnosis.js';

const usage = 'usage: xxd [options] [infile [outfile]]\n    or\n       xxd -r [-s [-]offset] [-c cols] [-ps] [infile [outfile]]\n';

describe('weakCorpusDiagnosis', () => {
  it('names the features without a case and the usage text that most answers were', () => {
    const untested = ['opt.b', 'opt.C', 'opt.E', 'opt.e', 'opt.h', 'opt.i', 'opt.u'];
    expect(weakCorpusDiagnosis({ untested, observed: 1000, commonestError: { answers: 780, text: usage } })).toBe(
      "7 features got no case (opt.b, opt.C, opt.E, opt.e, opt.h, opt.i, opt.u): 78% of the reference's answers were its usage text",
    );
  });

  it('says when most answers were one error even though every feature has a case', () => {
    expect(weakCorpusDiagnosis({ untested: [], observed: 200, commonestError: { answers: 150, text: usage } })).toBe(
      "75% of the reference's answers were its usage text, so most cases test only that",
    );
  });

  it('quotes an error that is not the usage text', () => {
    const text = "\nfrob: invalid count 'abc'; the count must be a whole number of lines, at least one\nTry 'frob --help'.\n";
    expect(weakCorpusDiagnosis({ untested: ['opt.x'], observed: 10, commonestError: { answers: 9, text } })).toBe(
      "1 feature got no case (opt.x): 90% of the reference's answers were one error (\"frob: invalid count 'abc'; the count must be a whole number of lines, at…\")",
    );
    expect(weakCorpusDiagnosis({ untested: [], observed: 10, commonestError: { answers: 6, text: '' } })).toBe(
      "60% of the reference's answers were one error (no output), so most cases test only that",
    );
  });

  it('lists the features without a case alone when no error dominates', () => {
    expect(weakCorpusDiagnosis({ untested: ['opt.x', 'opt.y'], observed: 100, commonestError: { answers: 50, text: usage } })).toBe('2 features got no case (opt.x, opt.y)');
    expect(weakCorpusDiagnosis({ untested: ['opt.x'], observed: 100 })).toBe('1 feature got no case (opt.x)');
  });

  it('has nothing to say about a corpus that covers every feature without one dominant error', () => {
    expect(weakCorpusDiagnosis({ untested: [], observed: 100, commonestError: { answers: 50, text: usage } })).toBeUndefined();
    expect(weakCorpusDiagnosis({ untested: [], observed: 0 })).toBeUndefined();
  });
});
