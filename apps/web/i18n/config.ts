/**
 * Locale constants, kept apart from `request.ts`.
 *
 * `request.ts` registers next-intl's request-config factory as a module side
 * effect, so anything that only needs the locale list — such as the Server
 * Action that writes the cookie — imports from here instead and stays free of
 * that dependency.
 */
export const locales = ["en", "zh-CN"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

export const LOCALE_COOKIE = "locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}
