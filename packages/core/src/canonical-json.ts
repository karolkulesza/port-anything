/**
 * Serializes a JSON value in one canonical form, so equal values always give the same bytes: object
 * keys sorted by UTF-16 code units, no whitespace, strings and numbers as `JSON.stringify` writes
 * them. That is the RFC 8785 (JCS) form for the values used here.
 */
export function canonicalJson(value: unknown): string {
  return write(value, '$');
}

function write(value: unknown, path: string): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot canonicalize ${value} at ${path}.`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item, i) => write(item, `${path}[${i}]`)).join(',')}]`;
  if (typeof value === 'object' && isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new TypeError(`Cannot canonicalize undefined at ${path}.${key}.`);
      parts.push(`${JSON.stringify(key)}:${write(item, `${path}.${key}`)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalize a ${typeof value} at ${path}.`);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
