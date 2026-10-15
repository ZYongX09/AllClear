/**
 * The shape of a subscribe attempt, kept out of the `"use server"` module.
 *
 * A file with the `"use server"` directive may only export async functions — the
 * RSC transform turns every export into a server-reference proxy and rejects
 * anything else outright. `INITIAL_SUBSCRIBE_STATE` is a plain object, so it
 * cannot live next to the action that consumes it; it lives here and both sides
 * import it.
 *
 * The type could have stayed behind, since types are erased, but keeping the pair
 * together is what stops them from drifting.
 */
export interface SubscribeState {
  outcome: "idle" | "success" | "error";
  /**
   * The API's own error code, not a sentence.
   *
   * Translating it is the dialog's job: the message catalogue is the one place
   * strings live, and a code the UI does not recognise degrades to a generic
   * message instead of rendering an untranslated identifier.
   */
  error?: string;
}

export const INITIAL_SUBSCRIBE_STATE: SubscribeState = { outcome: "idle" };
