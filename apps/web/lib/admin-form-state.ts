/**
 * The shape every admin form shares, kept out of the `"use server"` module.
 *
 * Same reason as `subscribe-state.ts`: a file with the `"use server"` directive
 * may only export async functions, because the RSC transform replaces every
 * export with a server-reference proxy and refuses a non-function outright. A
 * plain initial-state object has to live somewhere else, and both sides import
 * it from here.
 *
 * ## One state type for every form
 *
 * There are eighteen writes in the console and they differ only in which fields
 * they carry. Giving each its own state type would mean eighteen near-identical
 * objects and eighteen chances for one of them to be subtly different; the
 * interesting part — did it work, and if not which input was wrong — is the same
 * everywhere.
 */

export interface AdminFormState {
  /** `idle` before the first submit, so an untouched form renders no message. */
  outcome: "idle" | "ok" | "error";
  /**
   * The API's error code, not a sentence.
   *
   * Codes cross the boundary because the console is the only place that knows how
   * to phrase them; `internal_error` and `api_unreachable` are the two this module
   * produces itself, and everything else is passed through from the API's
   * `{ ok: false, error }` body.
   */
  error?: string;
  /**
   * Which input to mark, when the API named one.
   *
   * `field` is the API's own identifier for the offending input (it is the second
   * argument to `ValidationError` on the other side), so it arrives already in the
   * vocabulary the forms use for their input names.
   */
  field?: string | null;
  /** Free-text detail from the API, shown under the message. Never a credential. */
  detail?: string;
}

export const INITIAL_ADMIN_STATE: AdminFormState = { outcome: "idle" };

/**
 * Turn an `AdminWriteResult` into form state.
 *
 * Kept here rather than in the action module so that a form and its action agree
 * on the mapping without the form importing from a `"use server"` file — which it
 * could not do for anything but the action functions themselves.
 */
export function formStateFromWrite(result: {
  ok: boolean;
  error?: string;
  field?: string | null;
}): AdminFormState {
  if (result.ok) return { outcome: "ok" };
  return {
    outcome: "error",
    error: result.error ?? "internal_error",
    field: result.field ?? null,
  };
}
