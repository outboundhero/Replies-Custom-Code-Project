const TIMEOUT_MS = 4000;

/**
 * Given a domain (e.g. "back-swing-golfevents.info"), follow HTTP redirects
 * to find the final destination URL (e.g. "https://backswinggolfevents.com").
 * Returns the final URL string or empty string on failure/timeout.
 */
export async function resolveRedirectLink(domain: string): Promise<string> {
  if (!domain) return "";

  const url = `http://${domain}`;

  // Try HEAD first (faster, no body download)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    // response.url is the final URL after all redirects
    return response.url;
  } catch {
    // HEAD failed — try GET (some servers reject HEAD)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.url;
    } catch {
      return "";
    }
  }
}
