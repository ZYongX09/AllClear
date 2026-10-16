/**
 * The admin write path.
 *
 * Everything that can change public output goes through here, and everything here
 * ends in the same two steps: advance `page.snapshot_version`, then rebuild and
 * republish the snapshot synchronously.
 *
 * ## Why the rebuild is synchronous
 *
 * The plan's position is that a scheduled job must not be the mechanism that
 * *publishes* changes. If publishing waited for the next cron tick, an operator
 * who just resolved an incident would watch the public page keep showing it for up
 * to a minute, and the natural reaction to that — "the save did not work" — is
 * wrong in a way that invites a second, conflicting edit. Cron's job is repair:
 * find snapshots whose embedded version has drifted and rebuild those.
 *
 * ## Why every operation is wrapped rather than calling publish itself
 *
 * A write that forgets to republish is invisible: the API returns 200, the
 * database is correct, and the status page silently keeps serving the old
 * document until something else happens to trigger a rebuild. `withPublish` makes
 * that omission impossible to make by accident, because the publish is not
 * something an operation chooses to do.
 *
 * ## What is deliberately absent
 *
 * There is no per-user authentication here. v1's boundary is architectural: this
 * Worker has no public route (`workers_dev: false`), the admin namespace is
 * reachable only over the Service Binding, and every `/internal/*` request must
 * present `INTERNAL_KEY`. `admin_user` and `audit_log.actor_admin_user_id` exist
 * in the schema but are unused, because inventing an identity model that nothing
 * authenticates against would be worse than leaving the columns empty. Per-user
 * auth is a prerequisite for exposing this Worker publicly, and that is stated in
 * docs/spec/admin-api.md rather than implied.
 */

import { ulid } from "../lib/ulid";
import { buildSnapshot, bumpSnapshotVersion, writeSnapshot } from "../snapshot";
import { ValidationError } from "./validate";

export interface WriteContext {
  db: D1Database;
  kv: KVNamespace;
  now: number;
  newId?: () => string;
}

export type ChangeKind = "incident" | "maintenance";
export type ChangeStatus = "scheduled" | "in_progress" | "verifying" | "resolved" | "completed";
export type ChangeSeverity = "none" | "degraded_performance" | "partial_outage" | "full_outage";
export type FaultSeverity = "degraded_performance" | "partial_outage" | "full_outage";

const FAULT_SEVERITIES: readonly FaultSeverity[] = [
  "degraded_performance",
  "partial_outage",
  "full_outage",
];

function isFaultSeverity(value: string): value is FaultSeverity {
  return (FAULT_SEVERITIES as readonly string[]).includes(value);
}

interface PageRow {
  id: number;
  public_id: string;
  slug: string;
  name: string;
}

async function requirePage(db: D1Database, slug: string): Promise<PageRow> {
  const page = await db
    .prepare("SELECT id, public_id, slug, name FROM page WHERE slug = ?1")
    .bind(slug)
    .first<PageRow>();
  if (!page) throw new ValidationError(`no page with slug ${slug}`, "slug");
  return page;
}

/**
 * D1 reports a violated constraint through the error message, not a code.
 *
 * This matters for exactly one case: a duplicate slug. Left alone it surfaces as
 * a 500 carrying the raw SQLite text, which tells an operator nothing they can
 * act on. Recognising it turns "UNIQUE constraint failed: page.slug" into a 400
 * naming the field, which is what the rest of this API does with bad input.
 */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

async function componentIdByPublicId(db: D1Database, publicId: string): Promise<number> {
  const row = await db
    .prepare("SELECT id FROM component WHERE public_id = ?1")
    .bind(publicId)
    .first<{ id: number }>();
  if (!row) throw new ValidationError(`no component with public id ${publicId}`, "componentPublicId");
  return row.id;
}

/**
 * Run a write, then publish.
 *
 * `publishSnapshot` is idempotent, so a caller that writes several entities in
 * one operation can still use this once at the end.
 */
async function withPublish<T>(
  ctx: WriteContext,
  slug: string,
  fn: () => Promise<T>,
): Promise<T> {
  const result = await fn();
  await publishSnapshot(ctx, slug);
  return result;
}

export async function publishSnapshot(ctx: WriteContext, slug: string): Promise<number> {
  const page = await requirePage(ctx.db, slug);
  const version = await bumpSnapshotVersion(ctx.db, page.id, ctx.now);
  const snapshot = await buildSnapshot(ctx.db, slug, { now: ctx.now });
  await writeSnapshot(ctx.kv, snapshot);
  return version;
}

async function audit(
  ctx: WriteContext,
  action: string,
  entityType: string,
  entityId: string | null,
  detail: unknown,
): Promise<void> {
  await ctx.db
    .prepare(
      `INSERT INTO audit_log (public_id, actor_admin_user_id, action, entity_type, entity_id, detail, created_at)
       VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(
      (ctx.newId ?? ulid)(),
      action,
      entityType,
      entityId,
      detail === undefined ? null : JSON.stringify(detail),
      ctx.now,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface PageInput {
  slug: string;
  name: string;
}

/**
 * Create a status page.
 *
 * The baseline migration seeds one page, which is enough for the deployment this
 * was written for and not enough for a second one. Without this the admin UI
 * could only edit the page that happened to be seeded, so a new deployment would
 * have to insert its page by hand.
 *
 * `snapshot_version` starts at 0 and `publishSnapshot` immediately advances it to
 * 1, so the very first read is a KV hit rather than a rebuild. A brand new page
 * has an empty snapshot and that is a legitimate document: zero components is
 * not the same as an unavailable page.
 */
export async function createPage(
  ctx: WriteContext,
  input: PageInput,
): Promise<{ publicId: string }> {
  const publicId = (ctx.newId ?? ulid)();
  try {
    await ctx.db
      .prepare(
        `INSERT INTO page (public_id, slug, name, snapshot_version, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?4)`,
      )
      .bind(publicId, input.slug, input.name, ctx.now)
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ValidationError(`a page with slug ${input.slug} already exists`, "slug");
    }
    throw error;
  }

  await audit(ctx, "page.create", "page", publicId, input);
  await publishSnapshot(ctx, input.slug);
  return { publicId };
}

/**
 * Rename a page.
 *
 * The slug is deliberately not editable. It is the public URL (`/status/<slug>`),
 * the KV key, and the identifier in every RSS reader's subscription list, so
 * changing it silently breaks bookmarks and feeds. A slug change is a
 * create-and-retire operation, not a field edit.
 */
export async function updatePage(
  ctx: WriteContext,
  slug: string,
  input: { name?: string },
): Promise<void> {
  const page = await requirePage(ctx.db, slug);
  if (input.name === undefined) return;

  await withPublish(ctx, slug, async () => {
    await ctx.db
      .prepare("UPDATE page SET name = ?2, updated_at = ?3 WHERE id = ?1")
      .bind(page.id, input.name, ctx.now)
      .run();
    await audit(ctx, "page.update", "page", page.public_id, input);
  });
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface SectionInput {
  name: string;
  description?: string | null;
  orderId?: number;
}

export async function createSection(
  ctx: WriteContext,
  slug: string,
  input: SectionInput,
): Promise<{ publicId: string }> {
  return withPublish(ctx, slug, async () => {
    const page = await requirePage(ctx.db, slug);
    const publicId = (ctx.newId ?? ulid)();
    await ctx.db
      .prepare(
        `INSERT INTO section (public_id, page_id, name, description, order_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(publicId, page.id, input.name, input.description ?? null, input.orderId ?? 0, ctx.now)
      .run();
    await audit(ctx, "section.create", "section", publicId, input);
    return { publicId };
  });
}

export async function updateSection(
  ctx: WriteContext,
  publicId: string,
  input: Partial<SectionInput>,
): Promise<void> {
  const row = await ctx.db
    .prepare("SELECT page_id FROM section WHERE public_id = ?1")
    .bind(publicId)
    .first<{ page_id: number }>();
  if (!row) throw new ValidationError(`no section with public id ${publicId}`, "sectionPublicId");
  const slug = await slugOfPage(ctx.db, row.page_id);

  await withPublish(ctx, slug, async () => {
    await ctx.db
      .prepare(
        `UPDATE section
            SET name        = COALESCE(?2, name),
                description = CASE WHEN ?3 = 1 THEN ?4 ELSE description END,
                order_id    = COALESCE(?5, order_id),
                updated_at  = ?6
          WHERE public_id = ?1`,
      )
      .bind(
        publicId,
        input.name ?? null,
        input.description === undefined ? 0 : 1,
        input.description ?? null,
        input.orderId ?? null,
        ctx.now,
      )
      .run();
    await audit(ctx, "section.update", "section", publicId, input);
  });
}

export async function deleteSection(ctx: WriteContext, publicId: string): Promise<void> {
  const row = await ctx.db
    .prepare("SELECT page_id FROM section WHERE public_id = ?1")
    .bind(publicId)
    .first<{ page_id: number }>();
  if (!row) throw new ValidationError(`no section with public id ${publicId}`, "sectionPublicId");
  const slug = await slugOfPage(ctx.db, row.page_id);

  await withPublish(ctx, slug, async () => {
    // Components are not deleted with the section: `section_id` is ON DELETE SET
    // NULL, so they move to the page root. Losing components because a grouping
    // label was removed would be a data-loss bug disguised as a cascade.
    await ctx.db.prepare("DELETE FROM section WHERE public_id = ?1").bind(publicId).run();
    await audit(ctx, "section.delete", "section", publicId, null);
  });
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export interface ComponentInput {
  name: string;
  description?: string | null;
  sectionPublicId?: string | null;
  orderId?: number;
  availableSince?: number;
}

export async function createComponent(
  ctx: WriteContext,
  slug: string,
  input: ComponentInput,
): Promise<{ publicId: string }> {
  return withPublish(ctx, slug, async () => {
    const page = await requirePage(ctx.db, slug);
    const publicId = (ctx.newId ?? ulid)();

    let sectionId: number | null = null;
    if (input.sectionPublicId !== undefined && input.sectionPublicId !== null) {
      const section = await ctx.db
        .prepare("SELECT id, page_id FROM section WHERE public_id = ?1")
        .bind(input.sectionPublicId)
        .first<{ id: number; page_id: number }>();
      if (!section) {
        throw new ValidationError(
          `no section with public id ${input.sectionPublicId}`,
          "sectionPublicId",
        );
      }
      if (section.page_id !== page.id) {
        throw new ValidationError("section belongs to a different page", "sectionPublicId");
      }
      sectionId = section.id;
    }

    await ctx.db
      .prepare(
        `INSERT INTO component
           (public_id, page_id, name, description, section_id, available_since, order_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
      )
      .bind(
        publicId,
        page.id,
        input.name,
        input.description ?? null,
        sectionId,
        input.availableSince ?? ctx.now,
        input.orderId ?? 0,
        ctx.now,
      )
      .run();

    await audit(ctx, "component.create", "component", publicId, input);
    return { publicId };
  });
}

export async function updateComponent(
  ctx: WriteContext,
  publicId: string,
  input: Partial<ComponentInput>,
): Promise<void> {
  const row = await ctx.db
    .prepare("SELECT page_id FROM component WHERE public_id = ?1")
    .bind(publicId)
    .first<{ page_id: number }>();
  if (!row) throw new ValidationError(`no component with public id ${publicId}`, "componentPublicId");
  const slug = await slugOfPage(ctx.db, row.page_id);

  await withPublish(ctx, slug, async () => {
    let sectionId: number | null | undefined;
    if (input.sectionPublicId !== undefined) {
      if (input.sectionPublicId === null) {
        sectionId = null;
      } else {
        const section = await ctx.db
          .prepare("SELECT id, page_id FROM section WHERE public_id = ?1")
          .bind(input.sectionPublicId)
          .first<{ id: number; page_id: number }>();
        if (!section) {
          throw new ValidationError(
            `no section with public id ${input.sectionPublicId}`,
            "sectionPublicId",
          );
        }
        if (section.page_id !== row.page_id) {
          throw new ValidationError("section belongs to a different page", "sectionPublicId");
        }
        sectionId = section.id;
      }
    }

    await ctx.db
      .prepare(
        `UPDATE component
            SET name        = COALESCE(?2, name),
                description = CASE WHEN ?3 = 1 THEN ?4 ELSE description END,
                section_id  = CASE WHEN ?5 = 1 THEN ?6 ELSE section_id END,
                order_id    = COALESCE(?7, order_id),
                updated_at  = ?8
          WHERE public_id = ?1`,
      )
      .bind(
        publicId,
        input.name ?? null,
        input.description === undefined ? 0 : 1,
        input.description ?? null,
        input.sectionPublicId === undefined ? 0 : 1,
        sectionId ?? null,
        input.orderId ?? null,
        ctx.now,
      )
      .run();

    await audit(ctx, "component.update", "component", publicId, input);
  });
}

export async function deleteComponent(ctx: WriteContext, publicId: string): Promise<void> {
  const row = await ctx.db
    .prepare("SELECT page_id FROM component WHERE public_id = ?1")
    .bind(publicId)
    .first<{ page_id: number }>();
  if (!row) throw new ValidationError(`no component with public id ${publicId}`, "componentPublicId");
  const slug = await slugOfPage(ctx.db, row.page_id);

  await withPublish(ctx, slug, async () => {
    await ctx.db.prepare("DELETE FROM component WHERE public_id = ?1").bind(publicId).run();
    await audit(ctx, "component.delete", "component", publicId, null);
  });
}

// ---------------------------------------------------------------------------
// Changes: incidents and maintenance windows
// ---------------------------------------------------------------------------

export interface ChangeInput {
  kind: ChangeKind;
  title: string;
  body?: string | null;
  severity: ChangeSeverity;
  componentPublicIds: string[];
  startsAt?: number;
  scheduledStartAt?: number | null;
  scheduledEndAt?: number | null;
}

export async function createChange(
  ctx: WriteContext,
  slug: string,
  input: ChangeInput,
): Promise<{ publicId: string }> {
  return withPublish(ctx, slug, async () => {
    const page = await requirePage(ctx.db, slug);
    const publicId = (ctx.newId ?? ulid)();

    const componentIds: number[] = [];
    for (const componentPublicId of input.componentPublicIds) {
      const id = await componentIdByPublicId(ctx.db, componentPublicId);
      const owner = await ctx.db
        .prepare("SELECT page_id FROM component WHERE id = ?1")
        .bind(id)
        .first<{ page_id: number }>();
      if (!owner || owner.page_id !== page.id) {
        throw new ValidationError(
          `component ${componentPublicId} belongs to a different page`,
          "componentPublicIds",
        );
      }
      componentIds.push(id);
    }

    // Maintenance starts as `scheduled` and contributes nothing to a component's
    // derived status until it is moved to `in_progress`. An incident starts
    // immediately, because announcing one is not a thing that happens ahead of
    // time.
    const status: ChangeStatus = input.kind === "maintenance" ? "scheduled" : "in_progress";
    const startsAt = input.startsAt ?? input.scheduledStartAt ?? ctx.now;

    await ctx.db
      .prepare(
        `INSERT INTO change
           (public_id, page_id, kind, status, title, body, severity, starts_at, ends_at,
            scheduled_start_at, scheduled_end_at, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, NULL, ?11, ?11)`,
      )
      .bind(
        publicId,
        page.id,
        input.kind,
        status,
        input.title,
        input.body ?? null,
        input.severity,
        startsAt,
        input.scheduledStartAt ?? null,
        input.scheduledEndAt ?? null,
        ctx.now,
      )
      .run();

    const changeRow = await ctx.db
      .prepare("SELECT id FROM change WHERE public_id = ?1")
      .bind(publicId)
      .first<{ id: number }>();
    const changeId = changeRow!.id;

    const statements = componentIds.map((componentId) =>
      ctx.db
        .prepare("INSERT INTO change_component (change_id, component_id) VALUES (?1, ?2)")
        .bind(changeId, componentId),
    );
    if (statements.length > 0) await ctx.db.batch(statements);

    // An incident with a fault severity produces impacts, because `impact` is the
    // single source of truth for downtime and uptime is computed from it. A
    // `none`-severity incident is informational and produces none; maintenance
    // never does, because its window is read from the change itself.
    if (input.kind === "incident" && isFaultSeverity(input.severity)) {
      const impactStatements = componentIds.map((componentId) =>
        ctx.db
          .prepare(
            `INSERT INTO impact
               (public_id, component_id, probe_target_id, change_id, severity,
                start_at, end_at, estimated, opened_by_result_id, created_at, updated_at)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, NULL, 0, NULL, ?6, ?6)`,
          )
          .bind((ctx.newId ?? ulid)(), componentId, changeId, input.severity, startsAt, ctx.now),
      );
      if (impactStatements.length > 0) await ctx.db.batch(impactStatements);
    }

    await audit(ctx, "change.create", "change", publicId, { ...input, status });
    return { publicId };
  });
}

export interface ChangeUpdateInput {
  status: ChangeStatus;
  body: string;
  componentOverrides?: Array<{ componentPublicId: string; status: string }>;
}

export async function addChangeUpdate(
  ctx: WriteContext,
  changePublicId: string,
  input: ChangeUpdateInput,
): Promise<{ publicId: string }> {
  const change = await ctx.db
    .prepare("SELECT id, page_id, kind, status, severity, starts_at FROM change WHERE public_id = ?1")
    .bind(changePublicId)
    .first<{
      id: number;
      page_id: number;
      kind: ChangeKind;
      status: ChangeStatus;
      severity: ChangeSeverity;
      starts_at: number;
    }>();
  if (!change) throw new ValidationError(`no change with public id ${changePublicId}`, "changePublicId");
  const slug = await slugOfPage(ctx.db, change.page_id);

  return withPublish(ctx, slug, async () => {
    const publicId = (ctx.newId ?? ulid)();

    await ctx.db
      .prepare(
        `INSERT INTO change_update (public_id, change_id, status, body, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5)`,
      )
      .bind(publicId, change.id, input.status, input.body, ctx.now)
      .run();

    const updateRow = await ctx.db
      .prepare("SELECT id FROM change_update WHERE public_id = ?1")
      .bind(publicId)
      .first<{ id: number }>();
    const updateId = updateRow!.id;

    const overrides = input.componentOverrides ?? [];
    if (overrides.length > 0) {
      const statements = [];
      for (const override of overrides) {
        const componentId = await componentIdByPublicId(ctx.db, override.componentPublicId);
        statements.push(
          ctx.db
            .prepare(
              `INSERT INTO change_update_component (change_update_id, component_id, status)
               VALUES (?1, ?2, ?3)`,
            )
            .bind(updateId, componentId, override.status),
        );
      }
      await ctx.db.batch(statements);
    }

    // The change's own status follows the newest update. Without this the
    // timeline would show "resolved" on the last entry while the incident itself
    // stayed `in_progress` and kept contributing a fault to the derived status.
    const terminal = input.status === "resolved" || input.status === "completed";
    await ctx.db
      .prepare(
        `UPDATE change
            SET status = ?2,
                ends_at = CASE WHEN ?3 = 1 THEN ?4 ELSE ends_at END,
                updated_at = ?4
          WHERE id = ?1`,
      )
      .bind(change.id, input.status, terminal ? 1 : 0, ctx.now)
      .run();

    if (terminal) {
      await ctx.db
        .prepare("UPDATE impact SET end_at = ?2, updated_at = ?2 WHERE change_id = ?1 AND end_at IS NULL")
        .bind(change.id, ctx.now)
        .run();
    }

    await applyComponentOverrides(ctx, change.id, overrides);

    await audit(ctx, "change.update", "change", changePublicId, input);
    return { publicId };
  });
}

/**
 * Apply per-component overrides from a timeline entry to the impact table.
 *
 * An override is how an operator says "this incident is a full outage for the API
 * but only degraded for the website". Without this the per-component severity
 * would live in `change_update_component` and never reach `impact`, so the uptime
 * maths would charge every affected component at the incident's headline severity
 * — quietly overstating the damage to the components that were less affected.
 */
async function applyComponentOverrides(
  ctx: WriteContext,
  changeId: number,
  overrides: Array<{ componentPublicId: string; status: string }>,
): Promise<void> {
  for (const override of overrides) {
    const componentId = await componentIdByPublicId(ctx.db, override.componentPublicId);

    if (override.status === "operational") {
      await ctx.db
        .prepare(
          "UPDATE impact SET end_at = ?3, updated_at = ?3 WHERE change_id = ?1 AND component_id = ?2 AND end_at IS NULL",
        )
        .bind(changeId, componentId, ctx.now)
        .run();
      continue;
    }

    if (override.status === "maintenance") continue;
    if (!isFaultSeverity(override.status)) continue;

    const existing = await ctx.db
      .prepare(
        "SELECT id FROM impact WHERE change_id = ?1 AND component_id = ?2 AND end_at IS NULL",
      )
      .bind(changeId, componentId)
      .first<{ id: number }>();

    if (existing) {
      await ctx.db
        .prepare("UPDATE impact SET severity = ?2, updated_at = ?3 WHERE id = ?1")
        .bind(existing.id, override.status, ctx.now)
        .run();
      continue;
    }

    const change = await ctx.db
      .prepare("SELECT starts_at FROM change WHERE id = ?1")
      .bind(changeId)
      .first<{ starts_at: number }>();

    await ctx.db
      .prepare(
        `INSERT INTO impact
           (public_id, component_id, probe_target_id, change_id, severity,
            start_at, end_at, estimated, opened_by_result_id, created_at, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, NULL, 0, NULL, ?6, ?6)`,
      )
      .bind(
        (ctx.newId ?? ulid)(),
        componentId,
        changeId,
        override.status,
        change?.starts_at ?? ctx.now,
        ctx.now,
      )
      .run();
  }
}

export interface ChangeStatusInput {
  status: ChangeStatus;
  endsAt?: number | null;
}

export async function setChangeStatus(
  ctx: WriteContext,
  changePublicId: string,
  input: ChangeStatusInput,
): Promise<void> {
  const change = await ctx.db
    .prepare("SELECT id, page_id, status FROM change WHERE public_id = ?1")
    .bind(changePublicId)
    .first<{ id: number; page_id: number; status: ChangeStatus }>();
  if (!change) throw new ValidationError(`no change with public id ${changePublicId}`, "changePublicId");
  const slug = await slugOfPage(ctx.db, change.page_id);

  const terminal = input.status === "resolved" || input.status === "completed";

  await withPublish(ctx, slug, async () => {
    const endsAt = terminal ? (input.endsAt ?? ctx.now) : null;

    await ctx.db
      .prepare("UPDATE change SET status = ?2, ends_at = ?3, updated_at = ?4 WHERE id = ?1")
      .bind(change.id, input.status, endsAt, ctx.now)
      .run();

    if (terminal) {
      await ctx.db
        .prepare(
          "UPDATE impact SET end_at = ?2, updated_at = ?2 WHERE change_id = ?1 AND end_at IS NULL",
        )
        .bind(change.id, endsAt)
        .run();
    } else if (change.status === "resolved" || change.status === "completed") {
      // Reopening. The impacts are reopened at their original `start_at`, so the
      // recorded interval grows to cover the whole event rather than restarting
      // and losing the first occurrence from the uptime record.
      await ctx.db
        .prepare("UPDATE impact SET end_at = NULL, updated_at = ?2 WHERE change_id = ?1")
        .bind(change.id, ctx.now)
        .run();
    }

    await audit(ctx, "change.status", "change", changePublicId, input);
  });
}

// ---------------------------------------------------------------------------
// Manual impacts
// ---------------------------------------------------------------------------

export interface ManualImpactInput {
  componentPublicId: string;
  severity: FaultSeverity;
  startAt: number;
  endAt?: number | null;
}

export async function createManualImpact(
  ctx: WriteContext,
  slug: string,
  input: ManualImpactInput,
): Promise<{ publicId: string }> {
  return withPublish(ctx, slug, async () => {
    const page = await requirePage(ctx.db, slug);
    const componentId = await componentIdByPublicId(ctx.db, input.componentPublicId);

    const owner = await ctx.db
      .prepare("SELECT page_id FROM component WHERE id = ?1")
      .bind(componentId)
      .first<{ page_id: number }>();
    if (!owner || owner.page_id !== page.id) {
      throw new ValidationError("component belongs to a different page", "componentPublicId");
    }

    if (input.endAt !== null && input.endAt !== undefined && input.endAt <= input.startAt) {
      throw new ValidationError("endAt must be after startAt", "endAt");
    }

    const publicId = (ctx.newId ?? ulid)();
    await ctx.db
      .prepare(
        `INSERT INTO impact
           (public_id, component_id, probe_target_id, change_id, severity,
            start_at, end_at, estimated, opened_by_result_id, created_at, updated_at)
         VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5, 0, NULL, ?6, ?6)`,
      )
      .bind(
        publicId,
        componentId,
        input.severity,
        input.startAt,
        input.endAt ?? null,
        ctx.now,
      )
      .run();

    await audit(ctx, "impact.create", "impact", publicId, input);
    return { publicId };
  });
}

export async function closeManualImpact(
  ctx: WriteContext,
  publicId: string,
  endAt: number,
): Promise<void> {
  const row = await ctx.db
    .prepare(
      `SELECT i.id, c.page_id FROM impact i
         JOIN component c ON c.id = i.component_id
        WHERE i.public_id = ?1 AND i.probe_target_id IS NULL AND i.change_id IS NULL`,
    )
    .bind(publicId)
    .first<{ id: number; page_id: number }>();
  if (!row) {
    throw new ValidationError(
      `no hand-entered impact with public id ${publicId}`,
      "impactPublicId",
    );
  }
  const slug = await slugOfPage(ctx.db, row.page_id);

  await withPublish(ctx, slug, async () => {
    await ctx.db
      .prepare("UPDATE impact SET end_at = ?2, updated_at = ?3 WHERE id = ?1")
      .bind(row.id, endAt, ctx.now)
      .run();
    await audit(ctx, "impact.close", "impact", publicId, { endAt });
  });
}

// ---------------------------------------------------------------------------
// Probe targets
// ---------------------------------------------------------------------------

export interface ProbeTargetInput {
  componentPublicId: string;
  url: string;
  method?: "GET" | "HEAD";
  severity?: FaultSeverity;
  expectedStatus?: number;
  timeoutMs?: number;
  intervalSeconds?: number;
  failureThreshold?: number;
  recoveryThreshold?: number;
  enabled?: boolean;
}

/**
 * Create a probe target and its scheduler row.
 *
 * The `enabled = 1` partial unique index means a second enabled target for the
 * same component is rejected by the database, not by a check here. That is
 * deliberate: the capacity boundary is enforced where it cannot be bypassed.
 */
export async function createProbeTarget(
  ctx: WriteContext,
  input: ProbeTargetInput,
): Promise<{ publicId: string }> {
  const componentId = await componentIdByPublicId(ctx.db, input.componentPublicId);
  const owner = await ctx.db
    .prepare("SELECT page_id FROM component WHERE id = ?1")
    .bind(componentId)
    .first<{ page_id: number }>();
  if (!owner) throw new ValidationError("component not found", "componentPublicId");
  const slug = await slugOfPage(ctx.db, owner.page_id);

  return withPublish(ctx, slug, async () => {
    const publicId = (ctx.newId ?? ulid)();
    await ctx.db
      .prepare(
        `INSERT INTO probe_target
           (public_id, component_id, url, method, severity, expected_status, timeout_ms,
            interval_seconds, failure_threshold, recovery_threshold, auth_ref, enabled,
            next_check_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, 0, ?12, ?12)`,
      )
      .bind(
        publicId,
        componentId,
        input.url,
        input.method ?? "GET",
        input.severity ?? "partial_outage",
        input.expectedStatus ?? 200,
        input.timeoutMs ?? 10_000,
        input.intervalSeconds ?? 60,
        input.failureThreshold ?? 3,
        input.recoveryThreshold ?? 2,
        input.enabled === false ? 0 : 1,
        ctx.now,
      )
      .run();

    const target = await ctx.db
      .prepare("SELECT id FROM probe_target WHERE public_id = ?1")
      .bind(publicId)
      .first<{ id: number }>();

    // The scheduler row is created with the target rather than lazily on first
    // probe. A target without one is a state the transition code reports as
    // `unconfigured`, which is a bug report rather than a state to design for.
    //
    // `probe_target.next_check_at` stays at its default of 0, so the target is
    // due on the next tick — a newly configured probe should report something
    // rather than sit idle for one interval.
    await ctx.db
      .prepare(
        `INSERT INTO probe_state (probe_target_id, updated_at)
         VALUES (?1, ?2)`,
      )
      .bind(target!.id, ctx.now)
      .run();

    await audit(ctx, "probe.create", "probe_target", publicId, input);
    return { publicId };
  });
}

export async function updateProbeTarget(
  ctx: WriteContext,
  publicId: string,
  input: Partial<ProbeTargetInput>,
): Promise<void> {
  const row = await ctx.db
    .prepare(
      `SELECT t.id, c.page_id FROM probe_target t
         JOIN component c ON c.id = t.component_id
        WHERE t.public_id = ?1`,
    )
    .bind(publicId)
    .first<{ id: number; page_id: number }>();
  if (!row) throw new ValidationError(`no probe target with public id ${publicId}`, "probePublicId");
  const slug = await slugOfPage(ctx.db, row.page_id);

  await withPublish(ctx, slug, async () => {
    await ctx.db
      .prepare(
        `UPDATE probe_target
            SET url                = COALESCE(?2, url),
                method             = COALESCE(?3, method),
                severity           = COALESCE(?4, severity),
                expected_status    = COALESCE(?5, expected_status),
                timeout_ms         = COALESCE(?6, timeout_ms),
                interval_seconds   = COALESCE(?7, interval_seconds),
                failure_threshold  = COALESCE(?8, failure_threshold),
                recovery_threshold = COALESCE(?9, recovery_threshold),
                enabled            = COALESCE(?10, enabled),
                updated_at         = ?11
          WHERE id = ?1`,
      )
      .bind(
        row.id,
        input.url ?? null,
        input.method ?? null,
        input.severity ?? null,
        input.expectedStatus ?? null,
        input.timeoutMs ?? null,
        input.intervalSeconds ?? null,
        input.failureThreshold ?? null,
        input.recoveryThreshold ?? null,
        input.enabled === undefined ? null : input.enabled ? 1 : 0,
        ctx.now,
      )
      .run();

    await audit(ctx, "probe.update", "probe_target", publicId, input);
  });
}

export async function deleteProbeTarget(ctx: WriteContext, publicId: string): Promise<void> {
  const row = await ctx.db
    .prepare(
      `SELECT t.id, c.page_id FROM probe_target t
         JOIN component c ON c.id = t.component_id
        WHERE t.public_id = ?1`,
    )
    .bind(publicId)
    .first<{ id: number; page_id: number }>();
  if (!row) throw new ValidationError(`no probe target with public id ${publicId}`, "probePublicId");
  const slug = await slugOfPage(ctx.db, row.page_id);

  await withPublish(ctx, slug, async () => {
    // Impacts that this target opened are kept: `impact.probe_target_id` is
    // ON DELETE SET NULL, so the recorded downtime survives the deletion of the
    // thing that measured it. Deleting a probe must not erase history.
    await ctx.db.prepare("DELETE FROM probe_target WHERE id = ?1").bind(row.id).run();
    await audit(ctx, "probe.delete", "probe_target", publicId, null);
  });
}

// ---------------------------------------------------------------------------

async function slugOfPage(db: D1Database, pageId: number): Promise<string> {
  const row = await db.prepare("SELECT slug FROM page WHERE id = ?1").bind(pageId).first<{ slug: string }>();
  if (!row) throw new ValidationError(`no page with id ${pageId}`);
  return row.slug;
}

export { isFaultSeverity };
