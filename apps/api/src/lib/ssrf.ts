/**
 * Guards for outbound probe requests.
 *
 * ## What this file is, and what it is not
 *
 * A prober is a server-side request forgery primitive by construction: it fetches
 * a URL that a human configured. This module reduces that to a *bounded* risk and
 * nothing more. It is worth being explicit about the boundary, because
 * overstating it is how a real vulnerability gets shipped behind a comment
 * claiming it was handled:
 *
 *   * The only defence that actually removes the class of attack is **not
 *     accepting URLs from untrusted parties**. v1 probes are configured by an
 *     operator behind `INTERNAL_KEY`, and that is the primary control. The
 *     checks here are depth, not the wall.
 *   * **Hostname-string validation cannot stop DNS rebinding.** A hostname that
 *     resolves to a public address when this code runs can resolve to `127.0.0.1`
 *     a moment later when `fetch` resolves it. Closing that requires resolving
 *     the name here and pinning the connection to the validated address, which
 *     the Workers `fetch` API does not expose. Anyone opening probe configuration
 *     to third parties must do that dedicated egress design first.
 *
 * ## Redirects are refused, not followed
 *
 * `redirect: "manual"` means a 3xx is returned to the caller instead of being
 * followed, so a permitted host cannot bounce the request to an internal one.
 * Re-validating every hop would also work, but refusing outright is simpler and
 * leaves no hop unvalidated. A 3xx is recorded as a probe failure.
 */

/** Response bodies larger than this are not read. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Ports a probe target may use. Anything else must be justified explicitly. */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

export class ProbeUrlRejected extends Error {
  constructor(
    message: string,
    readonly reason: ProbeUrlReason,
  ) {
    super(message);
    this.name = "ProbeUrlRejected";
  }
}

export type ProbeUrlReason =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "port"
  | "blocked_host"
  | "blocked_address";

/**
 * Hostname suffixes that are never routable on the public internet, plus the
 * special-use names from RFC 6761/6762. Checked after lowercasing and after
 * stripping a single trailing dot, so `LOCALHOST.` does not slip through.
 */
const BLOCKED_SUFFIXES: readonly string[] = [
  "localhost",
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".invalid",
  ".test",
  ".example",
];

/** IPv4 ranges that must never be reachable from a probe. */
interface V4Range {
  readonly label: string;
  readonly a: number;
  readonly bits: number;
}

const BLOCKED_V4: readonly V4Range[] = [
  { label: "0.0.0.0/8", a: 0x00000000, bits: 8 },
  { label: "10.0.0.0/8", a: 0x0a000000, bits: 8 },
  { label: "100.64.0.0/10 (CGNAT)", a: 0x64400000, bits: 10 },
  { label: "127.0.0.0/8 (loopback)", a: 0x7f000000, bits: 8 },
  { label: "169.254.0.0/16 (link-local)", a: 0xa9fe0000, bits: 16 },
  { label: "172.16.0.0/12 (private)", a: 0xac100000, bits: 12 },
  { label: "192.0.0.0/24 (IETF protocol)", a: 0xc0000000, bits: 24 },
  { label: "192.0.2.0/24 (documentation)", a: 0xc0000200, bits: 24 },
  { label: "192.88.99.0/24 (6to4 relay)", a: 0xc0586300, bits: 24 },
  { label: "192.168.0.0/16 (private)", a: 0xc0a80000, bits: 16 },
  { label: "198.18.0.0/15 (benchmarking)", a: 0xc6120000, bits: 15 },
  { label: "198.51.100.0/24 (documentation)", a: 0xc6336400, bits: 24 },
  { label: "203.0.113.0/24 (documentation)", a: 0xcb007100, bits: 24 },
  { label: "224.0.0.0/4 (multicast)", a: 0xe0000000, bits: 4 },
  { label: "240.0.0.0/4 (reserved)", a: 0xf0000000, bits: 4 },
];

function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    // Deliberately strict: exactly 1-3 digits, no leading zeros. WHATWG URL
    // already normalises decimal/octal/hex forms such as `0177.0.0.1` into
    // dotted-quad before we see them, but re-implementing the loose grammar here
    // would reintroduce the ambiguity that normalisation removed.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function inV4Range(value: number, range: V4Range): boolean {
  const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
  return (value & mask) === (range.a & mask);
}

function classifyIpv4(host: string): string | null {
  const value = parseIpv4(host);
  if (value === null) return null;
  for (const range of BLOCKED_V4) {
    if (inV4Range(value, range)) return range.label;
  }
  return null;
}

/** Expand an IPv6 literal to its eight 16-bit groups, or null if malformed. */
function parseIpv6(input: string): number[] | null {
  let host = input;
  // A zone index (`fe80::1%eth0`) is not routable information and is dropped.
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  if (host.length === 0) return null;

  // A trailing dotted-quad (`::ffff:127.0.0.1`) contributes two groups.
  let tail: number[] = [];
  const lastColon = host.lastIndexOf(":");
  const tailCandidate = host.slice(lastColon + 1);
  if (tailCandidate.includes(".")) {
    const v4 = parseIpv4(tailCandidate);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    host = host.slice(0, lastColon + 1);
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0] ?? "");
  if (head === null) return null;

  if (halves.length === 1) {
    const all = [...head, ...tail];
    return all.length === 8 ? all : null;
  }

  const rest = toGroups(halves[1] ?? "");
  if (rest === null) return null;
  const missing = 8 - head.length - rest.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest, ...tail];
}

function classifyIpv6(host: string): string | null {
  const groups = parseIpv6(host);
  if (groups === null) return null;

  const allZero = groups.every((group) => group === 0);
  if (allZero) return ":: (unspecified)";

  const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  if (isLoopback) return "::1 (loopback)";

  const first = groups[0] ?? 0;
  // fc00::/7 unique local
  if ((first & 0xfe00) === 0xfc00) return "fc00::/7 (unique local)";
  // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfe80) return "fe80::/10 (link-local)";
  // ff00::/8 multicast
  if ((first & 0xff00) === 0xff00) return "ff00::/8 (multicast)";
  // 2001:db8::/32 documentation
  if (first === 0x2001 && groups[1] === 0x0db8) return "2001:db8::/32 (documentation)";
  // 64:ff9b::/96 NAT64 — can reach v4 space, so it is treated as an alias for
  // the v4 checks rather than as its own range.
  if (first === 0x0064 && groups[1] === 0xff9b) return "64:ff9b::/96 (NAT64)";

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms carry a v4 address
  // that the v4 rules must still see.
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isCompatible = groups.slice(0, 6).every((g) => g === 0);
  if (isMapped || isCompatible) {
    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    const label = classifyIpv4(dotted);
    if (label !== null) return `${label} (via IPv6 ${isMapped ? "mapped" : "compatible"} form)`;
  }

  return null;
}

function isIpv6Literal(host: string): boolean {
  return host.includes(":");
}

export interface ProbeUrlOptions {
  allowedPorts?: readonly number[];
  /** Hostnames that are explicitly permitted, matched exactly (lowercased). */
  allowedHosts?: readonly string[];
}

/**
 * Validate a probe URL, returning the parsed `URL` or throwing.
 *
 * Callers must treat a throw as "this target is misconfigured" and record a
 * probe failure; it is never a transient condition worth retrying.
 */
export function assertProbeUrlAllowed(raw: string, options: ProbeUrlOptions = {}): URL {
  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProbeUrlRejected(`not a valid absolute URL: ${raw}`, "invalid_url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProbeUrlRejected(`scheme ${url.protocol} is not http or https`, "scheme");
  }

  // `https://user:pass@host/` would send credentials to whatever the host is,
  // and in a URL that a human pasted that is far more likely to be a leak than
  // an intent.
  if (url.username !== "" || url.password !== "") {
    throw new ProbeUrlRejected("URLs with embedded credentials are refused", "credentials");
  }

  // `URL` keeps the brackets on an IPv6 literal in `host`, so strip them before
  // matching; `hostname` already excludes them but is not always present in
  // older runtimes, and this file must not depend on that.
  const rawHost = url.hostname.toLowerCase();
  const host = rawHost.replace(/^\[|\]$/g, "");
  const hostname = host.endsWith(".") ? host.slice(0, -1) : host;

  if (hostname === "") {
    throw new ProbeUrlRejected("URL has no host", "invalid_url");
  }

  const allowedHosts = (options.allowedHosts ?? []).map((value) => value.toLowerCase());
  if (!allowedHosts.includes(hostname)) {
    for (const suffix of BLOCKED_SUFFIXES) {
      if (suffix.startsWith(".") ? hostname.endsWith(suffix) : hostname === suffix) {
        throw new ProbeUrlRejected(`host ${hostname} is not routable`, "blocked_host");
      }
    }

    const addressLabel = isIpv6Literal(hostname)
      ? classifyIpv6(hostname)
      : classifyIpv4(hostname);
    if (addressLabel !== null) {
      throw new ProbeUrlRejected(`host ${hostname} is in ${addressLabel}`, "blocked_address");
    }
  }

  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!allowedPorts.includes(port)) {
    throw new ProbeUrlRejected(
      `port ${port} is not in the allowed set (${allowedPorts.join(", ")})`,
      "port",
    );
  }

  return url;
}

export interface ProbeFetchResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  /** Short, non-sensitive description of what went wrong. */
  error: string | null;
}

export interface ProbeFetchOptions {
  method?: "GET" | "HEAD";
  expectedStatus?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Perform one probe request.
 *
 * Never throws: a probe that cannot be made is a *failed probe*, which is
 * information the state machine needs, not an exception that aborts a cron run.
 */
export async function fetchProbe(
  rawUrl: string,
  options: ProbeFetchOptions = {},
): Promise<ProbeFetchResult> {
  const method = options.method ?? "GET";
  const expectedStatus = options.expectedStatus ?? 200;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());

  let url: URL;
  try {
    url = assertProbeUrlAllowed(rawUrl);
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: 0,
      error: error instanceof ProbeUrlRejected ? `rejected: ${error.message}` : describe(error),
    };
  }

  const startedAt = now();
  try {
    const response = await fetchImpl(url.toString(), {
      method,
      // Refused rather than followed: a permitted host must not be able to bounce
      // the request somewhere the checks above never saw.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": "allclear-probe/1.0",
        accept: "*/*",
      },
    });

    // Read and discard a bounded amount of body. The probe's verdict comes from
    // the status code, but a server that streams without end must not be able to
    // hold the run open, so the read is capped.
    await drainCapped(response, maxBodyBytes);

    const latencyMs = now() - startedAt;

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        statusCode: response.status,
        latencyMs,
        error: `redirect not followed (status ${response.status})`,
      };
    }

    if (response.status !== expectedStatus) {
      return {
        ok: false,
        statusCode: response.status,
        latencyMs,
        error: `unexpected status ${response.status}, expected ${expectedStatus}`,
      };
    }

    return { ok: true, statusCode: response.status, latencyMs, error: null };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: now() - startedAt,
      error: describe(error),
    };
  }
}

async function drainCapped(response: Response, maxBytes: number): Promise<void> {
  const body = response.body;
  if (body === null) return;

  const reader = body.getReader();
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      read += value?.byteLength ?? 0;
      if (read >= maxBytes) return;
    }
  } finally {
    // Cancelling rather than draining the rest: the cap is the point.
    await reader.cancel().catch(() => undefined);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
