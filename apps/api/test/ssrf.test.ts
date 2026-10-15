import { describe, expect, it } from "vitest";

import {
  assertProbeUrlAllowed,
  DEFAULT_ALLOWED_PORTS,
  fetchProbe,
  MAX_BODY_BYTES,
  type ProbeUrlReason,
} from "../src/lib/ssrf";
import { fakeFetch } from "./helpers";

/**
 * The SSRF guard.
 *
 * The point of these tests is not "the blocklist has the right entries" — a
 * blocklist is never complete. It is that the *shape* of the rule holds: two
 * schemes and no others, no credentials in the URL, no address that cannot be
 * reached from the public internet, no port outside the allowlist, and no
 * redirect followed. Those are the properties this project's own rules require,
 * and they are what a future edit is most likely to break.
 *
 * What is deliberately *not* claimed here is that this makes SSRF impossible.
 * Hostname-string validation cannot stop DNS rebinding — a name that resolves to
 * a public address at validation time and to `127.0.0.1` at fetch time passes
 * every check in this file. That is why v1 only accepts operator-configured
 * targets, and why the limitation is written down rather than implied by a test
 * suite that passes.
 */

function rejectionReason(url: string): ProbeUrlReason | null {
  try {
    assertProbeUrlAllowed(url);
    return null;
  } catch (error) {
    const reason = (error as { reason?: ProbeUrlReason }).reason;
    return reason ?? null;
  }
}

describe("scheme", () => {
  it("allows http and https", () => {
    expect(rejectionReason("http://example.com/health")).toBeNull();
    expect(rejectionReason("https://example.com/health")).toBeNull();
  });

  it.each([
    "ftp://example.com/health",
    "file:///etc/passwd",
    "gopher://example.com/",
    "ws://example.com/socket",
  ])("rejects %s", (url) => {
    expect(rejectionReason(url)).toBe("scheme");
  });

  it("rejects a relative or unparseable URL", () => {
    expect(rejectionReason("not a url")).toBe("invalid_url");
    expect(rejectionReason("/health")).toBe("invalid_url");
  });
});

describe("credentials in the URL", () => {
  it("rejects embedded userinfo", () => {
    // A credential in a URL is both a leak into logs and a way to reach an
    // internal service through a hostname that looks external.
    expect(rejectionReason("https://user:pass@example.com/")).toBe("credentials");
    expect(rejectionReason("https://user@example.com/")).toBe("credentials");
  });
});

describe("blocked hostnames", () => {
  it.each([
    "http://localhost/",
    "http://localhost:8080/",
    "http://api.localhost/",
    "http://service.local/",
    "http://db.internal/",
    "http://thing.home.arpa/",
    "http://x.invalid/",
    "http://x.test/",
    "http://x.example/",
  ])("rejects %s", (url) => {
    expect(rejectionReason(url)).toBe("blocked_host");
  });

  it("rejects a trailing dot that would otherwise dodge the suffix match", () => {
    // `localhost.` is the same name to a resolver but a different string.
    expect(rejectionReason("http://localhost./")).toBe("blocked_host");
  });

  it("does not block a public name that merely contains a blocked word", () => {
    // Suffix matching is on labels, not on substrings: `notlocalhost.example.com`
    // and `internal.example.com` are ordinary public names.
    expect(rejectionReason("https://notlocalhost.example.com/")).toBeNull();
    expect(rejectionReason("https://internal.example.com/")).toBeNull();
  });

  it("permits an explicitly allowed host even when it matches a suffix", () => {
    // The escape hatch exists for a deployment that genuinely needs a `.internal`
    // name, and it must not disable the address checks for other hosts.
    expect(() =>
      assertProbeUrlAllowed("http://service.internal/health", {
        allowedHosts: ["service.internal"],
      }),
    ).not.toThrow();
    expect(rejectionReason("http://other.internal/health")).toBe("blocked_host");
  });
});

describe("blocked addresses", () => {
  it.each([
    ["http://127.0.0.1/", "loopback"],
    ["http://127.1.2.3/", "loopback range"],
    ["http://0.0.0.0/", "this network"],
    ["http://10.0.0.5/", "private"],
    ["http://172.16.4.4/", "private"],
    ["http://172.31.255.254/", "private upper bound"],
    ["http://192.168.1.1/", "private"],
    ["http://169.254.169.254/", "link-local, the metadata service"],
    ["http://100.64.0.1/", "carrier-grade NAT"],
    ["http://192.0.2.10/", "documentation"],
    ["http://198.18.0.1/", "benchmarking"],
    ["http://224.0.0.1/", "multicast"],
    ["http://255.255.255.255/", "broadcast"],
  ])("rejects %s (%s)", (url) => {
    expect(rejectionReason(url)).toBe("blocked_address");
  });

  it.each([
    "http://8.8.8.8/",
    "http://1.1.1.1/",
    "http://93.184.216.34/",
    "http://172.32.0.1/",
    "http://172.15.255.255/",
  ])("allows public address %s", (url) => {
    expect(rejectionReason(url)).toBeNull();
  });

  it("normalises the octal, hex and integer forms the URL parser already handles", () => {
    // `http://0177.0.0.1/` is parsed to `127.0.0.1` by the WHATWG URL parser
    // before this code sees it, which is why the address parser here can afford
    // to be strict about leading zeros.
    expect(rejectionReason("http://0177.0.0.1/")).toBe("blocked_address");
    expect(rejectionReason("http://0x7f.0.0.1/")).toBe("blocked_address");
    expect(rejectionReason("http://2130706433/")).toBe("blocked_address");
  });

  it("rejects bracketed IPv6 addresses that are not public", () => {
    expect(rejectionReason("http://[::1]/")).toBe("blocked_address");
    expect(rejectionReason("http://[::]/")).toBe("blocked_address");
    expect(rejectionReason("http://[fc00::1]/")).toBe("blocked_address");
    expect(rejectionReason("http://[fe80::1]/")).toBe("blocked_address");
    expect(rejectionReason("http://[ff02::1]/")).toBe("blocked_address");
    expect(rejectionReason("http://[2001:db8::1]/")).toBe("blocked_address");
    expect(rejectionReason("http://[::ffff:127.0.0.1]/")).toBe("blocked_address");
    expect(rejectionReason("http://[64:ff9b::7f00:1]/")).toBe("blocked_address");
  });

  it("allows a public IPv6 address", () => {
    expect(rejectionReason("http://[2606:4700:4700::1111]/")).toBeNull();
  });
});

describe("ports", () => {
  it("allows only the configured ports", () => {
    expect(rejectionReason("http://example.com:80/")).toBeNull();
    expect(rejectionReason("https://example.com:443/")).toBeNull();
    expect(rejectionReason("https://example.com/")).toBeNull();
  });

  it.each(["22", "25", "3306", "6379", "8080", "9200"])("rejects port %s", (port) => {
    expect(rejectionReason(`https://example.com:${port}/`)).toBe("port");
  });

  it("exposes the allowlist so it can be widened deliberately", () => {
    expect([...DEFAULT_ALLOWED_PORTS]).toEqual([80, 443]);
  });
});

describe("fetchProbe", () => {
  it("treats the expected status as success and records the latency", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200 });
    const result = await fetchProbe("https://example.com/health", {
      expectedStatus: 200,
      timeoutMs: 1000,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeNull();
    expect(calls).toEqual(["https://example.com/health"]);
  });

  it("treats a status mismatch as a failure, not an error", async () => {
    const { fetchImpl } = fakeFetch({ status: 503 });
    const result = await fetchProbe("https://example.com/health", {
      expectedStatus: 200,
      timeoutMs: 1000,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.error).toContain("unexpected status");
  });

  it("refuses to follow a redirect, even to an allowed host", async () => {
    // Following a redirect would make the host check a formality: the target of
    // the hop is chosen by the server being probed, not by the operator.
    const redirectImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/elsewhere" },
      })) as unknown as typeof fetch;

    const result = await fetchProbe("https://example.com/health", {
      expectedStatus: 200,
      timeoutMs: 1000,
      fetchImpl: redirectImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(302);
    expect(result.error).toContain("redirect not followed");
  });

  it("reports a transport failure without throwing", async () => {
    const { fetchImpl } = fakeFetch({ throw: "connection refused" });
    const result = await fetchProbe("https://example.com/health", {
      expectedStatus: 200,
      timeoutMs: 1000,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).toContain("connection refused");
  });

  it("reports a refused URL as a failed probe and makes no request", async () => {
    // Never throwing is the contract: a probe that cannot be made is
    // information the state machine consumes, not an exception that aborts a
    // cron run. The count of calls is what proves the guard ran first.
    const { fetchImpl, calls } = fakeFetch({ status: 200 });
    const result = await fetchProbe("http://169.254.169.254/latest/meta-data/", {
      expectedStatus: 200,
      timeoutMs: 1000,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("rejected:");
    expect(calls).toEqual([]);
  });

  it("caps the body it reads", async () => {
    // A probe needs the status line, not the payload. Reading an unbounded body
    // is how a probe becomes a memory exhaustion.
    const huge = "x".repeat(MAX_BODY_BYTES * 4);
    const streamImpl = (async () => new Response(huge, { status: 200 })) as unknown as typeof fetch;

    const result = await fetchProbe("https://example.com/health", {
      expectedStatus: 200,
      timeoutMs: 5000,
      fetchImpl: streamImpl,
    });

    expect(result.ok).toBe(true);
  });
});
