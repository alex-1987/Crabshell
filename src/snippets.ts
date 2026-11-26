import { invoke } from "@tauri-apps/api/core";
import { byOrder } from "./useListDrag";

/** Same limit as the backend (well below the 64 KiB terminal write limit). */
export const MAX_SNIPPET_BYTES = 32 * 1024;

export type Snippet = {
  id: string;
  name: string;
  text: string;
  tags: string[];
};

type SnippetList = { snippets: Snippet[]; recovered: boolean };

export function listSnippets(): Promise<SnippetList> {
  return invoke<SnippetList>("snippets_list");
}

export function saveSnippet(snippet: Snippet): Promise<Snippet[]> {
  return invoke<Snippet[]>("snippets_save", { snippet });
}

export function deleteSnippet(id: string): Promise<Snippet[]> {
  return invoke<Snippet[]>("snippets_delete", { id });
}

/** Saves a new order (all snippet ids); returns the stored list. */
export function reorderSnippets(ids: string[]): Promise<Snippet[]> {
  return invoke<Snippet[]>("snippets_reorder", { ids });
}

/** Snippets are pasted without trailing line breaks; anything left with a break is multiline. */
export function isMultilineSnippet(text: string): boolean {
  return /[\r\n]/.test(text.replace(/[\r\n]+$/, ""));
}

export function parseTags(value: string): string[] {
  const tags: string[] = [];
  for (const raw of value.split(",")) {
    const tag = raw.trim();
    if (tag && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  return tags;
}

/**
 * All tags with their use count: compared case-insensitively, the first spelling wins.
 * Sorted by `order` (lower-case keys, set by dragging the chips), the rest alphabetically.
 */
export function snippetTags(snippets: Snippet[], order: readonly string[] = []) {
  const tags = new Map<string, { key: string; label: string; count: number }>();
  for (const snippet of snippets) {
    for (const tag of new Set(snippet.tags.map((item) => item.toLowerCase()))) {
      const label = snippet.tags.find((item) => item.toLowerCase() === tag) ?? tag;
      const entry = tags.get(tag) ?? { key: tag, label, count: 0 };
      entry.count += 1;
      tags.set(tag, entry);
    }
  }
  return byOrder([...tags.values()], (tag) => tag.key, order, (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

/** Every search word must match the name, a tag or the text (case-insensitive). Names rank first. */
export function filterSnippets(snippets: Snippet[], query: string): Snippet[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return snippets;
  const scored: { snippet: Snippet; score: number }[] = [];
  for (const snippet of snippets) {
    const name = snippet.name.toLowerCase();
    const tags = snippet.tags.map((tag) => tag.toLowerCase());
    const text = snippet.text.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (name.includes(word)) score += 3;
      else if (tags.some((tag) => tag.includes(word))) score += 2;
      else if (text.includes(word)) score += 1;
      else {
        score = -1;
        break;
      }
    }
    if (score >= 0) scored.push({ snippet, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((item) => item.snippet);
}

export function firstLine(text: string): string {
  return text.replace(/^[\r\n]+/, "").split(/\r\n|\r|\n/)[0] ?? "";
}
