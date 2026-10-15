/**
 * How each status is drawn.
 *
 * Colour is the fastest thing a reader takes from a status page, so the mapping
 * from status to colour lives in exactly one place. Two rules shape it:
 *
 *   * `unknown` is grey, never green. A component nobody can measure is not a
 *     healthy component, and painting it the same as `operational` is the single
 *     most common way a status page lies without any code being wrong.
 *   * `maintenance` is blue, which is a different hue from every fault colour, so
 *     a planned window cannot be mistaken for an outage at a glance.
 *
 * The classes are written out rather than built by interpolation because Tailwind
 * scans source text: `bg-${tone}-500` produces no CSS.
 */

import type { Status } from "@allclear/shared";

export interface StatusTone {
  /** Solid fill, for a small round indicator. */
  dot: string;
  /** Pill background and text, for the status label. */
  badge: string;
  /** Fill for a calendar day whose worst status was this. */
  bar: string;
  /** Ring colour for the "today" outline in the calendar. */
  ring: string;
}

const TONES: Readonly<Record<Status, StatusTone>> = {
  operational: {
    dot: "bg-emerald-500",
    badge: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
    bar: "bg-emerald-500 hover:bg-emerald-400",
    ring: "ring-emerald-600 dark:ring-emerald-400",
  },
  degraded_performance: {
    dot: "bg-amber-500",
    badge: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
    bar: "bg-amber-500 hover:bg-amber-400",
    ring: "ring-amber-600 dark:ring-amber-400",
  },
  partial_outage: {
    dot: "bg-orange-500",
    badge: "border-orange-200 bg-orange-50 text-orange-900 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200",
    bar: "bg-orange-500 hover:bg-orange-400",
    ring: "ring-orange-600 dark:ring-orange-400",
  },
  full_outage: {
    dot: "bg-red-500",
    badge: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
    bar: "bg-red-500 hover:bg-red-400",
    ring: "ring-red-600 dark:ring-red-400",
  },
  maintenance: {
    dot: "bg-sky-500",
    badge: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
    bar: "bg-sky-500 hover:bg-sky-400",
    ring: "ring-sky-600 dark:ring-sky-400",
  },
  unknown: {
    dot: "bg-slate-400",
    badge: "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
    bar: "bg-slate-300 hover:bg-slate-400 dark:bg-slate-700 dark:hover:bg-slate-600",
    ring: "ring-slate-500 dark:ring-slate-400",
  },
};

export function statusTone(status: Status): StatusTone {
  return TONES[status];
}

/**
 * A day with no measurement gets its own treatment rather than borrowing
 * `unknown`'s.
 *
 * They are different facts: `unknown` is a verdict about a component, whereas an
 * empty day means the rollup has no row for it at all — the component did not
 * exist yet, or the day predates retention. Drawing them identically would put a
 * grey bar and a blank bar side by side with no way to tell which is which.
 */
export const EMPTY_DAY_BAR =
  "bg-slate-100 hover:bg-slate-200 dark:bg-slate-800/60 dark:hover:bg-slate-700";

/**
 * The key of the translated label for a status.
 *
 * Returned as a key rather than as a string so that every caller goes through
 * `t()`, and so a status added to the union shows up here as a missing key
 * instead of as an untranslated English word on a Chinese page.
 */
export function statusLabelKey(status: Status): `values.${Status}` {
  return `values.${status}`;
}

/** The key for a change's own status, which has a different vocabulary. */
export function changeStatusLabelKey(status: string): string {
  return `changes.status.${status}`;
}
