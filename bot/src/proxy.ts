import { connect } from "node:net";

/**
 * ACCOUNT PROXIES. Accounts.Proxy is applied when the run's browser is
 * launched (slot.ts), so every request — the first Amazon page included —
 * goes through it. Chromium never falls back to a direct connection when its
 * proxy is down; it just fails to load, so an account with a proxy is never
 * seen on the machine's own IP. login checks the proxy answers before its
 * first page, so a dead one fails the run with a clear reason.
 */

const PROXY = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:([^@/]*)@)?([^:/@\s]+):(\d{1,5})\/?$/i;
const SCHEMES = new Set(["https", "http", "socks5"]);

export interface Proxy {
  /** What the browser is launched with, e.g. "http://host:port". */
  url: string;
  host: string;
  port: number;
  /** For logs: the url without any user:pass. */
  label: string;
}

/**
 * The sheet's Proxy cell -> a proxy, or null when blank. "host:port" means
 * http (the fleet's proxies). Throws on anything else: a proxy that does not
 * read must stop the run, never let it go direct.
 */
export function parseAccountProxy(raw: string): Proxy | null {
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(PROXY);
  const scheme = (m?.[1] ?? "http").toLowerCase();
  const port = Number(m?.[4]);
  if (!m || !SCHEMES.has(scheme) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Proxy "${t}" is not http://host:port`);
  }
  const host = m[3]!;
  const auth = m[2] ? `${m[2]}@` : "";
  return { url: `${scheme}://${auth}${host}:${port}`, host, port, label: `${scheme}://${host}:${port}` };
}

/** Null when the proxy accepts a connection, else why not. */
export function proxyUnreachable(p: Proxy, timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect({ host: p.host, port: p.port });
    const done = (why: string | null) => {
      socket.destroy();
      resolve(why);
    };
    socket.setTimeout(timeoutMs, () => done(`no answer in ${Math.round(timeoutMs / 1000)}s`));
    socket.once("connect", () => done(null));
    socket.once("error", (err) => done(err.message));
  });
}
