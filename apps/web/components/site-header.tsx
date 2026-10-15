import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LocaleSwitch } from "@/components/locale-switch";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * The shared masthead: wordmark, theme control, locale control.
 *
 * Server-rendered except for the theme menu, which has to be a client component
 * because only the browser knows the resolved theme. The locale control is a
 * plain form posting to a Server Action, so it works before hydration.
 *
 * Both controls are the same components the landing page uses, with their
 * diagnostics turned off — see the note on `LocaleSwitch`.
 */
export async function SiteHeader() {
  const t = await getTranslations("status.header");

  return (
    <header className="border-b border-slate-200 dark:border-slate-800">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 px-6 py-4">
        <Link
          href="/"
          className="flex items-baseline gap-2 text-sm font-semibold tracking-tight"
        >
          <span>allclear</span>
          <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
            {t("tagline")}
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <LocaleSwitch />
        </div>
      </div>
    </header>
  );
}
