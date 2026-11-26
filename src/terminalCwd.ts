/**
 * The folder a remote shell is in, as far as it tells: OSC 7 ("file://host/path", sent by
 * Fedora's and other shells after each command) or, as a fallback, the window title that the
 * default Debian/Ubuntu prompt sets ("user@host: ~/dir").
 */

/** Path from an OSC 7 payload, or null. Only file:// URLs; the host part is ignored. */
export function dirFromOsc7(data: string): string | null {
  if (!data.startsWith("file://")) return null;
  const rest = data.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  try {
    const path = decodeURIComponent(rest.slice(slash));
    return path.startsWith("/") && !/[\0\r\n]/.test(path) ? path : null;
  } catch {
    return null;
  }
}

/** Path from a "user@host: ~/dir" title, or null for other titles (vim, htop, custom ones). */
export function dirFromTitle(title: string): string | null {
  const match = /^[^\s@:]+@[^\s:]+:\s?(~(?:\/.*)?|\/.*)$/.exec(title.trim());
  return match ? match[1].trimEnd() : null;
}
