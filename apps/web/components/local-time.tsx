"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { isoSeconds } from "@/lib/format";

type Mode = "datetime" | "date" | "relative";

/**
 * A timestamp rendered in the visitor's own time zone.
 *
 * The server cannot know the visitor's zone, so a component that formatted with
 * `toLocaleString()` would produce markup that disagrees with the client's first
 * render and React would report a hydration mismatch. Two things avoid that:
 *
 *   1. The pre-hydration text is built by slicing the ISO string. No `Intl`, so
 *      Node's ICU and the browser's cannot disagree about it either.
 *   2. The zone-aware text is only produced after mount, which makes it an
 *      ordinary re-render rather than a hydration difference.
 *
 * The cost is a brief flash from "2026-10-15 09:00 UTC" to the local equivalent.
 * The alternative — rendering the server's zone and never correcting it — is a
 * status page that shows the wrong hour to everyone outside it.
 */
export function LocalTime({
  epochSeconds,
  mode = "datetime",
  className,
}: {
  epochSeconds: number;
  mode?: Mode;
  className?: string;
}) {
  const locale = useLocale();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const iso = isoSeconds(epochSeconds);
  const utcText = mode === "date" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

  const date = new Date(epochSeconds * 1000);
  const absolute = (options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat(locale, options).format(date);

  const localText =
    mode === "relative"
      ? relativeText(epochSeconds, locale)
      : mode === "date"
        ? absolute({ dateStyle: "medium" })
        : absolute({ dateStyle: "medium", timeStyle: "short" });

  return (
    <time className={className} dateTime={iso} title={`${utcText} · ${absolute({ dateStyle: "full", timeStyle: "long" })}`}>
      {mounted ? localText : utcText}
    </time>
  );
}

/**
 * "3 minutes ago", "in 2 hours".
 *
 * `Intl.RelativeTimeFormat` rather than hand-built English, because the two
 * locales this app ships disagree about pluralisation and word order.
 */
function relativeText(epochSeconds: number, locale: string): string {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const deltaSeconds = epochSeconds - Math.floor(Date.now() / 1000);
  const absoluteSeconds = Math.abs(deltaSeconds);

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, seconds] of units) {
    if (absoluteSeconds >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return formatter.format(deltaSeconds, "second");
}
