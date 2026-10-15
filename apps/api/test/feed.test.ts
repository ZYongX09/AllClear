import { describe, expect, it } from "vitest";

import { buildSnapshot, writeSnapshot } from "../src/snapshot";
import { testEnv as env } from "./env";
import { callApi, createChange, createChangeUpdate, createPage, T0 } from "./helpers";

/**
 * The Atom feed as the API Worker serves it.
 *
 * The document itself is built by `buildAtomFeed` in `packages/shared`, and its
 * behaviour is tested there (`packages/shared/test/feed.test.ts`) — including
 * every escaping case, because escaping is a property of the builder and not of
 * this route. What is left for this file is the part only the Worker can show:
 * which document the route hands out, with which headers, and what it does when
 * it has nothing to serve.
 */

describe("GET /api/status/:slug/feed.xml", () => {
  it("serves the change the snapshot carries, escaped", async () => {
    const page = await createPage("Example Status");
    const change = await createChange(page.id, {
      title: "Latency & <errors>",
      body: "We are looking into it.",
      startsAt: T0 - 600,
    });
    await createChangeUpdate(change.id, { status: "verifying", body: "Mitigated", createdAt: T0 - 60 });

    await writeSnapshot(env.SNAPSHOT_KV, await buildSnapshot(env.DB, page.slug, { now: T0 }));

    const response = await callApi(`/api/status/${page.slug}/feed.xml`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/atom+xml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");

    const body = await response.text();
    expect(body).toContain("&lt;errors&gt;");
    expect(body).not.toContain("<errors>");
    expect(body).toContain("We are looking into it.");
    expect(body).toContain("Mitigated");
    expect(body).toContain(`urn:allclear:change:${change.publicId}`);
    // The self link is built from the configured origin, not the request host,
    // so a feed served through a proxy still points at the canonical URL.
    expect(body).toContain("https://status.test/api/status/");
  });

  it("answers 503 rather than an empty feed when there is nothing to serve", async () => {
    // An empty feed and an unavailable feed are different facts. A reader that
    // receives a valid document with no entries concludes "nothing has happened";
    // it must not be told that when the truth is "we could not read the data".
    const response = await callApi("/api/status/no-such-page/feed.xml");
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toContain("status feed unavailable");
  });
});
