import { invoke } from "@tauri-apps/api/core";

/** Opens a GitHub link in the default browser and brings it to the front (src-tauri/src/browser.rs). */
export function openInBrowser(url: string): Promise<void> {
  return invoke("open_in_browser", { url });
}
