"use server";

import { env } from "cloudflare:workers";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { echoInternal, rebuildSnapshot, type CallResult } from "@/lib/allclear-api";
import { LOCALE_COOKIE, isLocale } from "@/i18n/config";

/**
 * Server Actions are the only path that carries `INTERNAL_KEY` to the API
 * Worker. The key is read from the Worker's own environment inside the action
 * body, so it is never serialised into the RSC payload the browser receives.
 */

export interface ActionResult {
  /** Which call produced this result. */
  operation: string;
  result: CallResult<unknown>;
}

export async function echoAction(
  _previous: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  return {
    operation: "GET /internal/echo",
    result: await echoInternal(env.API, env.INTERNAL_KEY),
  };
}

export async function rebuildAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get("slug") ?? "");
  return {
    operation: `POST /internal/snapshot/${slug}/rebuild`,
    result: await rebuildSnapshot(env.API, env.INTERNAL_KEY, slug),
  };
}

/**
 * Persist the chosen locale in a cookie and re-render the tree.
 *
 * The value is validated against the known locale list before it is written, so
 * the cookie can never become a path into the message loader.
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

