import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, defaultLocale, isLocale, type Locale } from "./config";

export { locales, defaultLocale, LOCALE_COOKIE, isLocale, type Locale } from "./config";

// Static map rather than a template-literal import: the bundler can see every
// message file this way, so no build-time magic is needed to include them.
const loadMessages = {
  en: () => import("./messages/en.json"),
  "zh-CN": () => import("./messages/zh-CN.json"),
} satisfies Record<Locale, () => Promise<{ default: Record<string, unknown> }>>;

/** Resolve the active locale from the cookie, falling back to the default. */
export async function resolveLocale(): Promise<Locale> {
  const store = await cookies();
  const fromCookie = store.get(LOCALE_COOKIE)?.value;
  return isLocale(fromCookie) ? fromCookie : defaultLocale;
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  const { default: messages } = await loadMessages[locale]();
  return { locale, messages };
});
