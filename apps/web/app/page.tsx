import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LocaleSwitch } from "@/components/locale-switch";
import { SiteHeader } from "@/components/site-header";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { webEnv } from "@/lib/worker-env";

/**
 * Rendered per request.
 *
 * The page is translated, and the locale comes from a cookie, so a statically
 * rendered copy would be frozen in whichever locale happened to be active at
 * build time. vinext's build-time classifier reports this route as "unknown"
 * because it detects `cookies()` through next-intl's request config rather than
 * directly, so the setting is stated here rather than inferred.
 */
export const dynamic = "force-dynamic";

/**
 * The landing page.
 *
 * It has one job: get a reader to the status page in one click, and say plainly
 * what the numbers there mean. The capability readouts from M0 (active locale,
 * resolved theme) are kept, but moved to a diagnostics block at the bottom rather
 * than sitting in the masthead, where they were the first thing a visitor saw.
 */
export default async function Home() {
  const t = await getTranslations("home");

  // Widened through a `string`-typed local on purpose: `wrangler types` narrows a
  // `bindings.text("…")` value to its literal type, so comparing it against
  // another string is a "this comparison is always false" error rather than a
  // runtime check.
  const configured: string = webEnv.DEFAULT_STATUS_SLUG;
  const slug = configured.trim();

  const features = ["derived", "uptime", "honest"] as const;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <SiteHeader />

      <main className="mx-auto flex max-w-3xl flex-col gap-10 px-6 py-12">
        <div className="flex flex-col gap-4">
          <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            {t("eyebrow")}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("title")}</h1>
          <p className="text-base leading-7 text-slate-700 dark:text-slate-300">{t("intro")}</p>
        </div>

        {slug ? (
          <div>
            <Button asChild>
              <Link href={`/status/${encodeURIComponent(slug)}`}>{t("openStatusPage")}</Link>
            </Button>
          </div>
        ) : (
          <p
            className="rounded-md border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
            data-testid="no-default-slug"
          >
            {t("notConfigured")}
          </p>
        )}

        <section className="grid gap-4 sm:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature}
              className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
            >
              <h2 className="text-sm font-semibold">{t(`features.${feature}.title`)}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">
                {t(`features.${feature}.body`)}
              </p>
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-3" data-testid="feeds">
          <h2 className="text-lg font-semibold tracking-tight">{t("feedHeading")}</h2>
          <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">{t("feedHint")}</p>
          {slug ? (
            <ul className="flex flex-wrap gap-4 text-sm">
              <li>
                <a
                  className="font-medium underline underline-offset-4"
                  href={`/status/${encodeURIComponent(slug)}/feed.xml`}
                >
                  {`/status/${slug}/feed.xml`}
                </a>
              </li>
              <li>
                <a
                  className="font-medium underline underline-offset-4"
                  href={`/status/${encodeURIComponent(slug)}/snapshot.json`}
                >
                  {`/status/${slug}/snapshot.json`}
                </a>
              </li>
            </ul>
          ) : null}
        </section>

        <section
          className="flex flex-col gap-4 border-t border-slate-200 pt-8 dark:border-slate-800"
          data-testid="diagnostics"
        >
          <h2 className="text-lg font-semibold tracking-tight">{t("diagnosticsHeading")}</h2>
          <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
            {t("diagnosticsHint")}
          </p>
          <div className="flex flex-wrap items-start gap-6">
            <ThemeToggle showDiagnostics />
            <LocaleSwitch showDiagnostics />
          </div>
        </section>
      </main>
    </div>
  );
}
