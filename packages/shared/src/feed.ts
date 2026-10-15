/**
 * Atom 1.0 feed for a status page.
 *
 * This lives in `packages/shared` rather than in the API Worker because *two*
 * workers publish the same feed. `allclear-api` serves it at
 * `/api/status/:slug/feed.xml`, and the status site serves it at
 * `/status/:slug/feed.xml` so subscribers get a URL on the domain they are
 * already reading. The document is a pure function of the snapshot plus two
 * URLs, so it is shared rather than duplicated — and, importantly, both routes
 * take their entries from the same `Snapshot` the page renders, so the feed and
 * the page cannot disagree about what happened.
 *
 * Atom rather than RSS 2.0 for one concrete reason: RFC 4287 requires every
 * entry to carry a stable `id` and an `updated` timestamp, and RSS 2.0 does not.
 * A status feed is consumed by clients that decide what is new by comparing ids
 * and timestamps, so the format that mandates both is the one that behaves
 * predictably when entries are edited.
 *
 * ## One entry per change, not per timeline update
 *
 * A change's timeline can grow to a dozen updates during a long incident.
 * Emitting one entry per update would push a dozen near-duplicate items into a
 * reader, each saying "still working on it". The entry is the change, its
 * `updated` is the newest update's timestamp, and the update bodies are carried
 * in the entry content so nothing is lost.
 *
 * ## Everything is escaped, including the "safe" fields
 *
 * Titles and bodies are operator-supplied text. XML has no notion of a safe
 * field, so every interpolated value goes through `escapeXml`. The `id` values
 * are ULIDs and the URLs are built from the configured origin, but they are
 * escaped too: the escaping is applied uniformly so that a future field cannot
 * be added without it by accident.
 */

import type { Snapshot, SnapshotChange } from "./snapshot";

export interface FeedOptions {
  /** Absolute URL of the feed itself, for `rel="self"`. */
  selfUrl: string;
  /** Absolute URL of the human-readable status page. */
  statusUrl: string;
  /** How many changes to include. Newest first. */
  maxEntries?: number;
}

export const DEFAULT_MAX_ENTRIES = 50;

export function buildAtomFeed(snapshot: Snapshot, options: FeedOptions): string {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const ordered = [...snapshot.changes].sort(
    (a, b) => changeTimestamp(b) - changeTimestamp(a),
  );
  const entries = ordered.slice(0, maxEntries);

  // The feed's own `updated` must be the newest of its entries, or the time the
  // document was produced — never `now`. Claiming the feed changed at a time
  // nothing changed teaches readers to ignore it.
  const newestEntry = entries.reduce((max, change) => Math.max(max, changeTimestamp(change)), 0);
  const feedUpdated = Math.max(newestEntry, snapshot.generatedAt);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push('<feed xmlns="http://www.w3.org/2005/Atom">');
  lines.push(`  <title>${escapeXml(snapshot.name)}</title>`);
  lines.push(`  <id>${escapeXml(feedId(snapshot.slug))}</id>`);
  lines.push(`  <updated>${rfc3339(feedUpdated)}</updated>`);
  lines.push(`  <link rel="alternate" type="text/html" href="${escapeXml(options.statusUrl)}"/>`);
  lines.push(`  <link rel="self" type="application/atom+xml" href="${escapeXml(options.selfUrl)}"/>`);
  lines.push(`  <generator>allclear</generator>`);

  for (const change of entries) {
    lines.push(...renderEntry(change, options.statusUrl));
  }

  lines.push("</feed>");
  // Trailing newline: a feed fetched with `curl` should not end mid-line.
  return `${lines.join("\n")}\n`;
}

function renderEntry(change: SnapshotChange, statusUrl: string): string[] {
  const updated = changeTimestamp(change);
  const lines: string[] = [];
  lines.push("  <entry>");
  lines.push(`    <title>${escapeXml(change.title)}</title>`);
  lines.push(`    <id>${escapeXml(entryId(change.publicId))}</id>`);
  lines.push(`    <updated>${rfc3339(updated)}</updated>`);
  lines.push(`    <published>${rfc3339(change.startsAt)}</published>`);
  lines.push(`    <link rel="alternate" type="text/html" href="${escapeXml(statusUrl)}"/>`);
  lines.push(`    <category term="${escapeXml(change.kind)}"/>`);
  lines.push(`    <category term="${escapeXml(change.status)}"/>`);
  if (change.severity !== "none") {
    lines.push(`    <category term="${escapeXml(change.severity)}"/>`);
  }
  // `type="text"` because the content is plain text that has been escaped, not
  // markup. Declaring `html` here would invite a reader to render operator text
  // as markup.
  lines.push(`    <content type="text">${escapeXml(entryBody(change))}</content>`);
  lines.push("  </entry>");
  return lines;
}

/**
 * The newest moment this change was touched: its last timeline update, or its
 * start if there are none, or its end if it closed without an update.
 */
function changeTimestamp(change: SnapshotChange): number {
  let newest = change.startsAt;
  for (const update of change.updates) {
    if (update.createdAt > newest) newest = update.createdAt;
  }
  if (change.endsAt !== null && change.endsAt > newest) newest = change.endsAt;
  return newest;
}

function entryBody(change: SnapshotChange): string {
  const parts: string[] = [];
  parts.push(`Status: ${change.status}`);
  if (change.body) {
    parts.push("");
    parts.push(change.body);
  }
  for (const update of change.updates) {
    parts.push("");
    parts.push(`--- ${new Date(update.createdAt * 1000).toISOString()} (${update.status})`);
    parts.push(update.body);
  }
  return parts.join("\n");
}

function feedId(slug: string): string {
  return `urn:allclear:feed:${slug}`;
}

function entryId(changePublicId: string): string {
  return `urn:allclear:change:${changePublicId}`;
}

/** RFC 3339, second precision, always UTC. */
function rfc3339(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * XML text escaping.
 *
 * The control characters that XML 1.0 forbids outright are stripped rather than
 * escaped, because there is no escape for them — a stray 0x0B pasted into an
 * incident body would otherwise make the whole feed unparseable.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
