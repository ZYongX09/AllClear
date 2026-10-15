import { describe, expect, it } from "vitest";

import { buildAtomFeed, escapeXml } from "../src/feed";
import type { Snapshot, SnapshotChange } from "../src/snapshot";

/**
 * The Atom feed.
 *
 * Two properties matter more than the rest, and both are about what a *reader*
 * does with the document:
 *
 *   * **`updated` is never `now`.** Feed clients decide whether anything is new
 *     by comparing timestamps. A feed that reports the time it was generated as
 *     its `updated` teaches every reader to fetch and discard, and the moment
 *     they stop trusting the field is the moment the feed stops working.
 *   * **Operator text is escaped everywhere.** A title is arbitrary text typed
 *     into an admin form. One unescaped `&` makes the document unparseable and
 *     the failure surfaces as "the feed is broken", not as "that incident title
 *     was odd".
 *
 * The escaping tests are exhaustive on purpose: they check every interpolated
 * field rather than one representative, because the risk is a field being added
 * later without escaping and only one of them being spot-checked today.
 *
 * These are the pure-function tests; they run here rather than in `apps/api`
 * because the builder lives in this package and both Workers call it. The tests
 * that go through the API Worker's route are in `apps/api/test/feed.test.ts`.
 */

const T0 = 1_700_000_000;
const SELF = "https://status.test/api/status/example/feed.xml";
const STATUS = "https://status.test/status/example";

function change(overrides: Partial<SnapshotChange> = {}): SnapshotChange {
  return {
    publicId: "chg-000001",
    kind: "incident",
    status: "in_progress",
    title: "Elevated errors",
    body: null,
    severity: "partial_outage",
    startsAt: T0 - 600,
    endsAt: null,
    scheduledStartAt: null,
    scheduledEndAt: null,
    componentPublicIds: [],
    updates: [],
    ...overrides,
  };
}

function snapshotWith(changes: SnapshotChange[], overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    slug: "example",
    name: "Example Status",
    snapshotVersion: 1,
    generatedAt: T0,
    sourceUpdatedAt: T0,
    sections: [],
    components: [],
    changes,
    ...overrides,
  };
}

/** The value of the feed-level element, as a string. */
function element(body: string, name: string): string {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return match?.[1] ?? "";
}

describe("buildAtomFeed", () => {
  it("produces a document a strict parser accepts", () => {
    const body = buildAtomFeed(snapshotWith([change()]), { selfUrl: SELF, statusUrl: STATUS });

    expect(body.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(body).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(body.trimEnd().endsWith("</feed>")).toBe(true);
    // A feed fetched with `curl` should not end mid-line.
    expect(body.endsWith("\n")).toBe(true);
    expect(element(body, "title")).toBe("Example Status");
    expect(body).toContain('<link rel="self" type="application/atom+xml"');
    expect(body).toContain('<link rel="alternate" type="text/html"');
    expect(element(body, "id")).toBe("urn:allclear:feed:example");
  });

  it("escapes the title, the body and the timeline text", () => {
    // Every interpolated operator string, in one document, so that a field
    // added without escaping shows up here rather than in someone's reader.
    const body = buildAtomFeed(
      snapshotWith([
        change({
          title: `Bad & <worse> "quoted" 'apostrophe'`,
          body: "Errors at 100% & rising <see chart>",
          updates: [
            {
              publicId: "upd-1",
              status: "verifying",
              body: "Fixed & deployed <maybe>",
              createdAt: T0 - 120,
              componentPublicIds: [],
            },
          ],
        }),
      ]),
      { selfUrl: SELF, statusUrl: STATUS },
    );

    // No raw angle bracket survives from any of the three.
    expect(body).not.toContain("<worse>");
    expect(body).not.toContain("<see chart>");
    expect(body).not.toContain("<maybe>");
    expect(body).toContain("Bad &amp; &lt;worse&gt; &quot;quoted&quot; &apos;apostrophe&apos;");
    expect(body).toContain("Errors at 100% &amp; rising &lt;see chart&gt;");
    expect(body).toContain("Fixed &amp; deployed &lt;maybe&gt;");
  });

  it("escapes the URLs it is given as well", () => {
    // The origins are configuration, not operator input, but they are
    // interpolated the same way as everything else — uniformly, so that no field
    // can be added later without escaping.
    const body = buildAtomFeed(snapshotWith([]), {
      selfUrl: "https://status.test/f.xml?a=1&b=2",
      statusUrl: "https://status.test/s?a=1&b=2",
    });
    expect(body).toContain("https://status.test/f.xml?a=1&amp;b=2");
    expect(body).toContain("https://status.test/s?a=1&amp;b=2");
    expect(body).not.toContain("?a=1&b=2");
  });

  it("declares its content as text, not html", () => {
    // `type="html"` would invite a reader to render operator text as markup,
    // which is the one thing the escaping exists to prevent.
    const body = buildAtomFeed(snapshotWith([change()]), { selfUrl: SELF, statusUrl: STATUS });
    expect(body).toContain('<content type="text">');
    expect(body).not.toContain('type="html"');
  });

  it("gives every entry a stable id and a link back to the page", () => {
    const body = buildAtomFeed(
      snapshotWith([change({ publicId: "chg-abcdef" })]),
      { selfUrl: SELF, statusUrl: STATUS },
    );
    expect(body).toContain("<id>urn:allclear:change:chg-abcdef</id>");
    expect(body).toContain(`href="${STATUS}"`);
  });

  it("takes the entry's updated from the newest timeline entry, not from the clock", () => {
    const body = buildAtomFeed(
      snapshotWith([
        change({
          startsAt: T0 - 3600,
          updates: [
            { publicId: "u1", status: "in_progress", body: "looking", createdAt: T0 - 3000, componentPublicIds: [] },
            { publicId: "u2", status: "verifying", body: "fixed", createdAt: T0 - 60, componentPublicIds: [] },
          ],
        }),
      ]),
      { selfUrl: SELF, statusUrl: STATUS },
    );

    const entry = body.slice(body.indexOf("<entry>"));
    expect(element(entry, "updated")).toBe(new Date((T0 - 60) * 1000).toISOString().replace(".000Z", "Z"));
    // `published` is when the change opened, which is a different fact.
    expect(element(entry, "published")).toBe(
      new Date((T0 - 3600) * 1000).toISOString().replace(".000Z", "Z"),
    );
  });

  it("uses the resolution time when a change closed without a timeline entry", () => {
    const body = buildAtomFeed(
      snapshotWith([change({ startsAt: T0 - 3600, endsAt: T0 - 60, status: "resolved" })]),
      { selfUrl: SELF, statusUrl: STATUS },
    );
    const entry = body.slice(body.indexOf("<entry>"));
    expect(element(entry, "updated")).toBe(new Date((T0 - 60) * 1000).toISOString().replace(".000Z", "Z"));
  });

  it("never reports an `updated` later than its newest content", () => {
    // The feed's own `updated` is the newest of its entries or the moment the
    // document was produced — never `now`. Both directions are asserted, because
    // a fix that always took `generatedAt` would pass the first half alone.
    const entries = [change({ startsAt: T0 - 3600, updates: [] })];

    const olderGeneration = buildAtomFeed(snapshotWith(entries, { generatedAt: T0 - 10 * 3600 }), {
      selfUrl: SELF,
      statusUrl: STATUS,
    });
    // The entry is newer than the document's generation time.
    expect(element(olderGeneration, "updated")).toBe(
      new Date((T0 - 3600) * 1000).toISOString().replace(".000Z", "Z"),
    );

    const newerGeneration = buildAtomFeed(snapshotWith(entries, { generatedAt: T0 }), {
      selfUrl: SELF,
      statusUrl: STATUS,
    });
    expect(element(newerGeneration, "updated")).toBe(
      new Date(T0 * 1000).toISOString().replace(".000Z", "Z"),
    );
  });

  it("emits one entry per change, with the whole timeline inside it", () => {
    // One entry per update would push a dozen near-identical items into a
    // reader during a long incident, each saying "still working on it".
    const body = buildAtomFeed(
      snapshotWith([
        change({
          updates: [
            { publicId: "u1", status: "in_progress", body: "first", createdAt: T0 - 900, componentPublicIds: [] },
            { publicId: "u2", status: "in_progress", body: "second", createdAt: T0 - 600, componentPublicIds: [] },
            { publicId: "u3", status: "verifying", body: "third", createdAt: T0 - 300, componentPublicIds: [] },
          ],
        }),
      ]),
      { selfUrl: SELF, statusUrl: STATUS },
    );

    expect(body.match(/<entry>/g)).toHaveLength(1);
    for (const text of ["first", "second", "third"]) expect(body).toContain(text);
  });

  it("orders entries newest first and caps the count", () => {
    const changes = [
      change({ publicId: "old", startsAt: T0 - 3000 }),
      change({ publicId: "newest", startsAt: T0 - 10 }),
      change({ publicId: "middle", startsAt: T0 - 1000 }),
    ];

    const capped = buildAtomFeed(snapshotWith(changes), {
      selfUrl: SELF,
      statusUrl: STATUS,
      maxEntries: 2,
    });
    expect(capped.match(/<entry>/g)).toHaveLength(2);
    expect(capped.indexOf("urn:allclear:change:newest")).toBeLessThan(
      capped.indexOf("urn:allclear:change:middle"),
    );
    expect(capped).not.toContain("urn:allclear:change:old");

    const all = buildAtomFeed(snapshotWith(changes), { selfUrl: SELF, statusUrl: STATUS });
    const order = ["newest", "middle", "old"].map((id) => all.indexOf(`urn:allclear:change:${id}`));
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
  });

  it("categorises a change by kind, status and severity", () => {
    const body = buildAtomFeed(
      snapshotWith([
        change({ kind: "maintenance", status: "in_progress", severity: "none" }),
      ]),
      { selfUrl: SELF, statusUrl: STATUS },
    );

    expect(body).toContain('<category term="maintenance"/>');
    expect(body).toContain('<category term="in_progress"/>');
    // A change with no severity must not claim one. `term="none"` would be a
    // category a reader could filter on and find meaningless.
    expect(body).not.toContain('term="none"');
  });

  it("is still valid with no changes at all", () => {
    const body = buildAtomFeed(snapshotWith([], { generatedAt: T0 - 500 }), {
      selfUrl: SELF,
      statusUrl: STATUS,
    });
    expect(body.match(/<entry>/g)).toBeNull();
    expect(element(body, "updated")).toBe(
      new Date((T0 - 500) * 1000).toISOString().replace(".000Z", "Z"),
    );
  });
});

describe("escapeXml", () => {
  it("escapes the five predefined entities", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("strips the control characters XML forbids outright", () => {
    // There is no escape for these, so a stray 0x0B pasted into an incident body
    // would make the whole feed unparseable. Stripping is the only option.
    expect(escapeXml("a\u0000b\u0008c\u000Bd\u000Ce\u001Ff")).toBe("abcdef");
  });

  it("keeps the whitespace XML allows", () => {
    expect(escapeXml("line one\nline two\tindented\r\n")).toBe("line one\nline two\tindented\r\n");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeXml("Everything is fine — 100% up")).toBe("Everything is fine — 100% up");
  });
});
