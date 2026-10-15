"use client";

import { useActionState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Bell, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { INITIAL_SUBSCRIBE_STATE } from "@/lib/subscribe-state";
import { subscribeAction } from "@/app/status/[slug]/actions";
import { Button } from "@/components/ui/button";

/**
 * Map the API's error codes onto message keys.
 *
 * A code with no entry falls back to a generic message, which is the right
 * failure: the alternative is a lookup that throws, turning "the API rejected
 * this" into a blank screen. Several distinct codes deliberately share one
 * message — `email_quota_exceeded` and `subscription_capacity_reached` both mean
 * "not right now, try later" and telling a visitor which internal ceiling was hit
 * is not useful to them.
 */
const ERROR_KEYS: Readonly<Record<string, string>> = {
  email_required: "errors.invalidEmail",
  invalid_email: "errors.invalidEmail",
  invalid_component_list: "errors.badSelection",
  unknown_component: "errors.badSelection",
  rate_limited: "errors.rateLimited",
  email_quota_exceeded: "errors.unavailable",
  subscription_capacity_reached: "errors.unavailable",
  public_base_url_not_configured: "errors.unavailable",
  email_send_failed: "errors.sendFailed",
  page_not_found: "errors.pageNotFound",
  api_unreachable: "errors.unreachable",
};

/**
 * The subscribe dialog.
 *
 * ## Why the success message is vague on purpose
 *
 * The API answers identically whether the address was new, already pending, or
 * already confirmed, so that the endpoint cannot be used to ask "is this person
 * subscribed here". The UI therefore says "if that address can be subscribed, a
 * confirmation link is on its way" rather than "you are subscribed" — not
 * hedging, but the only claim the response supports.
 *
 * ## Why a dialog rather than an inline form
 *
 * The status page's job is to be readable during an incident, and a permanent
 * email field on it is one more thing between the reader and the answer. The
 * dialog keeps the page quiet until someone actually wants to subscribe, and
 * Radix handles the focus trap, the escape key and `aria-modal` — all of which
 * a hand-rolled overlay gets wrong.
 */
export function SubscribeForm({
  slug,
  components,
}: {
  slug: string;
  components: Array<{ publicId: string; name: string }>;
}) {
  const t = useTranslations("status.subscribe");
  const [state, formAction, pending] = useActionState(subscribeAction, INITIAL_SUBSCRIBE_STATE);

  const errorKey = state.error ? (ERROR_KEYS[state.error] ?? "errors.generic") : null;

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button variant="outline" data-testid="subscribe-open">
          <Bell className="h-4 w-4" aria-hidden />
          {t("cta")}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/40" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-200 bg-white p-6 shadow-lg dark:border-slate-800 dark:bg-slate-900"
          data-testid="subscribe-dialog"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-lg font-medium">{t("title")}</Dialog.Title>
              <Dialog.Description className="text-sm leading-6 text-slate-600 dark:text-slate-400">
                {t("description")}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label={t("close")}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </Dialog.Close>
          </div>

          {state.outcome === "success" ? (
            <div className="mt-6 flex flex-col gap-4">
              <p
                className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                data-testid="subscribe-success"
                role="status"
              >
                {t("sent")}
              </p>
              <Dialog.Close asChild>
                <Button variant="outline">{t("close")}</Button>
              </Dialog.Close>
            </div>
          ) : (
            <form action={formAction} className="mt-6 flex flex-col gap-4">
              <input type="hidden" name="slug" value={slug} />

              <div className="flex flex-col gap-1.5">
                <label htmlFor="subscribe-email" className="text-sm font-medium">
                  {t("emailLabel")}
                </label>
                <input
                  id="subscribe-email"
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                  autoComplete="email"
                  placeholder={t("emailPlaceholder")}
                  className="h-9 rounded-md border border-slate-300 bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-slate-700"
                />
              </div>

              {/* Only offered when there is a real choice. A single-component
                  page would render one permanently-ticked box, which reads as a
                  decision the visitor has to make and is not. */}
              {components.length > 1 ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-sm font-medium">{t("scopeLegend")}</legend>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t("scopeHint")}</p>
                  <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto pt-1">
                    {components.map((component) => (
                      <label
                        key={component.publicId}
                        className="flex items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          name="component"
                          value={component.publicId}
                          className="h-4 w-4 rounded border-slate-300 dark:border-slate-600"
                        />
                        {component.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}

              {errorKey ? (
                <p
                  className="rounded-md border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                  data-testid="subscribe-error"
                  data-error={state.error}
                  role="alert"
                >
                  {t(errorKey)}
                </p>
              ) : null}

              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button type="button" variant="ghost">
                    {t("cancel")}
                  </Button>
                </Dialog.Close>
                <Button type="submit" disabled={pending} data-testid="subscribe-submit">
                  {pending ? t("sending") : t("submit")}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
