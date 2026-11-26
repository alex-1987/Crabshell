import type { AppSettings, ProxyType } from "./terminalTypes";

/** Proxy passed to `connect_host` / `test_connection` (ProxyConfig in src-tauri/src/proxy.rs). */
export type ProxyConfig = { kind: ProxyType; host: string; port: number };

/** The proxy for servers that use it, or null when it is switched off or not filled in (direct connection). */
export function activeProxy(settings: Pick<AppSettings, "proxyEnabled" | "proxyType" | "proxyHost" | "proxyPort">): ProxyConfig | null {
  const host = settings.proxyHost.trim();
  if (!settings.proxyEnabled || !host || !settings.proxyPort) return null;
  return { kind: settings.proxyType, host, port: settings.proxyPort };
}

/** "SOCKS5 proxy.example.com:1080" */
export function proxyLabel(proxy: ProxyConfig): string {
  return `${proxy.kind === "http" ? "HTTP" : "SOCKS5"} ${proxy.host}:${proxy.port}`;
}
