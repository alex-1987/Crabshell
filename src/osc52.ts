/** OSC 52 clipboard escape sequences ("ESC ] 52 ; <targets> ; <base64> ESC \\"). */

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Upper bound for OSC 52 payloads (base64), so a program cannot flood the clipboard. */
const MAX_OSC52_LENGTH = 1024 * 1024;

/**
 * Decodes an OSC 52 payload "<targets>;<base64>". Returns null for queries ("?"), which
 * are handled separately (clipboard reads need permission), and for invalid data.
 */
export function decodeOsc52(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator < 0) return null;
  const payload = data.slice(separator + 1);
  if (payload === "?" || payload.length > MAX_OSC52_LENGTH) return null;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Reply to a clipboard query: the text for `target`, or an empty payload when there is none. */
export function encodeOsc52(target: string, text: string): string {
  return `\x1b]52;${target};${text ? utf8ToBase64(text) : ""}\x1b\\`;
}
