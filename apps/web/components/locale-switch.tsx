import { getLocale, getTranslations } from "next-intl/server";
import { setLocaleAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/**
 * Locale switcher submitted as a plain form to a Server Action.
 *
 * No client JavaScript is involved: the browser posts the form, the action
 * writes the cookie and revalidates the layout, and the server re-renders in the
 * new locale. That keeps the switch working before hydration, which is also why
 * it is a useful thing to verify on a non-Next bundler.
 */
export async function LocaleSwitch() {
  const locale = await getLocale();
  const t = await getTranslations("ui");
  const next = locale === "en" ? "zh-CN" : "en";

  return (
    <form action={setLocaleAction} className="flex flex-col gap-2" data-testid="locale-switch">
      <input type="hidden" name="locale" value={next} />
      <Button type="submit" variant="outline" data-testid="locale-submit">
        {t("localeSwitch")}
      </Button>
      <p className="text-sm" data-testid="locale-value">
        {t("localeValue", { locale })}
      </p>
    </form>
  );
}
