"use client";

import { useState } from "react";
import type { Status } from "@allclear/shared";
import { useLocale, useTranslations } from "next-intl";
import { StatusBadge } from "@/components/status-badge";
import { formatDuration, formatPercent, shortUtcDate } from "@/lib/format";
import { EMPTY_DAY_BAR, statusTone } from "@/lib/status-display";
import { cn } from "@/lib/utils";

export interface DayCell {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** `null` when the rollup has no row for this day at all. */
  status: Status | null;
  uptime: number | null;
  coveredSeconds: number;
  unknownSeconds: number;
}

/** Monday first, which is how the calendar is laid out. */
const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

interface CalendarMonth {
  /** `YYYY-MM`. */
  key: string;
  /** 1–12, for the `calendar.months.*` key. */
  month: number;
  /** Whole weeks of seven slots, `null` for slots outside the window. */
  weeks: Array<Array<DayCell | null>>;
}

/**
 * Weekday index of a `YYYY-MM-DD` string, with Monday as 0.
 *
 * `Date.UTC` rather than `new Date(day)`: the latter parses a bare date as
 * *local* midnight, so the weekday it reports depends on the runtime's zone, and
 * the grid would shift by a column between the server render and the browser.
 * Nothing here reads a clock — the weekday of a fixed date is a fixed fact.
 */
function mondayIndex(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, date!)).getUTCDay();
  return (weekday + 6) % 7;
}

/**
 * Group the window into whole weeks per month.
 *
 * The leading and trailing blanks are not padding for looks: without them the
 * first day of a month would sit under whichever weekday happens to be first in
 * the array, and every date in the month would be labelled with the wrong day of
 * the week.
 */
function buildMonths(days: readonly DayCell[]): CalendarMonth[] {
  const byMonth = new Map<string, DayCell[]>();
  for (const cell of days) {
    const key = cell.day.slice(0, 7);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(cell);
    else byMonth.set(key, [cell]);
  }

  return [...byMonth.entries()].map(([key, cells]) => {
    const slots: Array<DayCell | null> = [
      ...Array.from({ length: mondayIndex(cells[0]!.day) }, () => null),
      ...cells,
    ];
    while (slots.length % 7 !== 0) slots.push(null);

    const weeks: Array<Array<DayCell | null>> = [];
    for (let index = 0; index < slots.length; index += 7) {
      weeks.push(slots.slice(index, index + 7));
    }
    return { key, month: Number(key.slice(5, 7)), weeks };
  });
}

/**
 * The 90-day history, as a bar strip, a month calendar, or a table.
 *
 * ## Why all three views, and why the table is not an afterthought
 *
 * The strip is the thing a visitor actually reads: it answers "has this been
 * flaky lately" in one glance. But it is also 90 targets of about two pixels
 * each, which is unusable by keyboard, unusable by a screen reader, and useless
 * when the question is "what exactly happened on the 3rd". The list view is the
 * same data at a size a person can read and a machine can parse, so it is a real
 * view rather than a fallback.
 *
 * The calendar sits between them. It is the only view that shows where the bad
 * days fell relative to a week — a strip of 90 bars cannot tell you the outages
 * were three consecutive weekends — and it is the one people arrive already
 * knowing how to read.
 *
 * The strip is not made wider to fix its smallness. Ninety days is the whole
 * point of it, and a version that fits the bars at a readable width is a version
 * that scrolls sideways, which is worse than small.
 *
 * ## Why the days arrive pre-filled
 *
 * `days` already covers the full window with explicit `null`s for days the
 * snapshot has no row for. Filling the gaps here instead would mean this
 * component deciding what "no data" means, and it would have to agree with the
 * server about where the window starts.
 */
export function UptimeHistory({
  days,
  windowUptime,
}: {
  days: DayCell[];
  windowUptime: number | null;
}) {
  const t = useTranslations("status");
  const locale = useLocale();
  const [view, setView] = useState<"chart" | "calendar" | "list">("chart");

  const statusLabel = (status: Status): string => t(`values.${status}`);

  const dayTitle = (cell: DayCell): string => {
    const date = shortUtcDate(cell.day, locale);
    if (cell.status === null || cell.uptime === null) return t("calendar.dayNoData", { date });
    return t("calendar.dayLabel", {
      date,
      status: statusLabel(cell.status),
      uptime: formatPercent(cell.uptime),
    });
  };

  const months = buildMonths(days);
  // The last entry in the window is today, by construction on the server.
  const today = days.length > 0 ? days[days.length - 1]!.day : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {t("calendar.uptimeWindow", { days: days.length })}{" "}
          <span className="font-medium text-slate-900 dark:text-slate-100">
            {formatPercent(windowUptime)}
          </span>
        </p>

        {/* A radiogroup rather than three buttons: the views are one choice, and
            a screen reader should hear "chart, selected" not "chart button,
            list button, calendar button". */}
        <div
          className="inline-flex rounded-md border border-slate-200 p-0.5 dark:border-slate-700"
          role="radiogroup"
          aria-label={t("calendar.viewLabel")}
        >
          {(["chart", "calendar", "list"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={view === option}
              onClick={() => setView(option)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                view === option
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
              )}
            >
              {option === "chart"
                ? t("calendar.viewChart")
                : option === "calendar"
                  ? t("calendar.viewCalendar")
                  : t("calendar.viewList")}
            </button>
          ))}
        </div>
      </div>

      {view === "chart" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-end gap-px" data-testid="uptime-strip">
            {days.map((cell) => (
              <span
                key={cell.day}
                // `flex-1` with a floor rather than a fixed width: the strip
                // spans the container at any size, and 90 bars never overflow.
                className={cn(
                  "h-8 min-w-[2px] flex-1 rounded-[2px] transition-colors",
                  cell.status === null ? EMPTY_DAY_BAR : statusTone(cell.status).bar,
                )}
                title={dayTitle(cell)}
                aria-label={dayTitle(cell)}
              />
            ))}
          </div>
          <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>{t("calendar.oldest", { days: days.length })}</span>
            <span>{t("calendar.today")}</span>
          </div>
        </div>
      ) : view === "calendar" ? (
        <div className="flex flex-wrap gap-x-8 gap-y-5" data-testid="uptime-calendar">
          {months.map((month) => (
            <table key={month.key} className="border-collapse">
              <caption className="pb-1 text-left text-xs font-medium text-slate-600 dark:text-slate-300">
                {t(`calendar.months.${month.month}`)}
              </caption>
              <thead>
                <tr>
                  {WEEKDAY_KEYS.map((key) => (
                    <th
                      key={key}
                      scope="col"
                      className="w-9 pb-1 text-center text-[10px] font-normal text-slate-500 dark:text-slate-400"
                    >
                      {t(`calendar.weekdays.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {month.weeks.map((week, weekIndex) => (
                  <tr key={`${month.key}-w${weekIndex}`}>
                    {week.map((cell, dayIndex) => (
                      <td key={`${month.key}-w${weekIndex}-${dayIndex}`} className="p-0">
                        {cell === null ? (
                          // A slot before the window starts or after it ends. It
                          // has to occupy the cell or the weekday columns stop
                          // lining up, but it is not a day we have any opinion
                          // about, so it gets no title and no colour.
                          <span className="block h-9 w-9" aria-hidden />
                        ) : (
                          <span
                            className={cn(
                              "flex h-9 w-9 flex-col items-center justify-center gap-1 rounded-md",
                              cell.day === today &&
                                "ring-1 ring-slate-400 dark:ring-slate-500",
                            )}
                            title={dayTitle(cell)}
                            aria-label={dayTitle(cell)}
                          >
                            <span className="text-xs tabular-nums text-slate-700 dark:text-slate-300">
                              {Number(cell.day.slice(8, 10))}
                            </span>
                            {/* The colour lives in a dot rather than in the cell
                                fill. A 500-level fill behind a two-digit number
                                is around 2:1 contrast in light mode, which is
                                unreadable, and the lighter tints that would fix
                                it are too close together to tell apart at this
                                size. */}
                            <span
                              className={cn(
                                "h-1.5 w-1.5 rounded-full",
                                cell.status === null ? EMPTY_DAY_BAR : statusTone(cell.status).dot,
                              )}
                            />
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
          <p className="sr-only">{t("calendar.calendarCaption")}</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] border-collapse text-sm">
            <caption className="sr-only">{t("calendar.listCaption")}</caption>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:text-slate-400">
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t("calendar.columnDay")}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t("calendar.columnStatus")}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t("calendar.columnUptime")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("calendar.columnCoverage")}
                </th>
              </tr>
            </thead>
            <tbody>
              {days.map((cell) => (
                <tr
                  key={cell.day}
                  className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                >
                  <th scope="row" className="py-2 pr-3 text-left font-normal whitespace-nowrap">
                    {shortUtcDate(cell.day, locale)}
                  </th>
                  <td className="py-2 pr-3">
                    {cell.status === null ? (
                      <span className="text-slate-500 dark:text-slate-400">
                        {t("calendar.noData")}
                      </span>
                    ) : (
                      <StatusBadge status={cell.status} label={statusLabel(cell.status)} />
                    )}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{formatPercent(cell.uptime)}</td>
                  <td className="py-2 text-slate-600 tabular-nums dark:text-slate-400">
                    {formatDuration(cell.coveredSeconds)}
                    {cell.unknownSeconds > 0
                      ? ` · ${t("calendar.unmeasured", { duration: formatDuration(cell.unknownSeconds) })}`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
