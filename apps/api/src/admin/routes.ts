/**
 * HTTP surface for the admin write path.
 *
 * Mounted under `/internal/admin`, which means two independent conditions already
 * hold before any handler here runs: the request arrived over the Service Binding
 * (this Worker has no public route) and it presented `INTERNAL_KEY`. See
 * `src/index.ts` for why those are two checks rather than one.
 *
 * The handlers stay thin on purpose. Validation is in `validate.ts`, the
 * transaction-ish write logic is in `service.ts`, and this file only translates
 * between HTTP and those two. A route that contains business logic is a route
 * that cannot be tested without an HTTP request.
 */

import { Hono } from "hono";

import { notifyChangeSafely, type NotifyEvent } from "../subscribe/notify";
import * as service from "./service";
import {
  asObject,
  optionalBool,
  optionalEnum,
  optionalInt,
  optionalString,
  optionalStringArray,
  requireEnum,
  requireInt,
  requireString,
  ValidationError,
} from "./validate";

const FAULT_SEVERITIES = ["degraded_performance", "partial_outage", "full_outage"] as const;
const CHANGE_SEVERITIES = [...FAULT_SEVERITIES, "none"] as const;
const CHANGE_STATUSES = ["scheduled", "in_progress", "verifying", "resolved", "completed"] as const;
const CHANGE_KINDS = ["incident", "maintenance"] as const;

export function createAdminRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.onError((error, c) => {
    if (error instanceof ValidationError) {
      return c.json({ ok: false, error: error.message, field: error.field ?? null }, 400);
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error("admin route failed", detail);
    return c.json({ ok: false, error: "internal_error", detail }, 500);
  });

  const ctxOf = (c: { env: Env }): service.WriteContext => ({
    db: c.env.DB,
    kv: c.env.SNAPSHOT_KV,
    now: Math.floor(Date.now() / 1000),
  });

  /**
   * Send notifications after a change write.
   *
   * Placed here rather than inside `service.ts` because it needs the Worker
   * environment (the email binding, the signing key, the public origin) and
   * `service.ts` is deliberately free of anything but the database and KV. It
   * also has to run *after* the write has committed, so that the message can
   * describe something that is already true.
   */
  const notify = (c: { env: Env }, publicId: string, event: NotifyEvent): Promise<void> =>
    notifyChangeSafely(c.env, publicId, event, Math.floor(Date.now() / 1000));

  // -------------------------------------------------------------------------
  // Read: the admin view of a page
  // -------------------------------------------------------------------------

  app.get("/pages/:slug", async (c) => {
    const slug = c.req.param("slug");
    const page = await c.env.DB.prepare(
      "SELECT id, public_id, slug, name, snapshot_version, updated_at FROM page WHERE slug = ?1",
    )
      .bind(slug)
      .first<{
        id: number;
        public_id: string;
        slug: string;
        name: string;
        snapshot_version: number;
        updated_at: number;
      }>();

    if (!page) return c.json({ ok: false, error: "page_not_found" }, 404);

    const [sections, components, probes, changes] = await c.env.DB.batch([
      c.env.DB
        .prepare(
          "SELECT public_id, name, description, order_id FROM section WHERE page_id = ?1 ORDER BY order_id, id",
        )
        .bind(page.id),
      c.env.DB
        .prepare(
          `SELECT c.public_id, c.name, c.description, c.order_id, c.available_since,
                  s.public_id AS section_public_id
             FROM component c
             LEFT JOIN section s ON s.id = c.section_id
            WHERE c.page_id = ?1
            ORDER BY c.order_id, c.id`,
        )
        .bind(page.id),
      c.env.DB
        .prepare(
          `SELECT t.public_id, t.url, t.method, t.severity, t.expected_status, t.timeout_ms,
                  t.interval_seconds, t.failure_threshold, t.recovery_threshold, t.enabled,
                  t.next_check_at, c.public_id AS component_public_id,
                  st.consecutive_failures, st.consecutive_successes, st.transition_seq,
                  st.last_probe_at, st.open_impact_id
             FROM probe_target t
             JOIN component c ON c.id = t.component_id
             LEFT JOIN probe_state st ON st.probe_target_id = t.id
            WHERE c.page_id = ?1
            ORDER BY t.id`,
        )
        .bind(page.id),
      c.env.DB
        .prepare(
          `SELECT public_id, kind, status, title, severity, starts_at, ends_at,
                  scheduled_start_at, scheduled_end_at
             FROM change
            WHERE page_id = ?1
            ORDER BY starts_at DESC, id DESC
            LIMIT 100`,
        )
        .bind(page.id),
    ]);

    return c.json({
      ok: true,
      page,
      sections: sections.results,
      components: components.results,
      probes: probes.results,
      changes: changes.results,
    });
  });

  // -------------------------------------------------------------------------
  // Sections
  // -------------------------------------------------------------------------

  app.post("/pages/:slug/sections", async (c) => {
    const body = asObject(await c.req.json());
    const result = await service.createSection(ctxOf(c), c.req.param("slug"), {
      name: requireString(body, "name", { max: 120 }),
      description: optionalString(body, "description", { max: 2000 }) ?? null,
      ...(optionalInt(body, "orderId") === undefined ? {} : { orderId: optionalInt(body, "orderId")! }),
    });
    return c.json({ ok: true, ...result }, 201);
  });

  app.patch("/sections/:publicId", async (c) => {
    const body = asObject(await c.req.json());
    const description = optionalString(body, "description", { max: 2000 });
    await service.updateSection(ctxOf(c), c.req.param("publicId"), {
      ...(optionalString(body, "name", { max: 120 }) === undefined
        ? {}
        : { name: optionalString(body, "name", { max: 120 })! }),
      ...(description === undefined ? {} : { description }),
      ...(optionalInt(body, "orderId") === undefined ? {} : { orderId: optionalInt(body, "orderId")! }),
    });
    return c.json({ ok: true });
  });

  app.delete("/sections/:publicId", async (c) => {
    await service.deleteSection(ctxOf(c), c.req.param("publicId"));
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Components
  // -------------------------------------------------------------------------

  app.post("/pages/:slug/components", async (c) => {
    const body = asObject(await c.req.json());
    const sectionPublicId = optionalString(body, "sectionPublicId");
    const result = await service.createComponent(ctxOf(c), c.req.param("slug"), {
      name: requireString(body, "name", { max: 120 }),
      description: optionalString(body, "description", { max: 2000 }) ?? null,
      sectionPublicId: sectionPublicId ?? null,
      ...(optionalInt(body, "orderId") === undefined ? {} : { orderId: optionalInt(body, "orderId")! }),
      ...(optionalInt(body, "availableSince") === undefined
        ? {}
        : { availableSince: optionalInt(body, "availableSince")! }),
    });
    return c.json({ ok: true, ...result }, 201);
  });

  app.patch("/components/:publicId", async (c) => {
    const body = asObject(await c.req.json());
    const sectionRaw = body["sectionPublicId"];
    const description = optionalString(body, "description", { max: 2000 });
    const name = optionalString(body, "name", { max: 120 });

    await service.updateComponent(ctxOf(c), c.req.param("publicId"), {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(sectionRaw === undefined
        ? {}
        : { sectionPublicId: sectionRaw === null ? null : requireString(body, "sectionPublicId") }),
      ...(optionalInt(body, "orderId") === undefined ? {} : { orderId: optionalInt(body, "orderId")! }),
    });
    return c.json({ ok: true });
  });

  app.delete("/components/:publicId", async (c) => {
    await service.deleteComponent(ctxOf(c), c.req.param("publicId"));
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Changes
  // -------------------------------------------------------------------------

  app.post("/pages/:slug/changes", async (c) => {
    const body = asObject(await c.req.json());
    const result = await service.createChange(ctxOf(c), c.req.param("slug"), {
      kind: requireEnum(body, "kind", CHANGE_KINDS),
      title: requireString(body, "title", { max: 200 }),
      body: optionalString(body, "body", { max: 20_000 }) ?? null,
      severity: requireEnum(body, "severity", CHANGE_SEVERITIES),
      componentPublicIds: optionalStringArray(body, "componentPublicIds", { max: 200 }) ?? [],
      ...(optionalInt(body, "startsAt") === undefined ? {} : { startsAt: optionalInt(body, "startsAt")! }),
      scheduledStartAt: optionalInt(body, "scheduledStartAt") ?? null,
      scheduledEndAt: optionalInt(body, "scheduledEndAt") ?? null,
    });
    // A maintenance window announced ahead of time is not news yet, so it does
    // not notify on creation. An incident is, because announcing one is the
    // notification.
    const kind = body["kind"];
    if (kind === "incident") await notify(c, result.publicId, "created");
    return c.json({ ok: true, ...result }, 201);
  });

  app.post("/changes/:publicId/updates", async (c) => {
    const body = asObject(await c.req.json());
    const rawOverrides = body["componentOverrides"];
    let overrides: Array<{ componentPublicId: string; status: string }> | undefined;

    if (rawOverrides !== undefined && rawOverrides !== null) {
      if (!Array.isArray(rawOverrides)) {
        throw new ValidationError("componentOverrides must be an array", "componentOverrides");
      }
      overrides = rawOverrides.map((entry) => {
        const item = asObject(entry);
        return {
          componentPublicId: requireString(item, "componentPublicId"),
          status: requireEnum(item, "status", [
            "operational",
            "degraded_performance",
            "partial_outage",
            "full_outage",
            "maintenance",
          ] as const),
        };
      });
    }

    const result = await service.addChangeUpdate(ctxOf(c), c.req.param("publicId"), {
      status: requireEnum(body, "status", CHANGE_STATUSES),
      body: requireString(body, "body", { max: 20_000 }),
      ...(overrides === undefined ? {} : { componentOverrides: overrides }),
    });
    const status = body["status"];
    await notify(
      c,
      c.req.param("publicId"),
      status === "resolved" || status === "completed" ? "resolved" : "updated",
    );
    return c.json({ ok: true, ...result }, 201);
  });

  app.patch("/changes/:publicId", async (c) => {
    const body = asObject(await c.req.json());
    await service.setChangeStatus(ctxOf(c), c.req.param("publicId"), {
      status: requireEnum(body, "status", CHANGE_STATUSES),
      ...(optionalInt(body, "endsAt") === undefined ? {} : { endsAt: optionalInt(body, "endsAt")! }),
    });
    const status = body["status"];
    await notify(
      c,
      c.req.param("publicId"),
      status === "resolved" || status === "completed" ? "resolved" : "updated",
    );
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Manual impacts
  // -------------------------------------------------------------------------

  app.post("/pages/:slug/impacts", async (c) => {
    const body = asObject(await c.req.json());
    const result = await service.createManualImpact(ctxOf(c), c.req.param("slug"), {
      componentPublicId: requireString(body, "componentPublicId"),
      severity: requireEnum(body, "severity", FAULT_SEVERITIES),
      startAt: requireInt(body, "startAt", { min: 0 }),
      endAt: optionalInt(body, "endAt", { min: 0 }) ?? null,
    });
    return c.json({ ok: true, ...result }, 201);
  });

  app.post("/impacts/:publicId/close", async (c) => {
    const body = asObject(await c.req.json());
    await service.closeManualImpact(
      ctxOf(c),
      c.req.param("publicId"),
      requireInt(body, "endAt", { min: 0 }),
    );
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Probe targets
  // -------------------------------------------------------------------------

  app.post("/probes", async (c) => {
    const body = asObject(await c.req.json());
    const result = await service.createProbeTarget(ctxOf(c), {
      componentPublicId: requireString(body, "componentPublicId"),
      url: requireString(body, "url", { max: 2000 }),
      ...(optionalEnum(body, "method", ["GET", "HEAD"] as const) === undefined
        ? {}
        : { method: optionalEnum(body, "method", ["GET", "HEAD"] as const)! }),
      ...(optionalEnum(body, "severity", FAULT_SEVERITIES) === undefined
        ? {}
        : { severity: optionalEnum(body, "severity", FAULT_SEVERITIES)! }),
      ...(optionalInt(body, "expectedStatus", { min: 100, max: 599 }) === undefined
        ? {}
        : { expectedStatus: optionalInt(body, "expectedStatus", { min: 100, max: 599 })! }),
      ...(optionalInt(body, "timeoutMs", { min: 1000, max: 30_000 }) === undefined
        ? {}
        : { timeoutMs: optionalInt(body, "timeoutMs", { min: 1000, max: 30_000 })! }),
      ...(optionalInt(body, "intervalSeconds", { min: 60, max: 86_400 }) === undefined
        ? {}
        : { intervalSeconds: optionalInt(body, "intervalSeconds", { min: 60, max: 86_400 })! }),
      ...(optionalInt(body, "failureThreshold", { min: 1, max: 10 }) === undefined
        ? {}
        : { failureThreshold: optionalInt(body, "failureThreshold", { min: 1, max: 10 })! }),
      ...(optionalInt(body, "recoveryThreshold", { min: 1, max: 10 }) === undefined
        ? {}
        : { recoveryThreshold: optionalInt(body, "recoveryThreshold", { min: 1, max: 10 })! }),
      ...(optionalBool(body, "enabled") === undefined
        ? {}
        : { enabled: optionalBool(body, "enabled")! }),
    });
    return c.json({ ok: true, ...result }, 201);
  });

  app.patch("/probes/:publicId", async (c) => {
    const body = asObject(await c.req.json());
    const method = optionalEnum(body, "method", ["GET", "HEAD"] as const);
    const severity = optionalEnum(body, "severity", FAULT_SEVERITIES);
    const url = optionalString(body, "url", { max: 2000 });
    const expectedStatus = optionalInt(body, "expectedStatus", { min: 100, max: 599 });
    const timeoutMs = optionalInt(body, "timeoutMs", { min: 1000, max: 30_000 });
    const intervalSeconds = optionalInt(body, "intervalSeconds", { min: 60, max: 86_400 });
    const failureThreshold = optionalInt(body, "failureThreshold", { min: 1, max: 10 });
    const recoveryThreshold = optionalInt(body, "recoveryThreshold", { min: 1, max: 10 });
    const enabled = optionalBool(body, "enabled");

    await service.updateProbeTarget(ctxOf(c), c.req.param("publicId"), {
      ...(url === undefined ? {} : { url }),
      ...(method === undefined ? {} : { method }),
      ...(severity === undefined ? {} : { severity }),
      ...(expectedStatus === undefined ? {} : { expectedStatus }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
      ...(failureThreshold === undefined ? {} : { failureThreshold }),
      ...(recoveryThreshold === undefined ? {} : { recoveryThreshold }),
      ...(enabled === undefined ? {} : { enabled }),
    });
    return c.json({ ok: true });
  });

  app.delete("/probes/:publicId", async (c) => {
    await service.deleteProbeTarget(ctxOf(c), c.req.param("publicId"));
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------

  app.post("/pages/:slug/rebuild", async (c) => {
    const version = await service.publishSnapshot(ctxOf(c), c.req.param("slug"));
    return c.json({ ok: true, snapshotVersion: version });
  });

  return app;
}
