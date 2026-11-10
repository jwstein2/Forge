/**
 * Only https links (and 1Password item links for vault references) ever reach an href.
 * Anything else, including javascript:, data: and http:, is dropped and shown as plain text.
 */
export function safeHref(url: string | null | undefined, opts: { vault?: boolean } = {}): string | null {
  if (!url) return null;
  const u = url.trim();
  if (opts.vault && /^onepassword:\/\/[^\s]+$/i.test(u)) return u;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:') return null;
    if (opts.vault && !/(^|\.)1password\.(com|ca|eu)$/i.test(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}
