import { cache } from "react";
import type { Metadata } from "next";
import type { Snapshot, SnapshotComponent, SnapshotDay, SnapshotSource, Status } from "@allclear/shared";
import {
  aggregateDayUptime,
  aggregateStatus,
  deriveSnapshotComponent,
  isFaultSeverity,
} from "@allclear/shared";
import { getTranslations } from "next-intl/server";
import { HashTargetOpener } from "@/components/hash-target";
import { IncidentTimeline } from "@/components/incident-timeline";
import { LocalTime } from "@/components/local-time";
import { SiteHeader } from "@/components/site-header";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { SubscribeForm } from "@/components/subscribe-form";
import { UptimeHistory, type DayCell } from "@/components/uptime-history";
import { readStatus } from "@/lib/allclear-api";
import { formatDuration, formatPercent, lastUtcDays } from "@/lib/format";
import { statusTone } from "@/lib/status-display";
import { cn } from "@/lib/utils";

/**
 * The history window, in days. Matches what the API materialises into
 * `daily_uptime`; asking for more would render a wall of empty bars.
 */
const HISTORY_DAYS = 90;

/**
 * Rendered per request.
 *
 * Not an optimisation setting so much as a correctness one: this page reads
 * `Date.now()` to derive status, and a cached HTML document would keep claiming
 * "operational" after an incident opened. The API's own response is `no-store`
 * for the same reason. The API's short-lived summary cache is the caching layer;
 * the page must not add another freshness window.
 */
export const dynamic = "force-dynamic";

/**
 * One read per request, shared by `generateMetadata` and the page.
 *
 * Both need the snapshot and Next renders them independently, so without this
 * every page view would make two Service Binding calls for one document.
 */
const readOnce = cache((slug: string) => readStatus(slug));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations("status");
  const result = await readOnce(slug);

  if (!result.ok || result.data.snapshot === null) {
    // `noindex` on the error view: a transient outage should not teach a search
    // engine that this URL is about "status page unavailable".
    return { title: t("meta.unavailableTitle", { slug }), robots: { index: false } };
  }

  return {
    title: t("meta.pageTitle", { name: result.data.snapshot.name }),
    description: t("meta.pageDescription", { name: result.data.snapshot.name }),
  };
}

export default async function StatusPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await readOnce(slug);

  if (!result.ok) {
    // The Service Binding itself failed. Nothing about the page is known, so
    // there is nothing honest to render beyond "we could not ask".
    console.error("status read failed", { slug, error: result.error });
    return <Unavailable slug={slug} reason="unreachable" />;
  }

  const { snapshot, source, stale, ageSeconds, aged, errors } = result.data;
  if (snapshot === null) {
    // `source: none` covers both "no such page" and "every layer failed". The
    // errors say which, and they are logged rather than rendered: they are D1
    // and KV messages, and a status page is not the place to publish the shape
    // of its own storage layer.
    console.error("status unavailable", { slug, source, errors });
    return <Unavailable slug={slug} reason="none" />;
  }

  return (
    <StatusDocument
      snapshot={snapshot}
      source={source}
      stale={stale}
      ageSeconds={ageSeconds}
      aged={aged}
    />
  );
}

async function StatusDocument({
  snapshot,
  source,
  stale,
  ageSeconds,
  aged,
}: {
  snapshot: Snapshot;
  source: SnapshotSource;
  stale: boolean;
  ageSeconds: number | null;
  aged: boolean;
}) {
  const t = await getTranslations("status");

  // One clock reading for the whole render. Reading `Date.now()` per component
  // would let two components straddle a boundary — a maintenance window ending
  // mid-render — and disagree about the same instant.
  const now = Math.floor(Date.now() / 1000);
  const window = lastUtcDays(HISTORY_DAYS, now);

  const derived = new Map(
    snapshot.components.map((component) => [
      component.publicId,
      deriveSnapshotComponent(component, now),
    ]),
  );
  const overall = aggregateStatus([...derived.values()].map((entry) => entry.status));
  const affected = [...derived.values()].filter(
    (entry) => isFaultSeverity(entry.status) || entry.status === "maintenance",
  ).length;

  const componentNames = new Map(snapshot.components.map((c) => [c.publicId, c.name]));
  const bySection = groupBySection(snapshot);
  const overallTone = statusTone(overall);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <SiteHeader />

      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-10">
        <div className="flex flex-col gap-4">
          <h1 className="text-3xl font-semibold tracking-tight">{snapshot.name}</h1>

          <div
            className={cn(
              "flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3",
              overallTone.badge,
            )}
            data-testid="overall-status"
            data-status={overall}
          >
            <span className={cn("h-2.5 w-2.5 rounded-full", overallTone.dot)} aria-hidden />
            <span className="text-base font-medium">{t(`values.${overall}`)}</span>
            {affected > 0 ? (
              <span className="text-sm opacity-80">
                {t("summary.affected", { count: affected, total: snapshot.components.length })}
              </span>
            ) : null}
          </div>

          {overall === "unknown" ? (
            <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
              {t("summary.unknownExplanation")}
            </p>
          ) : null}

          {stale ? (
            <p
              className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
              data-testid="stale-warning"
            >
              {t("meta.stale")}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500 dark:text-slate-400">
            <span>
              {t("meta.lastUpdated")} <LocalTime epochSeconds={snapshot.generatedAt} mode="relative" />
            </span>
            <span data-testid="history-updated">
              {snapshot.historyComputedAt == null ? (
                t("meta.historyUnknown")
              ) : (
                <>{t("meta.historyUpdated")} <LocalTime epochSeconds={snapshot.historyComputedAt} mode="relative" /></>
              )}
            </span>
            {aged && ageSeconds !== null ? (
              <span data-testid="aged-note">{t("meta.aged", { age: formatDuration(ageSeconds) })}</span>
            ) : null}
            <span data-testid="read-source" data-source={source}>
              {t(`meta.sources.${source}`)}
            </span>
            <span>{t("meta.version", { version: snapshot.snapshotVersion })}</span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <SubscribeForm
              slug={snapshot.slug}
              components={snapshot.components.map((c) => ({ publicId: c.publicId, name: c.name }))}
            />
            <a
              className="text-sm font-medium text-slate-600 underline underline-offset-4 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
              href={`/status/${encodeURIComponent(snapshot.slug)}/feed.xml`}
            >
              {t("meta.feed")}
            </a>
            <a
              className="text-sm font-medium text-slate-600 underline underline-offset-4 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
              href={`/status/${encodeURIComponent(snapshot.slug)}/snapshot.json`}
            >
              {t("meta.json")}
            </a>
          </div>
        </div>

        {snapshot.components.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="components-empty">
            {t("components.empty")}
          </p>
        ) : (
          <section className="flex flex-col gap-6" data-testid="components">
            <h2 className="sr-only">{t("components.heading")}</h2>
            {bySection.map(({ section, components }) => (
              <div key={section?.publicId ?? "unsectioned"} className="flex flex-col gap-3">
                {section ? (
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                      {section.name}
                    </h3>
                    {section.description ? (
                      <p className="text-sm text-slate-600 dark:text-slate-400">
                        {section.description}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <ul className="flex flex-col gap-3">
                  {components.map((component) => {
                    const entry = derived.get(component.publicId)!;
                    return (
                      <li key={component.publicId}>
                        <ComponentRow
                          component={component}
                          status={entry.status}
                          reason={entry.reason}
                          window={window}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        )}

        <section className="flex flex-col gap-4" data-testid="changes">
          <h2 className="text-lg font-semibold tracking-tight">{t("changes.heading")}</h2>
          <IncidentTimeline changes={snapshot.changes} componentNames={componentNames} />
        </section>

        <footer className="border-t border-slate-200 pt-6 text-xs leading-6 text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <p>{t("meta.footer")}</p>
        </footer>
      </main>
      <HashTargetOpener />
    </div>
  );
}

/**
 * One component: a summary line, and the history behind a disclosure.
 *
 * The summary is what a reader scanning the page needs — name, colour, and the
 * 90-day number. The bar strip is 90 two-pixel targets, so it is worth seeing
 * once you care about one component and worth hiding while you are reading the
 * other seven.
 *
 * The markup inside `<summary>` is restricted to phrasing and heading content, so
 * everything there is a `<span>` with block display.
 */
async function ComponentRow({
  component,
  status,
  reason,
  window,
}: {
  component: SnapshotComponent;
  status: Status;
  reason: string;
  window: string[];
}) {
  const t = await getTranslations("status");

  const cells = buildWindow(component.days, window);

  // Computed from the same cells the strip draws, not from `component.days`.
  // The stored rows may reach further back than the window, and a headline
  // percentage that disagrees with the bars directly under it is worse than no
  // percentage at all.
  const measured: SnapshotDay[] = [];
  for (const cell of cells) {
    if (cell.status === null) continue;
    measured.push({
      day: cell.day,
      status: cell.status,
      uptime: cell.uptime,
      coveredSeconds: cell.coveredSeconds,
      unknownSeconds: cell.unknownSeconds,
    });
  }
  const windowUptime = aggregateDayUptime(measured);

  return (
    <details
      className="group rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
      data-component={component.publicId}
      data-status={status}
    >
      <summary
        className={cn(
          "flex cursor-pointer flex-wrap items-center gap-3 p-4",
          "[&::-webkit-details-marker]:hidden [&::marker]:content-['']",
        )}
      >
        <StatusDot status={status} />

        <span className="flex min-w-40 flex-1 flex-col">
          <span className="text-sm font-medium">{component.name}</span>
          {component.description ? (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {component.description}
            </span>
          ) : null}
        </span>

        <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
          {t("components.windowUptime", { days: window.length })}{" "}
          <span className="font-medium text-slate-700 dark:text-slate-300">
            {formatPercent(windowUptime)}
          </span>
        </span>

        <StatusBadge status={status} label={t(`values.${status}`)} />
      </summary>

      <div className="flex flex-col gap-4 border-t border-slate-100 px-4 py-4 dark:border-slate-800">
        <UptimeHistory days={cells} windowUptime={windowUptime} />

        <p className="text-xs leading-6 text-slate-500 dark:text-slate-400">
          {component.probe === null ? (
            <span data-testid="monitoring-note" data-reason="monitoring_uncovered">
              {t("components.uncovered")}
            </span>
          ) : (
            <span data-testid="monitoring-note" data-reason={reason}>
              {t("components.lastChecked")}{" "}
              <LocalTime epochSeconds={component.probe.lastProbeAt} mode="relative" />.{" "}
              {reason === "monitoring_stale"
                ? t("components.stale")
                : reason === "monitoring_failing_unclassified"
                  ? t("components.unclassified")
                  : null}
            </span>
          )}
        </p>

        {component.availableSince > 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t("components.availableSince")}{" "}
            <LocalTime epochSeconds={component.availableSince} mode="date" />
          </p>
        ) : null}
      </div>
    </details>
  );
}

/**
 * Line the component's stored days up with the window.
 *
 * Days the component has no row for become explicit `null` cells rather than
 * being omitted, so the strip's geometry means something: a gap in the middle is
 * a day nobody measured, and a short strip on the left is a component that did
 * not exist yet. Collapsing both into "no bar" would make them indistinguishable.
 */
function buildWindow(days: readonly SnapshotDay[], window: readonly string[]): DayCell[] {
  const byDay = new Map(days.map((day) => [day.day, day]));
  return window.map((day) => {
    const stored = byDay.get(day);
    if (!stored) {
      return { day, status: null, uptime: null, coveredSeconds: 0, unknownSeconds: 0 };
    }
    return {
      day,
      status: stored.status,
      uptime: stored.uptime,
      coveredSeconds: stored.coveredSeconds,
      unknownSeconds: stored.unknownSeconds,
    };
  });
}

/**
 * Group components under their sections, in the order the snapshot gives.
 *
 * A component with no section is not an error — the column is nullable so that a
 * single-component page needs no section — so it is collected into one unlabelled
 * group rather than dropped. Dropping it would make a component silently
 * disappear from the page while still being counted in the overall status.
 */
function groupBySection(snapshot: Snapshot): Array<{
  section: Snapshot["sections"][number] | null;
  components: SnapshotComponent[];
}> {
  const ordered = [...snapshot.sections].sort((a, b) => a.orderId - b.orderId);
  const groups: Array<{
    section: Snapshot["sections"][number] | null;
    components: SnapshotComponent[];
  }> = ordered.map((section) => ({
    section,
    components: snapshot.components
      .filter((component) => component.sectionPublicId === section.publicId)
      .sort((a, b) => a.orderId - b.orderId),
  }));

  const unsectioned = snapshot.components
    .filter((component) => component.sectionPublicId === null)
    .sort((a, b) => a.orderId - b.orderId);
  if (unsectioned.length > 0) groups.push({ section: null, components: unsectioned });

  return groups.filter((group) => group.components.length > 0);
}

async function Unavailable({ slug, reason }: { slug: string; reason: "none" | "unreachable" }) {
  const t = await getTranslations("status");

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <SiteHeader />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-16" data-testid="unavailable">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("meta.unavailableTitle", { slug })}
        </h1>
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
          {reason === "unreachable" ? t("meta.unreachableBody") : t("meta.unavailableBody")}
        </p>
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
          {t("meta.unavailableHint")}
        </p>
      </main>
    </div>
  );
}
