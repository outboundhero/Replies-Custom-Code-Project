/**
 * Tiny, browser-safe HTML ↔ plain-text helpers. No server deps — safe in the
 * client bundle. Used so operators can edit an email body as plain text while
 * we keep an HTML string for the live preview + send.
 */

/** HTML → readable plain text: keep line breaks, drop tags, decode entities. */
export function htmlToText(s: string): string {
  return String(s || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

/** Plain text → safe HTML: escape, then newlines → <br>. */
export function textToHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}
