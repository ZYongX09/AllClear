/**
 * A stand-in for the API's `/internal/admin/*` surface, for driving the console
 * without a database.
 *
 * ## Why this exists
 *
 * The console's whole job is to perform writes. A fixture that only served reads
 * would let every form render and prove nothing: the interesting failures — a
 * write that never reaches the API, a field the action forgets to send, a form
 * that does not reflect what it just saved — are all invisible without a server
 * that actually changes state.
 *
 * So this store is mutable. A write applied here is visible on the next read, the
 * same way the real one would be.
 *
 * ## What it is not
 *
 * It is not a second implementation. It has no validation beyond what the console
 * needs to be exercised, no audit log, no snapshot rebuild, and no persistence —
 * the store lives in the isolate's memory and is lost when the dev server
 * restarts. Its validation is deliberately limited to the two cases the console
 * has a visible reaction to: a duplicate slug and a malformed one. Both exist so
 * the error path can be seen, not because they are the API's rules.
 *
 * It also does not check `X-Internal-Key` beyond its presence. The real check is
 * a value comparison against a secret, and the fixture has no secret to compare
 * against; asserting presence at least catches the failure that matters here,
 * which is an action that forgets to send the header at all.
 */

import type { AdminPageDetail, AdminPageSummary } from "../lib/admin-api";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface Store {
  pages: Array<{
    id: number;
    public_id: string;
    slug: string;
    name: string;
    snapshot_version: number;
    updated_at: number;
  }>;
  sections: Array<{
    id: number;
    public_id: string;
    page_id: number;
    name: string;
    description: string | null;
    order_id: number;
  }>;
  components: Array<{
    id: number;
    public_id: string;
    page_id: number;
    section_id: number | null;
    name: string;
    description: string | null;
    order_id: number;
    available_since: number;
  }>;
  probes: Array<{
    id: number;
    public_id: string;
    component_id: number;
    url: string;
    method: string;
    severity: string;
    expected_status: number;
    timeout_ms: number;
    interval_seconds: number;
    failure_threshold: number;
    recovery_threshold: number;
    enabled: number;
    next_check_at: number;
    consecutive_failures: number | null;
    consecutive_successes: number | null;
    transition_seq: number | null;
    last_probe_at: number | null;
    open_impact_id: number | null;
  }>;
  changes: Array<{
    id: number;
    public_id: string;
    page_id: number;
    kind: string;
    status: string;
    title: string;
    body: string | null;
    severity: string;
    starts_at: number;
    ends_at: number | null;
    scheduled_start_at: number | null;
    scheduled_end_at: number | null;
  }>;
  impacts: Array<{
    id: number;
    public_id: string;
    component_id: number;
    severity: string;
    start_at: number;
    end_at: number | null;
    estimated: number;
  }>;
  quotaSent: number;
  nextId: number;
}

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

/**
 * Seeded with the same component public ids the public fixture uses
 * (`cmp-api`, `cmp-web`, `cmp-mobile`, `cmp-downloads`).
 *
 * That is not a coincidence and not decoration: the console's "what visitors
 * see" panel calls the *public* endpoint and joins the result to these rows by
 * public id. If the two fixtures disagreed about an id, the panel would report
 * every component as missing from the snapshot and the console would look broken
 * for a reason that does not exist in production.
 */
function seed(): Store {
  const pageId = 1;
  return {
    pages: [
      {
        id: pageId,
        public_id: "pag-fixture",
        slug: "fixture",
        name: "Fixture Service",
        snapshot_version: 42,
        updated_at: NOW - 600,
      },
    ],
    sections: [
      {
        id: 1,
        public_id: "sec-1",
        page_id: pageId,
        name: "Public surface",
        description: "Everything a visitor talks to directly.",
        order_id: 1,
      },
    ],
    components: [
      { public_id: "cmp-api", name: "API", section_id: 1, order: 1 },
      { public_id: "cmp-web", name: "Website", section_id: 1, order: 2 },
      { public_id: "cmp-mobile", name: "Mobile web", section_id: null, order: 3 },
      { public_id: "cmp-downloads", name: "Download server", section_id: null, order: 4 },
    ].map((spec, index) => ({
      id: index + 1,
      public_id: spec.public_id,
      page_id: pageId,
      section_id: spec.section_id as number | null,
      name: spec.name,
      description: null,
      order_id: spec.order,
      available_since: NOW - 300 * DAY,
    })),
    probes: [
      {
        id: 1,
        public_id: "prb-1",
        component_id: 1,
        url: "https://api.example.test/health",
        method: "GET",
        severity: "partial_outage",
        expected_status: 200,
        timeout_ms: 10_000,
        interval_seconds: 60,
        failure_threshold: 3,
        recovery_threshold: 2,
        enabled: 1,
        next_check_at: NOW + 20,
        consecutive_failures: 0,
        consecutive_successes: 7,
        transition_seq: 3,
        last_probe_at: NOW - 45,
        open_impact_id: null,
      },
      {
        id: 2,
        public_id: "prb-2",
        component_id: 2,
        url: "https://www.example.test/",
        method: "GET",
        severity: "full_outage",
        expected_status: 200,
        timeout_ms: 10_000,
        interval_seconds: 60,
        failure_threshold: 3,
        recovery_threshold: 2,
        enabled: 1,
        next_check_at: NOW + 20,
        consecutive_failures: 4,
        consecutive_successes: 0,
        transition_seq: 9,
        last_probe_at: NOW - 20,
        open_impact_id: 1,
      },
      {
        id: 3,
        public_id: "prb-4",
        component_id: 4,
        url: "https://dl.example.test/health",
        method: "HEAD",
        severity: "degraded_performance",
        expected_status: 200,
        timeout_ms: 5_000,
        interval_seconds: 300,
        failure_threshold: 3,
        recovery_threshold: 2,
        enabled: 0,
        next_check_at: NOW - 100,
        consecutive_failures: 0,
        consecutive_successes: 1,
        transition_seq: 1,
        last_probe_at: NOW - 900,
        open_impact_id: null,
      },
    ],
    changes: [
      {
        id: 1,
        public_id: "chg-1",
        page_id: pageId,
        kind: "incident",
        status: "in_progress",
        title: "Website returning 502 for some visitors",
        body: null,
        severity: "full_outage",
        starts_at: NOW - 3_600,
        ends_at: null,
        scheduled_start_at: null,
        scheduled_end_at: null,
      },
      {
        id: 2,
        public_id: "chg-2",
        page_id: pageId,
        kind: "maintenance",
        status: "scheduled",
        title: "Scheduled storage migration",
        body: null,
        severity: "none",
        starts_at: NOW + 4 * 3_600,
        ends_at: NOW + 6 * 3_600,
        scheduled_start_at: NOW + 4 * 3_600,
        scheduled_end_at: NOW + 6 * 3_600,
      },
    ],
    impacts: [
      {
        id: 1,
        public_id: "imp-manual-1",
        component_id: 3,
        severity: "degraded_performance",
        start_at: NOW - 2 * DAY,
        end_at: NOW - 2 * DAY + 3_600,
        estimated: 0,
      },
      {
        id: 2,
        public_id: "imp-manual-2",
        component_id: 4,
        severity: "partial_outage",
        start_at: NOW - 5 * 3_600,
        end_at: null,
        estimated: 0,
      },
    ],
    quotaSent: 12,
    nextId: 100,
  };
}

// Module scope, so a write survives the next request. Reset by restarting the
// dev server, which is the only reset this fixture offers.
let store: Store | null = null;
function getStore(): Store {
  store ??= seed();
  return store;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function fail(error: string, field: string | null = null, status = 400): Response {
  return json({ ok: false, error, field }, status);
}

function newPublicId(prefix: string, store: Store): string {
  store.nextId += 1;
  return `${prefix}-${store.nextId}`;
}

/** Bump the version on every write, the way `publishSnapshot` would. */
function touch(store: Store, pageId: number): void {
  const page = store.pages.find((p) => p.id === pageId);
  if (!page) return;
  page.snapshot_version += 1;
  page.updated_at = Math.floor(Date.now() / 1000);
}

function summary(store: Store, page: Store["pages"][number]): AdminPageSummary {
  const components = store.components.filter((c) => c.page_id === page.id);
  const componentIds = new Set(components.map((c) => c.id));
  const now = Math.floor(Date.now() / 1000);
  return {
    public_id: page.public_id,
    slug: page.slug,
    name: page.name,
    snapshot_version: page.snapshot_version,
    updated_at: page.updated_at,
    section_count: store.sections.filter((s) => s.page_id === page.id).length,
    component_count: components.length,
    enabled_probe_count: store.probes.filter((p) => componentIds.has(p.component_id) && p.enabled === 1)
      .length,
    open_change_count: store.changes.filter(
      (c) => c.page_id === page.id && (c.ends_at === null || c.ends_at >= now),
    ).length,
  };
}

function detail(store: Store, page: Store["pages"][number]): AdminPageDetail {
  const sections = store.sections.filter((s) => s.page_id === page.id);
  const sectionIds = new Set(sections.map((s) => s.id));
  const components = store.components.filter((c) => c.page_id === page.id);
  const componentIds = new Set(components.map((c) => c.id));

  return {
    page: summary(store, page),
    sections: sections
      .sort((a, b) => a.order_id - b.order_id)
      .map(({ public_id, name, description, order_id }) => ({ public_id, name, description, order_id })),
    components: components
      .sort((a, b) => a.order_id - b.order_id)
      .map((c) => ({
        public_id: c.public_id,
        name: c.name,
        description: c.description,
        order_id: c.order_id,
        available_since: c.available_since,
        section_public_id:
          c.section_id === null || !sectionIds.has(c.section_id)
            ? null
            : (sections.find((s) => s.id === c.section_id)?.public_id ?? null),
      })),
    probes: store.probes
      .filter((p) => componentIds.has(p.component_id))
      .map((p) => ({
        public_id: p.public_id,
        url: p.url,
        method: p.method,
        severity: p.severity,
        expected_status: p.expected_status,
        timeout_ms: p.timeout_ms,
        interval_seconds: p.interval_seconds,
        failure_threshold: p.failure_threshold,
        recovery_threshold: p.recovery_threshold,
        enabled: p.enabled,
        next_check_at: p.next_check_at,
        component_public_id:
          components.find((c) => c.id === p.component_id)?.public_id ?? "unknown",
        consecutive_failures: p.consecutive_failures,
        consecutive_successes: p.consecutive_successes,
        transition_seq: p.transition_seq,
        last_probe_at: p.last_probe_at,
        open_impact_id: p.open_impact_id,
      })),
    changes: store.changes
      .filter((c) => c.page_id === page.id)
      .sort((a, b) => b.starts_at - a.starts_at)
      .map((c) => ({
        public_id: c.public_id,
        kind: c.kind,
        status: c.status,
        title: c.title,
        severity: c.severity,
        starts_at: c.starts_at,
        ends_at: c.ends_at,
        scheduled_start_at: c.scheduled_start_at,
        scheduled_end_at: c.scheduled_end_at,
      })),
    // Hand-entered impacts only, matching the API's `probe_target_id IS NULL`.
    impacts: store.impacts
      .filter((i) => componentIds.has(i.component_id))
      .sort((a, b) => b.start_at - a.start_at)
      .map((i) => ({
        public_id: i.public_id,
        severity: i.severity,
        start_at: i.start_at,
        end_at: i.end_at,
        estimated: i.estimated,
        component_public_id: components.find((c) => c.id === i.component_id)?.public_id ?? "unknown",
      })),
  };
}

/**
 * Handle a `/internal/admin/*` request, or return `null` if the path is not one.
 *
 * Returning `null` rather than a 404 keeps the routing decision in one place:
 * `api-stub.ts` asks this module first and falls through to its own public
 * routes, so adding a route here cannot shadow a public one by accident.
 */
export async function handleAdminRequest(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/internal/admin")) return null;

  // Presence only. See the header for why the value is not compared.
  if (!request.headers.get("X-Internal-Key")) {
    return fail("unauthorized", null, 401);
  }

  const store = getStore();
  const method = request.method;
  const path = pathname.slice("/internal/admin".length);

  const body = async (): Promise<Record<string, unknown>> => {
    try {
      const parsed = await request.json();
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const str = (source: Record<string, unknown>, key: string): string | undefined => {
    const value = source[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const num = (source: Record<string, unknown>, key: string): number | undefined => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };

  // --- reads -------------------------------------------------------------

  if (method === "GET" && path === "/pages") {
    return json({ ok: true, pages: store.pages.map((page) => summary(store, page)) });
  }

  if (method === "GET" && path === "/email-quota") {
    const limit = 2000;
    const day = new Date().toISOString().slice(0, 10);
    return json({
      ok: true,
      day,
      sent: store.quotaSent,
      limit,
      remaining: Math.max(0, limit - store.quotaSent),
    });
  }

  const pageDetail = /^\/pages\/([^/]+)$/.exec(path);
  if (method === "GET" && pageDetail) {
    const slug = decodeURIComponent(pageDetail[1]!);
    const page = store.pages.find((p) => p.slug === slug);
    if (!page) return fail("page_not_found", null, 404);
    return json({ ok: true, ...detail(store, page) });
  }

  // --- pages -------------------------------------------------------------

  if (method === "POST" && path === "/pages") {
    const input = await body();
    const slug = str(input, "slug");
    const name = str(input, "name");
    if (slug === undefined) return fail("required", "slug");
    if (!SLUG_RE.test(slug)) return fail("invalid_slug", "slug");
    if (store.pages.some((p) => p.slug === slug)) return fail("duplicate_slug", "slug");
    if (name === undefined) return fail("required", "name");

    const now = Math.floor(Date.now() / 1000);
    const page = {
      id: store.nextId++,
      public_id: newPublicId("pag", store),
      slug,
      name,
      snapshot_version: 1,
      updated_at: now,
    };
    store.pages.push(page);
    return json({ ok: true, publicId: page.public_id, snapshotVersion: 1 }, 201);
  }

  const pagePatch = /^\/pages\/([^/]+)$/.exec(path);
  if (method === "PATCH" && pagePatch) {
    const slug = decodeURIComponent(pagePatch[1]!);
    const page = store.pages.find((p) => p.slug === slug);
    if (!page) return fail("page_not_found", null, 404);
    const input = await body();
    const name = str(input, "name");
    if (name === undefined) return fail("required", "name");
    page.name = name;
    touch(store, page.id);
    return json({ ok: true });
  }

  const rebuild = /^\/pages\/([^/]+)\/rebuild$/.exec(path);
  if (method === "POST" && rebuild) {
    const slug = decodeURIComponent(rebuild[1]!);
    const page = store.pages.find((p) => p.slug === slug);
    if (!page) return fail("page_not_found", null, 404);
    touch(store, page.id);
    return json({ ok: true, snapshotVersion: page.snapshot_version });
  }

  // --- sections ----------------------------------------------------------

  const createSection = /^\/pages\/([^/]+)\/sections$/.exec(path);
  if (method === "POST" && createSection) {
    const slug = decodeURIComponent(createSection[1]!);
    const page = store.pages.find((p) => p.slug === slug);
    if (!page) return fail("page_not_found", null, 404);
    const input = await body();
    const name = str(input, "name");
    if (name === undefined) return fail("required", "name");

    const section = {
      id: store.nextId++,
      public_id: newPublicId("sec", store),
      page_id: page.id,
      name,
      description: typeof input["description"] === "string" ? input["description"] : null,
      order_id: store.sections.filter((s) => s.page_id === page.id).length + 1,
    };
    store.sections.push(section);
    touch(store, page.id);
    return json({ ok: true, publicId: section.public_id }, 201);
  }

  const sectionById = /^\/sections\/([^/]+)$/.exec(path);
  if (sectionById && (method === "PATCH" || method === "DELETE")) {
    const publicId = decodeURIComponent(sectionById[1]!);
    const section = store.sections.find((s) => s.public_id === publicId);
    if (!section) return fail("no such section", "sectionPublicId");

    if (method === "DELETE") {
      store.sections = store.sections.filter((s) => s !== section);
      // Components survive, as they do in the real schema: `section_id` is
      // nullable and the FK is `ON DELETE SET NULL`.
      for (const component of store.components) {
        if (component.section_id === section.id) component.section_id = null;
      }
    } else {
      const input = await body();
      const name = str(input, "name");
      if (name === undefined) return fail("required", "name");
      section.name = name;
    }
    touch(store, section.page_id);
    return json({ ok: true });
  }

  // --- components --------------------------------------------------------

  const createComponent = /^\/pages\/([^/]+)\/components$/.exec(path);
  if (method === "POST" && createComponent) {
    const slug = decodeURIComponent(createComponent[1]!);
    const page = store.pages.find((p) => p.slug === slug);
    if (!page) return fail("page_not_found", null, 404);
    const input = await body();
    const name = str(input, "name");
    if (name === undefined) return fail("required", "name");

    const sectionPublicId = input["sectionPublicId"];
    const section =
      typeof sectionPublicId === "string" && sectionPublicId !== ""
        ? store.sections.find((s) => s.public_id === sectionPublicId)
        : undefined;
    if (typeof sectionPublicId === "string" && sectionPublicId !== "" && !section) {
      return fail("no such section", "sectionPublicId");
    }

    const component = {
      id: store.nextId++,
      public_id: newPublicId("cmp", store),
      page_id: page.id,
      section_id: section?.id ?? null,
      name,
      description: null,
      order_id: store.components.filter((c) => c.page_id === page.id).length + 1,
      available_since: Math.floor(Date.now() / 1000),
    };
    store.components.push(component);
    touch(store, page.id);
    return json({ ok: true, publicId: component.public_id }, 201);
  }

  const componentById = /^\/components\/([^/]+)$/.exec(path);
  if (componentById && (method === "PATCH" || method === "DELETE")) {
    const publicId = decodeURIComponent(componentById[1]!);
    const component = store.components.find((c) => c.public_id === publicId);
    if (!component) return fail("no such component", "componentPublicId");

    if (method === "DELETE") {
      store.components = store.components.filter((c) => c !== component);
      store.probes = store.probes.filter((p) => p.component_id !== component.id);
      store.impacts = store.impacts.filter((i) => i.component_id !== component.id);
    } else {
      const input = await body();
      const name = str(input, "name");
      if (name !== undefined) component.name = name;
      // The absent / null / string distinction the API documents. This is the
      // branch the console's `sectionEdited` marker exists to make reachable.
      if ("sectionPublicId" in input) {
        const value = input["sectionPublicId"];
        if (value === null) component.section_id = null;
        else if (typeof value === "string") {
          const section = store.sections.find((s) => s.public_id === value);
          if (!section) return fail("no such section", "sectionPublicId");
          component.section_id = section.id;
        }
      }
    }
    touch(store, component.page_id);
    return json({ ok: true });
  }

  // --- probes ------------------------------------------------------------

  if (method === "POST" && path === "/probes") {
    const input = await body();
    const componentPublicId = str(input, "componentPublicId");
    const url = str(input, "url");
    if (componentPublicId === undefined) return fail("required", "componentPublicId");
    if (url === undefined) return fail("required", "url");

    const component = store.components.find((c) => c.public_id === componentPublicId);
    if (!component) return fail("no such component", "componentPublicId");

    const intervalSeconds = num(input, "intervalSeconds") ?? 60;
    if (intervalSeconds < 60) return fail("must be at least 60", "intervalSeconds");

    const severity = str(input, "severity") ?? "partial_outage";
    const probe = {
      id: store.nextId++,
      public_id: newPublicId("prb", store),
      component_id: component.id,
      url,
      method: str(input, "method") ?? "GET",
      severity,
      expected_status: num(input, "expectedStatus") ?? 200,
      timeout_ms: num(input, "timeoutMs") ?? 10_000,
      interval_seconds: intervalSeconds,
      failure_threshold: num(input, "failureThreshold") ?? 3,
      recovery_threshold: num(input, "recoveryThreshold") ?? 2,
      enabled: input["enabled"] === false ? 0 : 1,
      next_check_at: 0,
      consecutive_failures: 0,
      consecutive_successes: 0,
      transition_seq: 0,
      last_probe_at: null,
      open_impact_id: null,
    };
    store.probes.push(probe);
    touch(store, component.page_id);
    return json({ ok: true, publicId: probe.public_id }, 201);
  }

  const probeById = /^\/probes\/([^/]+)$/.exec(path);
  if (probeById && (method === "PATCH" || method === "DELETE")) {
    const publicId = decodeURIComponent(probeById[1]!);
    const probe = store.probes.find((p) => p.public_id === publicId);
    if (!probe) return fail("no such probe", "probePublicId");

    const component = store.components.find((c) => c.id === probe.component_id);

    if (method === "DELETE") {
      store.probes = store.probes.filter((p) => p !== probe);
    } else {
      const input = await body();
      const url = str(input, "url");
      if (url !== undefined) probe.url = url;
      const intervalSeconds = num(input, "intervalSeconds");
      if (intervalSeconds !== undefined) {
        if (intervalSeconds < 60) return fail("must be at least 60", "intervalSeconds");
        probe.interval_seconds = intervalSeconds;
      }
      if (typeof input["enabled"] === "boolean") probe.enabled = input["enabled"] ? 1 : 0;
    }
    if (component) touch(store, component.page_id);
    return json({ ok: true });
  }

  // --- changes -----------------------------------------------------------

  const createChange = /^\/pages\/([^/]+)\/changes$/.exec(path);
  if (method === "POST" && createChange) {
    const slug = decodeURIComponent(createChange[1]!);
    const page = store.pages.find((p) => p.slug === slug);
    if (!page) return fail("page_not_found", null, 404);
    const input = await body();
    const title = str(input, "title");
    if (title === undefined) return fail("required", "title");

    const change = {
      id: store.nextId++,
      public_id: newPublicId("chg", store),
      page_id: page.id,
      kind: str(input, "kind") ?? "incident",
      status: "in_progress",
      title,
      body: typeof input["body"] === "string" ? input["body"] : null,
      severity: str(input, "severity") ?? "partial_outage",
      starts_at: num(input, "startsAt") ?? Math.floor(Date.now() / 1000),
      ends_at: null,
      scheduled_start_at: num(input, "scheduledStartAt") ?? null,
      scheduled_end_at: num(input, "scheduledEndAt") ?? null,
    };
    store.changes.push(change);
    touch(store, page.id);
    return json({ ok: true, publicId: change.public_id }, 201);
  }

  const changeUpdate = /^\/changes\/([^/]+)\/updates$/.exec(path);
  if (method === "POST" && changeUpdate) {
    const publicId = decodeURIComponent(changeUpdate[1]!);
    const change = store.changes.find((c) => c.public_id === publicId);
    if (!change) return fail("no such change", "changePublicId");
    const input = await body();
    const status = str(input, "status");
    if (status === undefined) return fail("required", "status");
    if (str(input, "body") === undefined) return fail("required", "body");

    change.status = status;
    if (status === "resolved" || status === "completed") {
      change.ends_at = Math.floor(Date.now() / 1000);
    }
    touch(store, change.page_id);
    return json({ ok: true, publicId: newPublicId("upd", store) }, 201);
  }

  const changePatch = /^\/changes\/([^/]+)$/.exec(path);
  if (method === "PATCH" && changePatch) {
    const publicId = decodeURIComponent(changePatch[1]!);
    const change = store.changes.find((c) => c.public_id === publicId);
    if (!change) return fail("no such change", "changePublicId");
    const input = await body();
    const status = str(input, "status");
    if (status === undefined) return fail("required", "status");

    change.status = status;
    if (status === "resolved" || status === "completed") {
      change.ends_at = Math.floor(Date.now() / 1000);
    }
    touch(store, change.page_id);
    return json({ ok: true });
  }

  // --- manual impacts ----------------------------------------------------

  const createImpact = /^\/pages\/([^/]+)\/impacts$/.exec(path);
  if (method === "POST" && createImpact) {
    const slug = decodeURIComponent(createImpact[1]!);
    const page = store.pages.find((p) => p.slug === slug);
    if (!page) return fail("page_not_found", null, 404);
    const input = await body();
    const componentPublicId = str(input, "componentPublicId");
    if (componentPublicId === undefined) return fail("required", "componentPublicId");
    const component = store.components.find((c) => c.public_id === componentPublicId);
    if (!component) return fail("no such component", "componentPublicId");
    const startAt = num(input, "startAt");
    if (startAt === undefined) return fail("required", "startAt");

    const impact = {
      id: store.nextId++,
      public_id: newPublicId("imp", store),
      component_id: component.id,
      severity: str(input, "severity") ?? "partial_outage",
      start_at: startAt,
      end_at: num(input, "endAt") ?? null,
      estimated: 0,
    };
    store.impacts.push(impact);
    touch(store, page.id);
    return json({ ok: true, publicId: impact.public_id }, 201);
  }

  const closeImpact = /^\/impacts\/([^/]+)\/close$/.exec(path);
  if (method === "POST" && closeImpact) {
    const publicId = decodeURIComponent(closeImpact[1]!);
    const impact = store.impacts.find((i) => i.public_id === publicId);
    if (!impact) return fail("no such impact", "impactPublicId");
    const input = await body();
    impact.end_at = num(input, "endAt") ?? Math.floor(Date.now() / 1000);
    const component = store.components.find((c) => c.id === impact.component_id);
    if (component) touch(store, component.page_id);
    return json({ ok: true });
  }

  return fail("not_found", null, 404);
}
