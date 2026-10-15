import type { Status } from "@allclear/shared";
import { cn } from "@/lib/utils";
import { statusTone } from "@/lib/status-display";

/**
 * Presentational only: the translated label arrives as a prop.
 *
 * It is deliberately not a `useTranslations` component. The same badge is drawn
 * from server components (which translate with `getTranslations`) and from the
 * client calendar (which translates with `useTranslations`), and a component that
 * fetches its own strings would have to be one or the other. Passing the label
 * keeps a single implementation of the shape and the colour.
 */
export function StatusBadge({
  status,
  label,
  className,
}: {
  status: Status;
  label: string;
  className?: string;
}) {
  const tone = statusTone(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium",
        tone.badge,
        className,
      )}
      data-status={status}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} aria-hidden />
      {label}
    </span>
  );
}

/** The dot on its own, for dense lists where a pill per row is too loud. */
export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", statusTone(status).dot, className)}
      data-status={status}
      aria-hidden
    />
  );
}
