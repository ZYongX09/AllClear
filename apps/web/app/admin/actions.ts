"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { write } from "@/lib/admin-api";
import { formStateFromWrite, type AdminFormState } from "@/lib/admin-form-state";
import { MIN_PROBE_INTERVAL_SECONDS } from "@allclear/shared";
import {
  ADMIN_COOKIE,
  issueSession,
  readAdminSession,
  SESSION_TTL_SECONDS,
  tokenMatches,
} from "@/lib/admin-session";

/**
 * Every write the console can perform, as Server Actions.
 *
 * ## The gate
 *
 * A Server Action is a public POST endpoint. It runs in this Worker, where
 * `INTERNAL_KEY` is in the environment, and it attaches that key on the way to
 * the API. So each action here re-checks the session before doing anything —
 * the layout's check decides what to *render*, and rendering is not a
 * security boundary. Without this second check, a signed-out browser that kept
 * a form's action id could still POST it.
 *
 * `guard()` is the single place that check happens. An action that forgot to
 * call it would be a hole, so there is exactly one shape to get right and it is
 * three lines long.
 *
 * ## Why the error codes are not translated here
 *
 * These actions return the API's own code (`slug`, `name`, `url`, ... in
 * `field`; `invalid_slug`, `internal_error` in `error`) rather than a sentence.
 * The console is an operator tool with one audience and no locale switch, and
 * the codes are already the vocabulary the API documents. See
 * docs/spec/admin-ui.md for why the console is not localised.
 */

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

async function guard(): Promise<AdminFormState | null> {
  const session = await readAdminSession();
  if (session !== null) return null;
  return { outcome: "error", error: "not_signed_in" };
}

/**
 * Re-render the console.
 *
 * Every action ends with this. The admin pages are `force-dynamic`, so they would
 * re-render anyway; this is here because the console's correctness should not
 * depend on a page-level export staying set. It is also what makes a write
 * visible from a *different* tab or a stale back-navigation.
 */
function refresh(): void {
  revalidatePath("/admin", "layout");
}

// ---------------------------------------------------------------------------
// Form reading
// ---------------------------------------------------------------------------

/**
 * A trimmed string, or `undefined` when the field was empty or absent.
 *
 * Empty means absent throughout: an operator who clears a text box is asking for
 * the default, not for the empty string, and the API's `optionalString` treats a
 * present-but-empty value as absent for the same reason. Blank inputs that are
 * only sometimes meaningful (`endsAt` on a manual impact) rely on this to
 * distinguish "no end time" from "ends at epoch 0".
 */
function str(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function num(formData: FormData, name: string): number | undefined {
  const raw = str(formData, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Spread a possibly-absent value into a request body.
 *
 * `{...present("endsAt", x)}` rather than `{endsAt: x}` because the API
 * distinguishes an absent key (leave it alone) from an explicit `null` (clear
 * it). `JSON.stringify` would drop an `undefined` value anyway, but only by
 * accident — being explicit means the intent survives a change to how the body
 * is serialised, and it keeps the compiler honest about which keys are optional.
 */
function present<K extends string, T>(
  key: K,
  value: T | undefined,
): { [P in K]?: T } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: T };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function loginAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const submitted = str(formData, "token");
  if (submitted === undefined) {
    return { outcome: "error", error: "token_required", field: "token" };
  }

  if (!(await tokenMatches(submitted))) {
    // One message for "wrong token" and "no token configured". The second case
    // is not a secret — an operator who can reach this page needs to know the
    // deployment is unconfigured — but the login form is not where they find
    // out; the page renders that state instead of the form. So this branch only
    // ever means the token was wrong, and saying so is fine.
    return { outcome: "error", error: "invalid_token", field: "token" };
  }

  const session = await issueSession(Math.floor(Date.now() / 1000));
  const store = await cookies();
  store.set(ADMIN_COOKIE, session.value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    // Scoped to the console. The public status pages are served by the same
    // Worker, and a session cookie has no business being sent to them.
    path: "/admin",
    maxAge: SESSION_TTL_SECONDS,
  });

  refresh();
  return { outcome: "ok" };
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  store.delete({ name: ADMIN_COOKIE, path: "/admin" });
  refresh();
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export async function createPageAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const result = await write("/internal/admin/pages", "POST", {
    slug: str(formData, "slug") ?? "",
    name: str(formData, "name") ?? "",
  });
  refresh();
  return formStateFromWrite(result);
}

export async function renamePageAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const slug = str(formData, "slug") ?? "";
  const result = await write(`/internal/admin/pages/${encodeURIComponent(slug)}`, "PATCH", {
    name: str(formData, "name") ?? "",
  });
  refresh();
  return formStateFromWrite(result);
}

export async function rebuildSnapshotAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const slug = str(formData, "slug") ?? "";
  const result = await write(
    `/internal/admin/pages/${encodeURIComponent(slug)}/rebuild`,
    "POST",
    {},
  );
  refresh();
  return formStateFromWrite(result);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export async function createSectionAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const slug = str(formData, "slug") ?? "";
  const result = await write(
    `/internal/admin/pages/${encodeURIComponent(slug)}/sections`,
    "POST",
    { name: str(formData, "name") ?? "", description: str(formData, "description") ?? null },
  );
  refresh();
  return formStateFromWrite(result);
}

export async function updateSectionAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const publicId = str(formData, "sectionPublicId") ?? "";
  const result = await write(
    `/internal/admin/sections/${encodeURIComponent(publicId)}`,
    "PATCH",
    { name: str(formData, "name") ?? "" },
  );
  refresh();
  return formStateFromWrite(result);
}

export async function deleteSectionAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const publicId = str(formData, "sectionPublicId") ?? "";
  const result = await write(
    `/internal/admin/sections/${encodeURIComponent(publicId)}`,
    "DELETE",
  );
  refresh();
  return formStateFromWrite(result);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export async function createComponentAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const slug = str(formData, "slug") ?? "";
  const result = await write(
    `/internal/admin/pages/${encodeURIComponent(slug)}/components`,
    "POST",
    {
      name: str(formData, "name") ?? "",
      // An empty section select means the page root, which is `null` — not
      // absent. This is the one place the console sends an explicit null, and it
      // is deliberate: "no section" is a choice the operator made, not a field
      // they skipped.
      sectionPublicId: str(formData, "sectionPublicId") ?? null,
    },
  );
  refresh();
  return formStateFromWrite(result);
}

export async function updateComponentAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const publicId = str(formData, "componentPublicId") ?? "";
  const name = str(formData, "name");
  const sectionChoice = str(formData, "sectionPublicId");

  const result = await write(
    `/internal/admin/components/${encodeURIComponent(publicId)}`,
    "PATCH",
    {
      ...(name === undefined ? {} : { name }),
      // The select always submits, so a value here is an explicit choice —
      // including the empty string, which means "move to the page root". The
      // hidden marker input is what makes that expressible: without it, an empty
      // select and an absent field would look the same.
      ...(formData.get("sectionEdited") === "1"
        ? { sectionPublicId: sectionChoice === undefined ? null : sectionChoice }
        : {}),
    },
  );
  refresh();
  return formStateFromWrite(result);
}

export async function deleteComponentAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const publicId = str(formData, "componentPublicId") ?? "";
  const result = await write(
    `/internal/admin/components/${encodeURIComponent(publicId)}`,
    "DELETE",
  );
  refresh();
  return formStateFromWrite(result);
}

// ---------------------------------------------------------------------------
// Probe targets
// ---------------------------------------------------------------------------

export async function createProbeAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const intervalSeconds = num(formData, "intervalSeconds");
  const result = await write("/internal/admin/probes", "POST", {
    componentPublicId: str(formData, "componentPublicId") ?? "",
    url: str(formData, "url") ?? "",
    method: str(formData, "method") ?? "GET",
    // `partial_outage` to match the API's own default. The console must not
    // silently choose a *more* alarming severity than a direct API call would:
    // a probe that opens a full outage because a form defaulted that way is a
    // false alarm on the most visible surface this project has.
    severity: str(formData, "severity") ?? "partial_outage",
    // The API rejects anything under 60 and the input's `min` says so too; this
    // default is only here so an empty box does not become an absent field.
    intervalSeconds: intervalSeconds ?? MIN_PROBE_INTERVAL_SECONDS,
  });
  refresh();
  return formStateFromWrite(result);
}

export async function updateProbeAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const publicId = str(formData, "probePublicId") ?? "";
  const url = str(formData, "url");
  const intervalSeconds = num(formData, "intervalSeconds");

  // A checkbox submits nothing when unchecked, and the obvious fix — a hidden
  // input with the same name carrying "false" — makes `get()` return "false"
  // *and* "on" when the box is ticked, so `get()` alone would always read false.
  // Reading every value and testing whether any of them is the ticked one is the
  // version that gets both states right.
  const enabledValues = formData.getAll("enabled");
  const enabled =
    enabledValues.length === 0
      ? undefined
      : enabledValues.some((value) => value === "on" || value === "true");

  const result = await write(
    `/internal/admin/probes/${encodeURIComponent(publicId)}`,
    "PATCH",
    {
      ...present("url", url),
      ...present("intervalSeconds", intervalSeconds),
      ...present("enabled", enabled),
    },
  );
  refresh();
  return formStateFromWrite(result);
}

export async function deleteProbeAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const publicId = str(formData, "probePublicId") ?? "";
  const result = await write(`/internal/admin/probes/${encodeURIComponent(publicId)}`, "DELETE");
  refresh();
  return formStateFromWrite(result);
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export async function createChangeAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const slug = str(formData, "slug") ?? "";
  const startsAt = num(formData, "startsAt");
  const scheduledStartAt = num(formData, "scheduledStartAt");
  const scheduledEndAt = num(formData, "scheduledEndAt");

  const result = await write(
    `/internal/admin/pages/${encodeURIComponent(slug)}/changes`,
    "POST",
    {
      kind: str(formData, "kind") ?? "incident",
      title: str(formData, "title") ?? "",
      body: str(formData, "body") ?? null,
      severity: str(formData, "severity") ?? "full_outage",
      // Every checked box. An empty list means "page-wide", which the API
      // supports for an incident that affects nothing in particular yet.
      componentPublicIds: formData.getAll("componentPublicIds").filter((v) => typeof v === "string"),
      ...present("startsAt", startsAt),
      scheduledStartAt: scheduledStartAt ?? null,
      scheduledEndAt: scheduledEndAt ?? null,
    },
  );
  refresh();
  return formStateFromWrite(result);
}

export async function addChangeUpdateAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const publicId = str(formData, "changePublicId") ?? "";
  const result = await write(
    `/internal/admin/changes/${encodeURIComponent(publicId)}/updates`,
    "POST",
    {
      status: str(formData, "status") ?? "in_progress",
      body: str(formData, "body") ?? "",
    },
  );
  refresh();
  return formStateFromWrite(result);
}

export async function setChangeStatusAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const publicId = str(formData, "changePublicId") ?? "";
  const result = await write(
    `/internal/admin/changes/${encodeURIComponent(publicId)}`,
    "PATCH",
    { status: str(formData, "status") ?? "resolved" },
  );
  refresh();
  return formStateFromWrite(result);
}

// ---------------------------------------------------------------------------
// Manual impacts
// ---------------------------------------------------------------------------

export async function createManualImpactAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const slug = str(formData, "slug") ?? "";
  const startAt = num(formData, "startAt");
  const endAt = num(formData, "endAt");

  const result = await write(
    `/internal/admin/pages/${encodeURIComponent(slug)}/impacts`,
    "POST",
    {
      componentPublicId: str(formData, "componentPublicId") ?? "",
      severity: str(formData, "severity") ?? "full_outage",
      // Required by the API. A missing start is a form the operator submitted
      // empty, and sending 0 would record an outage beginning in 1970 — which
      // the API would accept, because 0 is a valid epoch. So it is caught here.
      ...(startAt === undefined ? {} : { startAt }),
      endAt: endAt ?? null,
    },
  );
  refresh();
  return formStateFromWrite(result);
}

export async function closeManualImpactAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const denied = await guard();
  if (denied !== null) return denied;

  const publicId = str(formData, "impactPublicId") ?? "";
  const result = await write(
    `/internal/admin/impacts/${encodeURIComponent(publicId)}/close`,
    "POST",
    { endAt: num(formData, "endAt") ?? Math.floor(Date.now() / 1000) },
  );
  refresh();
  return formStateFromWrite(result);
}
