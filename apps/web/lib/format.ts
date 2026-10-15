/**
 * Formatting helpers with no React and no translations.
 *
 * They are separated from the components because the two things that make a
 * status page hard to read are both here: a percentage printed with the wrong
 * precision, and a duration printed as a raw number of seconds. Everything in
 * this file returns a string that is correct in any locale, or a value the caller
 * formats itself — nothing here formats a *date*, because that has to happen with
 * the visitor's locale and time zone, which the server cannot know.
 */

/**
 * A percentage with a fixed precision, except that a perfect score is printed
 * without decimals.
 *
 * `99.999%` and `100%` are the same claim to a reader and only one of them looks
 * like a rounding artefact, so the fully-clamped value is special-cased rather
 * than left to `toFixed`.
 */
export function formatPercent(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const percent = value * 100;
  if (percent >= 100 - 0.5 * 10 ** -digits && percent <= 100) return "100%";
  return `${percent.toFixed(digits)}%`;
}

/**
 * A coarse human duration: "3d 4h", "2h 15m", "45m", "under a minute".
 *
 * Deliberately coarse. An incident lasting 90 seconds is not usefully described
 * as "1m 30s" on a status page, and seconds of precision invite a reader to
 * compare durations that were sampled at a probe interval.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return "under a minute";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/**
 * The last `count` UTC days ending with the day containing `now`, oldest first.
 *
 * UTC because that is the day boundary `daily_uptime` is keyed on; using the
 * visitor's zone here would put a day's bar in a different place for every
 * reader while the number inside it stayed the same.
 */
export function lastUtcDays(count: number, now: number): string[] {
  const todayStart = Math.floor(now / 86_400) * 86_400;
  const days: string[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    days.push(new Date((todayStart - index * 86_400) * 1000).toISOString().slice(0, 10));
  }
  return days;
}

/** `2026-10-15` -> `15 Oct`. Parsed as UTC so the label cannot shift by a day. */
export function shortUtcDate(day: string, locale: string): string {
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return day;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(parsed);
}

/** RFC 3339 with second precision, for a `<time dateTime>` attribute. */
export function isoSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
