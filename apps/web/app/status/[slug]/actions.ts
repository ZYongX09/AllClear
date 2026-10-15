"use server";

import { subscribeToPage } from "@/lib/allclear-api";
import type { SubscribeState } from "@/lib/subscribe-state";

/**
 * This module may only export async functions.
 *
 * The RSC transform rewrites every export into a server-reference proxy and
 * rejects a non-async one, which is why `SubscribeState` and
 * `INITIAL_SUBSCRIBE_STATE` live in `@/lib/subscribe-state` rather than here. The
 * type import below is erased and does not count as an export.
 */

const MAX_EMAIL_LENGTH = 254;
const MAX_COMPONENTS = 200;

/**
 * Subscribe an address to a page.
 *
 * The form is submitted to this Server Action rather than posted to the API
 * Worker directly, and that is not a convenience: `allclear-api` has no public
 * route. It is reachable only through this Worker's Service Binding, so the
 * browser has nothing to post to. The action is therefore the public edge of the
 * subscribe flow.
 *
 * ## Validation here is a courtesy, not the check
 *
 * The address is validated again by the API, which is the only place the answer
 * counts — a Server Action is reachable by anyone who can reach the page, so
 * nothing here is a trust boundary. What it does buy is a faster, clearer answer
 * for an obviously malformed address, before a rate-limit slot is spent on it.
 */
export async function subscribeAction(
  _previous: SubscribeState,
  formData: FormData,
): Promise<SubscribeState> {
  const slug = formData.get("slug");
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 128) {
    return { outcome: "error", error: "page_not_found" };
  }

  const rawEmail = formData.get("email");
  if (typeof rawEmail !== "string" || rawEmail.trim().length === 0) {
    return { outcome: "error", error: "email_required" };
  }
  if (rawEmail.trim().length > MAX_EMAIL_LENGTH) {
    return { outcome: "error", error: "invalid_email" };
  }

  const selected = formData
    .getAll("component")
    .filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 64);
  if (selected.length > MAX_COMPONENTS) {
    return { outcome: "error", error: "invalid_component_list" };
  }

  const result = await subscribeToPage(slug, rawEmail.trim(), selected);

  if (!result.ok) {
    // The binding itself failed, which is not the same as the API saying no.
    return { outcome: "error", error: "api_unreachable" };
  }

  // A 2xx is a success; anything else carries a reason. Note that a 202 is the
  // normal answer — the address is recorded and a confirmation mail is sent, but
  // nothing has been delivered yet and the UI must not say otherwise.
  if (result.status >= 200 && result.status < 300 && result.data.ok) {
    return { outcome: "success" };
  }

  return { outcome: "error", error: result.data.error ?? "internal_error" };
}
