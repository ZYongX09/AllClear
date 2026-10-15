import { getLocale, getTranslations } from "next-intl/server";
import { LocaleSwitch } from "@/components/locale-switch";
import { RadixMenuDemo } from "@/components/radix-menu-demo";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * M0 capability check for the front-end stack.
 *
 * Nothing here is part of the product: it exists so that "next-intl + Radix +
 * shadcn-style components + theme switching coexist" is answered by a deployed
 * page rather than by a dependency list. The real status page is built in M4.
 */
export default async function UiCapabilityPage() {
  const t = await getTranslations("ui");
  const locale = await getLocale();

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">allclear · M0</p>
        <h1 className="text-2xl font-semibold" data-testid="ui-title">
          {t("title")}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">{t("intro")}</p>
      </header>

      <section className="flex flex-col gap-3 rounded-lg border border-slate-200 p-5 dark:border-slate-800">
        <h2 className="text-lg font-medium">{t("localeHeading")}</h2>
        <LocaleSwitch />
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-slate-200 p-5 dark:border-slate-800">
        <h2 className="text-lg font-medium">{t("themeHeading")}</h2>
        <ThemeToggle />
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-slate-200 p-5 dark:border-slate-800">
        <h2 className="text-lg font-medium">{t("radixHeading")}</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">{t("radixHint")}</p>
        <RadixMenuDemo />
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-slate-200 p-5 dark:border-slate-800">
        <h2 className="text-lg font-medium">{t("serverHeading")}</h2>
        <p className="text-sm" data-testid="server-text">
          {t("serverText")}
        </p>
        {/* ICU plural, so the message compiler is exercised rather than plain lookups. */}
        <p className="text-sm" data-testid="plural">
          {t("count", { n: 4 })}
        </p>
        <p className="text-sm text-slate-500 dark:text-slate-400" data-testid="locale-echo">
          lang={locale}
        </p>
      </section>
    </main>
  );
}
