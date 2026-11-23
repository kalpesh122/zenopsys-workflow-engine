/**
 * JSON.parse reviver applied to every request body. Rejects values that JSON allows but
 * that would break later, so they fail fast as 400 INVALID_JSON instead of a 500 or silent
 * corruption:
 *  - "\u0000" in a string or key: Postgres JSONB/text cannot store NUL characters.
 *  - non-finite numbers (1e309 parses to Infinity): JSON.stringify turns them into null,
 *    so a rule value would be silently stored as null and never match.
 *  - the key "__proto__": assigning it sets an object's prototype instead of a property,
 *    so such a field could never be submitted and the run would get stuck.
 */
export function rejectUnsafeJson(key: string, value: unknown): unknown {
  if (key === '__proto__') throw new SyntaxError('the key "__proto__" is not allowed');
  if (key.includes('\u0000') || (typeof value === 'string' && value.includes('\u0000'))) {
    throw new SyntaxError('NUL characters (\\u0000) are not allowed');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new SyntaxError('numbers must be finite');
  }
  return value;
}
