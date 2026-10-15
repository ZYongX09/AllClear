import type { SnapshotChange } from "@allclear/shared";
import { getTranslations } from "next-intl/server";
import { LocalTime } from "@/components/local-time";
import { statusTone } from "@/lib/status-display";
import { cn } from "@/lib/utils";

/**
 * The incident and maintenance history.
 *
 * ## `<details>` rather than a client-side accordion
 *
 * Every entry already carries its full timeline, so the only state is "is this
 * one open". A native disclosure element gives that state to the browser: it
 * works before hydration, it is keyboard-accessible without any code, and
 * Ctrl-F can find text inside a closed entry because the content is in the DOM.
 * A React accordion would have to reimplement all three, and would ship
 * JavaScript to do it.
 *
 * The markup is restricted to what `<summary>` allows — phrasing content and
 * heading content — so the title is a real `<h3>` and everything else is a
 * `<span>` with block display. A `<div>` or `<p>` in there would render, but it
 * is invalid HTML and the browser is free to restructure it.
 *
 * ## The ordering is the API's, not this component's
 *
 * Entries arrive newest first. Re-sorting here would be a second definition of
 * "newest" — the API sorts on `starts_at` with open changes pinned — and the two
 * would drift.
 *
 * ## Colour carries severity, text carries workflow state
 *
 * A change has two independent facts: how bad it is (`severity`) and where it is
 * in its lifecycle (`status`). They are drawn separately — a coloured pill for
 * the severity, a neutral one for the status — because "resolved" on a
 * full outage and "resolved" on a note about a slow dashboard are not the same
 * entry, and a single pill cannot say both.
 */
export async function IncidentTimeline({
  changes,
  componentNames,
}: {
  changes: SnapshotChange[];
  /** Public id to display name, for the affected-components line. */
  componentNames: Map<string, string>;
}) {
  const t = await getTranslations("status");

  if (changes.length === 0) {
    return (
      <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="timeline-empty">
        {t("changes.none")}
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-4" data-testid="timeline">
      {changes.map((change) => {
        const affected = change.componentPublicIds
          .map((id) => componentNames.get(id))
          .filter((name): name is string => name !== undefined);
        const hasUpdates = change.updates.length > 0;
        const ongoing = change.endsAt === null;

        return (
          <li
            key={change.publicId}
            id={`change-${change.publicId}`}
            // The permalink target is an entry that may sit below a sticky
            // header once one exists; `scroll-mt` keeps the heading visible when
            // the fragment is followed rather than scrolled to the top edge.
            className="scroll-mt-24 rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
            data-kind={change.kind}
            data-status={change.status}
          >
            {/* `open` on an ongoing entry: the reader most wants the detail for
                the incident that has not ended. A closed one is history. */}
            <details open={ongoing} className="group">
              <summary
                className={cn(
                  "flex cursor-pointer flex-col gap-2 p-4",
                  // `display: flex` already suppresses the marker; these two
                  // cover engines that keep drawing one.
                  "[&::-webkit-details-marker]:hidden [&::marker]:content-['']",
                )}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
                      change.kind === "maintenance"
                        ? "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200"
                        : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
                    )}
                  >
                    {change.kind === "maintenance"
                      ? t("changes.kind.maintenance")
                      : t("changes.kind.incident")}
                  </span>

                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    {t(`changes.status.${change.status}`)}
                  </span>

                  {change.severity !== "none" ? (
                    <span
                      className={cn(
                        "rounded border px-2 py-0.5 text-xs font-medium",
                        statusTone(change.severity).badge,
                      )}
                    >
                      {t(`values.${change.severity}`)}
                    </span>
                  ) : null}

                  {ongoing ? (
                    <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
                      {t("changes.ongoing")}
                    </span>
                  ) : null}

                  {hasUpdates ? (
                    <span className="ml-auto text-xs text-slate-500 group-open:hidden dark:text-slate-400">
                      {t("changes.showUpdates", { count: change.updates.length })}
                    </span>
                  ) : null}

                  {/* A separate anchor rather than making the title one: inside
                      a `<summary>` a link would swallow the click that expands
                      the entry, and "click the title to read the timeline" is
                      the more common intent. `ml-auto` is on the updates hint,
                      so this sits next to it rather than at the far edge. */}
                  <a
                    href={`#change-${change.publicId}`}
                    aria-label={t("changes.permalink")}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200",
                      hasUpdates ? "" : "ml-auto",
                    )}
                  >
                    #
                  </a>
                </span>

                <h3 className="text-base font-medium">{change.title}</h3>

                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  <LocalTime epochSeconds={change.startsAt} />
                  {change.endsAt !== null ? (
                    <>
                      {" – "}
                      <LocalTime epochSeconds={change.endsAt} />
                    </>
                  ) : null}
                  {affected.length > 0 ? ` · ${affected.join(", ")}` : ""}
                </span>
              </summary>

              <div className="flex flex-col gap-4 border-t border-slate-100 px-4 py-4 dark:border-slate-800">
                {change.body ? (
                  <p className="text-sm leading-6 whitespace-pre-line text-slate-700 dark:text-slate-300">
                    {change.body}
                  </p>
                ) : null}

                {hasUpdates ? (
                  <ol className="flex flex-col gap-4 border-l border-slate-200 pl-4 dark:border-slate-700">
                    {change.updates.map((update) => (
                      <li key={update.publicId} className="flex flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span className="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                            {t(`changes.status.${update.status}`)}
                          </span>
                          <LocalTime epochSeconds={update.createdAt} />
                        </span>
                        <p className="text-sm leading-6 whitespace-pre-line text-slate-700 dark:text-slate-300">
                          {update.body}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}
