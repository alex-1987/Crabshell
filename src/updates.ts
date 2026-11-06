import { useEffect, useState } from "react";

/**
 * Update check: asks GitHub for the latest published release (one anonymous request, at most
 * every 12 hours, nothing about the user is sent) and compares it with the running version.
 * Can be turned off in Settings → General → Updates.
 */

const REPOSITORY = "alex-1987/Crabshell";
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${REPOSITORY}/releases/tag/`;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
// Per-device conveniences: last answer from GitHub and the version the user dismissed.
const CACHE_KEY = "crabshell.update-check.v1";
const DISMISSED_KEY = "crabshell.update-dismissed.v1";

export type UpdateInfo = { version: string; url: string };

/** "v0.2.10" → [0, 2, 10]; null for anything else (pre-releases are not offered). */
function parseVersion(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(latest: number[], current: number[]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (latest[index] !== current[index]) return latest[index] > current[index];
  }
  return false;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Only a convenience: the next start checks again.
  }
}

/** Latest release tag, from the cache when it is recent enough. */
async function latestTag(force = false): Promise<string | null> {
  const cached = readJson<{ checkedAt: number; tag: string }>(CACHE_KEY);
  if (!force && cached && typeof cached.tag === "string" && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) return cached.tag;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json" }, signal: controller.signal });
    if (!response.ok) return null;
    const data = (await response.json()) as { tag_name?: unknown };
    if (typeof data.tag_name !== "string") return null;
    write(CACHE_KEY, JSON.stringify({ checkedAt: Date.now(), tag: data.tag_name }));
    return data.tag_name;
  } catch {
    // Offline, rate-limited or blocked: no notice, try again next start.
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

export type CheckResult = { kind: "newer"; update: UpdateInfo } | { kind: "current"; latest: string } | { kind: "error" };

/** "Check now" in the settings: always asks GitHub, also when the automatic check is off. */
export async function checkNow(currentVersion: string): Promise<CheckResult> {
  const current = parseVersion(currentVersion);
  const tag = await latestTag(true);
  const latest = tag ? parseVersion(tag) : null;
  if (!current || !tag || !latest) return { kind: "error" };
  const version = latest.join(".");
  return isNewer(latest, current)
    ? { kind: "newer", update: { version, url: RELEASE_PAGE + encodeURIComponent(tag) } }
    : { kind: "current", latest: version };
}

/** A newer release than `currentVersion`, unless checking is off or the user dismissed it. */
export function useUpdateCheck(enabled: boolean, currentVersion: string) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    const current = parseVersion(currentVersion);
    if (!enabled || !current) {
      setUpdate(null);
      return;
    }
    let active = true;
    void latestTag().then((tag) => {
      const latest = tag ? parseVersion(tag) : null;
      if (!active || !tag || !latest || !isNewer(latest, current)) return;
      const version = latest.join(".");
      if (readJson<string>(DISMISSED_KEY) === version) return;
      setUpdate({ version, url: RELEASE_PAGE + encodeURIComponent(tag) });
    });
    return () => {
      active = false;
    };
  }, [enabled, currentVersion]);

  function dismiss() {
    if (update) write(DISMISSED_KEY, JSON.stringify(update.version));
    setUpdate(null);
  }

  return { update, dismiss };
}
