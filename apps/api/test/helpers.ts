/**
 * Shared fixtures for the API integration tests.
 *
 * These run against real `workerd` with a real D1 binding and a real KV
 * namespace, for the same reason the state-machine tests do: the behaviour under
 * test is partly the runtime's — `batch()` atomicity, partial unique indexes,
 * `ON CONFLICT ... RETURNING`, KV read-after-write — and a mock would assert my
 * beliefs about it instead of the behaviour itself.
 *
 * Two rules keep the suite honest:
 *
 *   * Every test seeds its own page with a unique slug. Nothing depends on the
 *     migration's seed row, so a change to the seed cannot silently make a test
 *     pass for the wrong reason.
 *   * Nothing here sets a timestamp from the wall clock. `now` is always passed
 *     explicitly, so a test that fails is failing for a reason in the code.
 */

import { testEnv as env } from "./env";
import app from "../src/index";

/**
 * The runtime bindings, viewed through the Worker's own `Env`.
 *
 * `testEnv` is typed as `Cloudflare.Env`, the interface `wrangler types` derives
 * from `wrangler.jsonc`. The secrets this Worker reads are not declared there —
 * they are set with `wrangler secret put` — so they are added to the *global*
 * `Env` by `types/env.d.ts` instead, and a test that needs to read one (the
 * unsubscribe signing key, to forge a link the Worker will accept) needs that
 * same view.
 *
 * The values are fixtures for a local `workerd`, not credentials. See
 * `vitest.config.ts`.
 */
export const workerEnv = env as unknown as Env;

/** Fixed clock for every test. */
export const T0 = 1_700_000_000;
export const MINUTE = 60;
export const HOUR = 3600;
export const DAY = 86_400;

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(6, "0")}`;
}

export interface SeededPage {
  id: number;
  publicId: string;
  slug: string;
}

export async function createPage(name = "Test Page"): Promise<SeededPage> {
  const slug = uniqueId("page");
  const publicId = uniqueId("pagepub");
  const result = await env.DB.prepare(
    `INSERT INTO page (public_id, slug, name, snapshot_version, created_at, updated_at)
     VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
  )
    .bind(publicId, slug, name, T0)
    .run();
  return { id: Number(result.meta.last_row_id), publicId, slug };
}

export interface SeededComponent {
  id: number;
  publicId: string;
}

export async function createComponent(
  pageId: number,
  options: { name?: string; availableSince?: number; sectionId?: number | null } = {},
): Promise<SeededComponent> {
  const publicId = uniqueId("comp");
  const result = await env.DB.prepare(
    `INSERT INTO component
       (public_id, page_id, name, description, section_id, available_since, order_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, 1, ?6, ?6)`,
  )
    .bind(
      publicId,
      pageId,
      options.name ?? `Component ${publicId}`,
      options.sectionId ?? null,
      options.availableSince ?? T0 - 30 * DAY,
      T0,
    )
    .run();
  return { id: Number(result.meta.last_row_id), publicId };
}

export async function createProbeTarget(
  componentId: number,
  options: {
    url?: string;
    severity?: string;
    intervalSeconds?: number;
    failureThreshold?: number;
    recoveryThreshold?: number;
    enabled?: boolean;
    nextCheckAt?: number;
  } = {},
): Promise<{ id: number; publicId: string }> {
  const publicId = uniqueId("tgt");
  const result = await env.DB.prepare(
    `INSERT INTO probe_target
       (public_id, component_id, url, method, severity, expected_status, timeout_ms,
        interval_seconds, failure_threshold, recovery_threshold, enabled, next_check_at,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, 'GET', ?4, 200, 5000, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
  )
    .bind(
      publicId,
      componentId,
      options.url ?? "https://probe.example.com/health",
      options.severity ?? "partial_outage",
      options.intervalSeconds ?? MINUTE,
      options.failureThreshold ?? 3,
      options.recoveryThreshold ?? 2,
      options.enabled === false ? 0 : 1,
      options.nextCheckAt ?? 0,
      T0,
    )
    .run();

  const id = Number(result.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO probe_state (probe_target_id, updated_at) VALUES (?1, ?2)`,
  )
    .bind(id, T0)
    .run();

  return { id, publicId };
}

/**
 * A `fetch` stand-in for the prober.
 *
 * Returns the same response for every request and counts the calls, so a test
 * can assert both what the prober recorded and how many requests it actually
 * made — the second is what proves a refused URL never reached the network.
 */
export function fakeFetch(
  behaviour: { ok?: boolean; status?: number; throw?: string } = {},
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (behaviour.throw !== undefined) throw new Error(behaviour.throw);
    const status = behaviour.ok === false ? (behaviour.status ?? 500) : (behaviour.status ?? 200);
    return new Response("ok", { status });
  }) as unknown as typeof fetch;
  return { fetchImpl: impl, calls };
}

export interface SeededChange {
  id: number;
  publicId: string;
}

/**
 * A change, seeded directly.
 *
 * Used where the test is about what *reads* the change — notification
 * selection, the Atom feed — rather than about the write path. Creating one
 * through `/internal/admin` would work too, but that route fires its own
 * notification pass, and a test asserting "exactly these recipients received
 * this" should not have to account for a second pass it did not ask for.
 * `admin.test.ts` covers the write path.
 */
export async function createChange(
  pageId: number,
  options: {
    kind?: "incident" | "maintenance";
    status?: "scheduled" | "in_progress" | "verifying" | "resolved" | "completed";
    severity?: "none" | "degraded_performance" | "partial_outage" | "full_outage";
    title?: string;
    body?: string | null;
    startsAt?: number;
    endsAt?: number | null;
    componentIds?: number[];
  } = {},
): Promise<SeededChange> {
  const publicId = uniqueId("chg");
  const result = await env.DB.prepare(
    `INSERT INTO change
       (public_id, page_id, kind, status, title, body, severity, starts_at, ends_at,
        scheduled_start_at, scheduled_end_at, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, ?10, ?10)`,
  )
    .bind(
      publicId,
      pageId,
      options.kind ?? "incident",
      options.status ?? "in_progress",
      options.title ?? `Change ${publicId}`,
      options.body ?? null,
      options.severity ?? "partial_outage",
      options.startsAt ?? T0,
      options.endsAt ?? null,
      T0,
    )
    .run();

  const id = Number(result.meta.last_row_id);

  const componentIds = options.componentIds ?? [];
  if (componentIds.length > 0) {
    await env.DB.batch(
      componentIds.map((componentId) =>
        env.DB.prepare(
          "INSERT INTO change_component (change_id, component_id) VALUES (?1, ?2)",
        ).bind(id, componentId),
      ),
    );
  }

  return { id, publicId };
}

/**
 * A timeline entry on a change.
 *
 * `created_at` is passed in rather than taken from the clock so that a test
 * about ordering or about a feed entry's `updated` timestamp is asserting
 * against a value it chose.
 */
export async function createChangeUpdate(
  changeId: number,
  options: {
    status?: "scheduled" | "in_progress" | "verifying" | "resolved" | "completed";
    body?: string;
    createdAt?: number;
  } = {},
): Promise<string> {
  const publicId = uniqueId("upd");
  await env.DB.prepare(
    `INSERT INTO change_update (public_id, change_id, status, body, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5)`,
  )
    .bind(
      publicId,
      changeId,
      options.status ?? "in_progress",
      options.body ?? `Update ${publicId}`,
      options.createdAt ?? T0,
    )
    .run();
  return publicId;
}

/** A subscriber, seeded directly, in whatever state the test needs. */
export async function createSubscriber(
  pageId: number,
  email: string,
  options: {
    confirmedAt?: number | null;
    confirmToken?: string | null;
    unsubscribedAt?: number | null;
    version?: number;
    updatedAt?: number;
    componentIds?: number[];
  } = {},
): Promise<{ id: number; publicId: string }> {
  const publicId = uniqueId("sub");
  const result = await env.DB.prepare(
    `INSERT INTO subscriber
       (public_id, page_id, email, confirmed_at, confirm_token, version, unsubscribed_at,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      publicId,
      pageId,
      email,
      options.confirmedAt ?? null,
      options.confirmToken ?? null,
      options.version ?? 1,
      options.unsubscribedAt ?? null,
      T0,
      options.updatedAt ?? T0,
    )
    .run();

  const id = Number(result.meta.last_row_id);
  const componentIds = options.componentIds ?? [];
  if (componentIds.length > 0) {
    await env.DB.batch(
      componentIds.map((componentId) =>
        env.DB.prepare(
          "INSERT INTO subscriber_component (subscriber_id, component_id) VALUES (?1, ?2)",
        ).bind(id, componentId),
      ),
    );
  }

  return { id, publicId };
}

/** A minimal `ExecutionContext`. Handlers in this project use no waitUntil. */
const executionContext = {
  waitUntil(): void {},
  passThroughOnException(): void {},
} as unknown as ExecutionContext;

/**
 * Call the Worker with a modified binding set.
 *
 * Used to exercise the "this deployment has not configured X" branches, which
 * are guards worth testing and cannot be reached any other way: `wrangler.jsonc`
 * declares a value for every binding, and a test cannot un-set an environment
 * variable in a running `workerd`. Passing a different env to `fetch` is the
 * only seam, and it is the same one production uses — `c.env` is whatever the
 * runtime handed the handler.
 *
 * The copy is a plain spread, and that is deliberate. The obvious alternative —
 * `Object.assign(Object.create(env), override)` — was measured to write *through*
 * to the shared bindings: the override landed on the real `env`, so the secret
 * stayed empty for every test that ran afterwards and the failure looked like a
 * bug in the code under test. `env` is not an ordinary object. A spread reads the
 * bindings once and produces a new plain object that cannot leak a write.
 */
export async function callApi(
  path: string,
  init: RequestInit = {},
  envOverride?: Partial<Env>,
): Promise<Response> {
  const request = new Request(`https://api.test${path}`, init);
  const bindings =
    envOverride === undefined
      ? env
      : ({ ...(env as unknown as Record<string, unknown>), ...envOverride } as unknown as Env);
  return app.fetch(request, bindings, executionContext);
}

export async function callJson(
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  // `Request` rejects a body on GET and HEAD outright, so a helper that always
  // attached one would make every read-only call throw before it ever reached the
  // Worker — and the failure would look like a routing bug rather than a fixture
  // bug.
  const carriesBody = method !== "GET" && method !== "HEAD";
  return callApi(path, {
    method,
    headers: carriesBody ? { "Content-Type": "application/json", ...headers } : { ...headers },
    ...(carriesBody ? { body: JSON.stringify(body) } : {}),
  });
}

export const INTERNAL_HEADERS = { "X-Internal-Key": "fixture-internal-key-not-a-credential" };

export async function callAdmin(
  path: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return callJson(path, method, body ?? {}, INTERNAL_HEADERS);
}

export async function pageVersion(pageId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT snapshot_version FROM page WHERE id = ?1")
    .bind(pageId)
    .first<{ snapshot_version: number }>();
  return row?.snapshot_version ?? -1;
}

export async function readKvSnapshot(slug: string, key?: string): Promise<unknown> {
  const raw = await env.SNAPSHOT_KV.get(key ?? `snapshot:${slug}`);
  return raw === null ? null : JSON.parse(raw);
}
