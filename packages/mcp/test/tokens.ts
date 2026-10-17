/**
 * An upper estimate of the tokens a text takes in an LLM tokenizer: a word of letters is a token
 * per 4 letters (rounded up), a number a token per 3 digits, a line break or any other
 * character a token (2 outside ASCII); spaces are free, as BPE tokenizers merge a space with the
 * word after it. Real tokenizers merge more (common words, punctuation pairs), so they count fewer.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const [piece] of text.matchAll(/[A-Za-z]+|\d+|\n| +|./gsu)) {
    if (/^[A-Za-z]/.test(piece)) n += Math.ceil(piece.length / 4);
    else if (/^\d/.test(piece)) n += Math.ceil(piece.length / 3);
    else if (piece.startsWith(' ')) n += 0;
    else n += piece.charCodeAt(0) < 128 ? 1 : 2;
  }
  return n;
}
