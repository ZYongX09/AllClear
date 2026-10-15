"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { LOCALE_COOKIE, isLocale } from "@/i18n/config";

/**
 * Persist the chosen locale in a cookie and re-render the tree.
 *
 * The value is validated against the known locale list before it is written, so
 * the cookie can never become a path into the message loader.
 *
 * The M0 capability actions that lived here — an internal echo round-trip and a
 * snapshot rebuild — were removed with the M0 report pages they served. The
 * rebuild path returns in M2 as the admin write path; when it does, it belongs
 * in its own module rather than next to a locale setter.
 */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const requested = formData.get("locale");
  if (!isLocale(requested)) return;
  const store = await cookies();
  store.set(LOCALE_COOKIE, requested, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  revalidatePath("/", "layout");
}
