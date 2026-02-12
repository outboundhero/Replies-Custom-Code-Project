/**
 * Clean reply text: prefer text_body, fall back to html_body.
 * Strips HTML tags, decodes entities, normalizes whitespace.
 */
export function cleanReply(textBody: string, htmlBody: string): string {
  let raw = textBody?.trim() || "";

  if (!raw && htmlBody) {
    raw = htmlBody
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .trim();
  }

  return raw;
}
