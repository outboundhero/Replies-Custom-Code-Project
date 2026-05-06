/**
 * Make an arbitrary string safe to write into Airtable's "Long text" cell.
 *
 * Two failure modes we've hit in production:
 *
 *   - INVALID_VALUE_FOR_COLUMN — Airtable's documented 100,000-character
 *     limit is treated more strictly than the docs imply. Multi-byte
 *     UTF-8 can push a 100k-character string above the byte ceiling, and
 *     even just-under-the-limit strings sometimes fail. Truncating to
 *     90k characters has cleared every retry batch we've thrown at it.
 *
 *   - Control characters (NUL, BEL, etc.) embedded in some email
 *     bodies cause the same generic 422 even when the length is fine.
 *     Strip everything that isn't a printable character or one of the
 *     three whitespace characters Airtable allows in long text.
 */
export function sanitizeForAirtableLongText(input: string): string {
  if (!input) return "";
  // Strip C0 control chars except \t (\x09), \n (\x0A), \r (\x0D),
  // and the C1 control range U+0080 – U+009F.
  // eslint-disable-next-line no-control-regex
  const stripped = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
  if (stripped.length <= 90_000) return stripped;
  return stripped.slice(0, 90_000);
}
