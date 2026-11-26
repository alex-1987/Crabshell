import { invoke } from "@tauri-apps/api/core";
import type { IBufferCellPosition, ILink, ILinkHandler, ILinkProvider, Terminal } from "@xterm/xterm";

/** A web link found in a piece of text: [start, end) are string indexes. */
export type FoundUrl = { url: string; start: number; end: number };

/** Stops at whitespace, quotes and characters that never occur unescaped in links. */
const URL_PATTERN = /https?:\/\/[^\s"'<>`\\^{|}]+/g;
const CLOSING: Record<string, string> = { ")": "(", "]": "[" };

/**
 * Web links in terminal text. Trailing sentence punctuation and closing brackets without an
 * opening one in the link ("(see https://example.com).") are not part of the link.
 */
export function findUrls(text: string): FoundUrl[] {
  const found: FoundUrl[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0];
    for (;;) {
      const last = url.at(-1) ?? "";
      const opening = CLOSING[last];
      if (".,;:!?*".includes(last)) url = url.slice(0, -1);
      else if (opening && url.split(opening).length <= url.split(last).length - 1) url = url.slice(0, -1);
      else break;
    }
    if (/^https?:\/\/[^/]/.test(url)) found.push({ url, start: match.index, end: match.index + url.length });
  }
  return found;
}

/** Ctrl+click (Cmd+click on macOS) opens a link; a plain click keeps selecting text. */
function wantsToOpen(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

type LinkCallbacks = {
  /** Shows the link and the hint while the mouse is over it; null hides it again. */
  onHover: (url: string | null) => void;
  /** Opening failed (e.g. no browser). */
  onError: (error: unknown) => void;
};

function open(url: string, callbacks: LinkCallbacks): void {
  invoke("open_terminal_link", { url }).catch(callbacks.onError);
}

/**
 * Plain-text web links: the logical line (wrapped rows joined) is read cell by cell, so wide
 * characters and links that wrap onto the next row get the right range.
 */
function linkProvider(terminal: Terminal, callbacks: LinkCallbacks): ILinkProvider {
  return {
    provideLinks(lineNumber, callback) {
      const buffer = terminal.buffer.active;
      let first = lineNumber - 1;
      while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1;
      let text = "";
      const positions: IBufferCellPosition[] = [];
      for (let row = first; row < buffer.length; row += 1) {
        const line = buffer.getLine(row);
        if (!line || (row > first && !line.isWrapped)) break;
        for (let column = 0; column < terminal.cols; column += 1) {
          const cell = line.getCell(column);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || " ";
          for (const char of chars) {
            text += char;
            positions.push({ x: column + 1, y: row + 1 });
          }
        }
      }
      const links: ILink[] = findUrls(text)
        .map(({ url, start, end }) => ({ url, start: positions[start], end: positions[end - 1] }))
        // Only links that touch the requested row; the others belong to their own rows.
        .filter(({ start, end }) => start && end && start.y <= lineNumber && end.y >= lineNumber)
        .map(({ url, start, end }) => ({
          range: { start, end },
          text: url,
          activate: (event: MouseEvent) => { if (wantsToOpen(event)) open(url, callbacks); },
          hover: () => callbacks.onHover(url),
          leave: () => callbacks.onHover(null),
        }));
      callback(links.length ? links : undefined);
    },
  };
}

/**
 * OSC 8 hyperlinks (ls --hyperlink, gcc, systemctl …): the visible text may differ from the
 * target, so the hover shows the real address. xterm only passes http(s) links here.
 */
function hyperlinkHandler(callbacks: LinkCallbacks): ILinkHandler {
  return {
    activate: (event, url) => { if (wantsToOpen(event)) open(url, callbacks); },
    hover: (_event, url) => callbacks.onHover(url),
    leave: () => callbacks.onHover(null),
  };
}

/** Makes web links in a terminal openable with Ctrl+click. */
export function enableTerminalLinks(terminal: Terminal, callbacks: LinkCallbacks): void {
  terminal.options.linkHandler = hyperlinkHandler(callbacks);
  terminal.registerLinkProvider(linkProvider(terminal, callbacks));
}
