"use client";

import { useEffect, useId, useState } from "react";

/**
 * A `datetime-local` input that submits epoch seconds.
 *
 * ## Why the conversion happens here
 *
 * The API speaks epoch seconds because that is what the database stores and what
 * makes a timestamp unambiguous. `<input type="datetime-local">` speaks a
 * timezone-less local string because that is what a person can type. Something
 * has to bridge the two, and the only place that knows the operator's timezone is
 * the browser — a server that converted the string would have to guess, and
 * guessing wrong would silently shift an incident's start time by hours.
 *
 * So the visible input is a client-side convenience and the hidden input is the
 * real submission. `name` is on the hidden field only; the visible one is
 * deliberately unnamed so it cannot be picked up by mistake if the hidden field
 * is ever removed.
 *
 * ## Why the timezone is printed
 *
 * `2026-10-15T09:00` means a different instant to two operators in different
 * places. Showing which zone the value is being read in is the difference
 * between a form that is correct and a form that is correct and verifiable.
 * It is rendered after mount rather than during it, because the server has no
 * timezone to render and a mismatch there would be a hydration error.
 */
export function DateTimeField({
  name,
  label,
  defaultValue,
  required = false,
  hint,
}: {
  name: string;
  label: string;
  /** Epoch seconds. Rendered in the browser's zone, which is the point. */
  defaultValue?: number | null;
  required?: boolean;
  hint?: string;
}) {
  const [value, setValue] = useState(() => toLocalInput(defaultValue ?? null));
  const [zone, setZone] = useState<string | null>(null);
  // Unique per instance, so two fields on one page cannot share an id — see the
  // same note in `admin-form.tsx`.
  const id = useId();

  useEffect(() => {
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  const epoch = value === "" ? "" : String(Math.floor(new Date(value).getTime() / 1000));

  return (
    <div className="flex min-w-56 flex-1 flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-slate-600 dark:text-slate-400">
        {label}
        {zone ? <span className="ml-1 font-normal opacity-70">({zone})</span> : null}
      </label>

      <input
        id={id}
        type="datetime-local"
        value={value}
        required={required}
        onChange={(event) => setValue(event.target.value)}
        className="h-9 rounded-md border border-slate-300 bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-slate-700"
      />
      {/* The submitted value. Empty means "not supplied", which the API reads as
          absent rather than as zero — the difference between "starts now" and
          "started in 1970". */}
      <input type="hidden" name={name} value={epoch} data-field={name} />

      {hint ? <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
    </div>
  );
}

/**
 * Epoch seconds to the `YYYY-MM-DDTHH:mm` a `datetime-local` expects.
 *
 * Built from the local getters rather than from `toISOString()`, which returns
 * UTC and would show an operator in UTC+8 the previous day's date for anything
 * before 08:00.
 */
function toLocalInput(epoch: number | null): string {
  if (epoch === null || epoch <= 0) return "";
  const date = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
