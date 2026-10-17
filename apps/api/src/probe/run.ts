/**
 * The probe scheduler's execution path.
 *
 * One cron tick selects the targets that are due, probes each one, and feeds the
 * observation into the state machine in `transition.ts`. Everything interesting
 * about *correctness* lives in that state machine; this file is the part that
 * decides what to do with a target whose URL the SSRF guard refuses, which is the
 * one judgement call worth writing down.
 *
 * ## A rejected URL is not an outage
 *
 * If a target's URL fails validation — a scheme that is not http(s), a private
 * address, a port outside the allowlist — the service behind it may be perfectly
 * healthy. Feeding that into the state machine would open a public incident
 * caused by a typo in a configuration field, which is a false positive on the
 * most visible surface this project has.
 *
 * So a rejected target is *skipped*: nothing is written to `probe_result`, no
 * counter moves, and `next_check_at` is pushed forward so the target is not
 * retried in a tight loop. The component consequently loses coverage and derives
 * as `unknown` — which is the honest answer, because the system genuinely cannot
 * measure it. The rejection is logged with the reason so an operator can find it.
 *
 * ## Why the state machine runs with a fresh id per attempt
 *
 * `applyProbeObservation` is idempotent on `resultId`, and that id is generated
 * once here and passed in. Regenerating it inside the retry loop would defeat the
 * whole mechanism: a batch that committed but whose response was lost would be
 * replayed as a *new* observation and counted twice.
 */

import { MAX_ENABLED_TARGETS } from "@allclear/shared";

import { applyProbeObservation } from "./transition";
import { assertProbeUrlAllowed, fetchProbe, ProbeUrlRejected } from "../lib/ssrf";
import { ulid } from "../lib/ulid";

// Re-exported rather than only imported. The value now lives in
// `@allclear/shared` because the console has to enforce the same cap, and it was
// defined here first — so this keeps the existing importers working while making
// the shared copy the single source. See `shared/src/limits.ts`.
export { MAX_ENABLED_TARGETS };

export interface ProbeRunOptions {
  now?: number;
  /** Override the fetch implementation. Tests use this. */
  fetchImpl?: typeof fetch;
  maxTargetsPerRun?: number;
  newId?: () => string;
}

export interface ProbeRunSummary {
  due: number;
  probed: number;
  skippedConfiguration: number;
  applied: number;
  opened: number;
  closed: number;
  replay: number;
  stale: number;
  unconfigured: number;
  anomalies: string[];
  /** Page ids whose snapshots must be rebuilt after this run. */
  affectedPageIds: number[];
  /**
   * Pages where a target actually opened or closed an impact.
   *
   * Kept separate from `affectedPageIds` for transition reporting. Every applied
   * observation changes public freshness and coverage evidence, so rollups and
   * snapshot publication use the affected component/page lists even when no
   * impact opens or closes. Page ids are deduplicated for one publication per run.
   */
  transitionedPageIds: number[];
  /** Component ids whose daily uptime must be recomputed after this run. */
  affectedComponentIds: number[];
  transitionedComponentIds: number[];
  skippedReason?: string;
}

interface DueTargetRow {
  id: number;
  component_id: number;
  page_id: number;
  url: string;
  method: "GET" | "HEAD";
  expected_status: number;
  timeout_ms: number;
  interval_seconds: number;
}

const SELECT_DUE_SQL = `
SELECT t.id, t.component_id, c.page_id, t.url, t.method, t.expected_status,
       t.timeout_ms, t.interval_seconds
  FROM probe_target t
  JOIN component c ON c.id = t.component_id
 WHERE t.enabled = 1
   AND t.next_check_at <= ?1
 ORDER BY t.next_check_at, t.id
 LIMIT ?2
`;

/** Push a skipped target's next attempt forward without touching its state. */
const ADVANCE_NEXT_CHECK_SQL = `
UPDATE probe_target SET next_check_at = ?2, updated_at = ?3 WHERE id = ?1
`;

/**
 * Run one scheduling pass.
 *
 * The return value is a report rather than a boolean on purpose: a cron run that
 * silently does nothing and a cron run that probed twenty targets and opened
 * three incidents should not look the same in the logs.
 */
export async function runProbes(
  db: D1Database,
  options: ProbeRunOptions = {},
): Promise<ProbeRunSummary> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const newId = options.newId ?? (() => ulid());
  const limit = options.maxTargetsPerRun ?? MAX_ENABLED_TARGETS;

  const summary: ProbeRunSummary = {
    due: 0,
    probed: 0,
    skippedConfiguration: 0,
    applied: 0,
    opened: 0,
    closed: 0,
    replay: 0,
    stale: 0,
    unconfigured: 0,
    anomalies: [],
    affectedPageIds: [],
    transitionedPageIds: [],
    affectedComponentIds: [],
    transitionedComponentIds: [],
  };

  const { results: due } = await db
    .prepare(SELECT_DUE_SQL)
    .bind(now, limit)
    .all<DueTargetRow>();

  summary.due = due.length;
  if (due.length === 0) return summary;

  const pages = new Set<number>();
  const transitionedPages = new Set<number>();
  const components = new Set<number>();
  const transitionedComponents = new Set<number>();

  for (const target of due) {
    // The URL was validated when it was configured, but it is validated again
    // here: configuration can be edited, and a check that only runs at write
    // time is a check that can be bypassed by a write path someone adds later.
    const rejection = preValidate(target.url);

    if (rejection !== null) {
      summary.skippedConfiguration += 1;
      const nextCheckAt = now + target.interval_seconds;
      await db
        .prepare(ADVANCE_NEXT_CHECK_SQL)
        .bind(target.id, nextCheckAt, now)
        .run();
      console.warn("probe target skipped: URL refused", {
        targetId: target.id,
        reason: rejection,
      });
      continue;
    }

    const result = await fetchProbe(target.url, {
      method: target.method,
      expectedStatus: target.expected_status,
      timeoutMs: target.timeout_ms,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    summary.probed += 1;

    const observedAt = now;
    const outcome = await applyProbeObservation(
      db,
      {
        resultId: newId(),
        targetId: target.id,
        observedAt,
        ok: result.ok,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        error: result.error,
      },
      { newId },
    );

    switch (outcome.kind) {
      case "applied":
        summary.applied += 1;
        if (outcome.transition === "opened") summary.opened += 1;
        if (outcome.transition === "closed") summary.closed += 1;
        if (outcome.transition !== "none") {
          transitionedPages.add(target.page_id);
          transitionedComponents.add(target.component_id);
        }
        pages.add(target.page_id);
        components.add(target.component_id);
        break;
      case "replay":
        summary.replay += 1;
        break;
      case "stale":
        summary.stale += 1;
        break;
      case "unconfigured":
        summary.unconfigured += 1;
        console.error("probe target has no state row", { targetId: target.id });
        break;
      case "anomaly":
        summary.anomalies.push(outcome.detail);
        console.error("probe transition anomaly", { targetId: target.id, detail: outcome.detail });
        break;
    }
  }

  summary.affectedPageIds = [...pages];
  summary.transitionedPageIds = [...transitionedPages];
  summary.affectedComponentIds = [...components];
  summary.transitionedComponentIds = [...transitionedComponents];
  return summary;
}

/**
 * Run the URL guard without performing a request.
 *
 * `fetchProbe` performs the same validation internally, so this is not a second
 * line of defence against a bug — it exists so that the *reason* for a rejection
 * can be reported, and the target's schedule advanced, without doing the work of
 * a request that is going to be refused. `assertProbeUrlAllowed` remains the only
 * implementation of the rule.
 */
function preValidate(url: string): string | null {
  try {
    assertProbeUrlAllowed(url);
    return null;
  } catch (error) {
    return error instanceof ProbeUrlRejected ? error.reason : String(error);
  }
}
