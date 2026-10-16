/**
 * Change notifications.
 *
 * ## Selection is by component, not by page
 *
 * A subscriber who asked about the API should not be woken up because the download
 * server had a blip. A subscriber with no component selection is subscribed to the
 * whole page and receives everything. The SQL below encodes exactly that: the
 * `NOT EXISTS (SELECT 1 FROM subscriber_component ...)` branch is what keeps
 * whole-page subscribers in the result, and it is load-bearing because they are the
 * majority of subscribers. An inner join onto `subscriber_component` would silently
 * drop every one of them.
 *
 * ## Every message carries its own unsubscribe capability
 *
 * Each recipient gets a token signed for *that* subscriber, and the token is
 * re-derived per message rather than stored. Both `List-Unsubscribe` and
 * `List-Unsubscribe-Post` are set, so a mail client can offer one-click
 * unsubscription (RFC 8058) without the recipient hunting for a link.
 *
 * ## Failure is contained
 *
 * A send failure is recorded and the loop continues. An admin write must not fail
 * because an email provider did, and the operator's incident update is the thing
 * that must survive. What is *not* acceptable is failing silently: the counts and
 * errors are returned to the caller and logged.
 */

import { utcDay } from "@allclear/shared";

import {
  consumeEmailQuota,
  DAILY_EMAIL_QUOTA,
  emailSenderFromEnv,
  redactEmail,
  type EmailSender,
} from "./email";
import { DEFAULT_TOKEN_TTL_SECONDS, signUnsubscribeToken } from "./tokens";

/** Ceiling on recipients for a single event, to bound one request's work. */
export const MAX_RECIPIENTS_PER_EVENT = 500;

export interface NotifyContext {
  db: D1Database;
  sender: EmailSender;
  /** Signing key for unsubscribe links. Empty disables notification entirely. */
  unsubscribeSecret: string;
  /** Absolute origin the unsubscribe links point at. */
  publicBaseUrl: string;
  now: number;
  dailyQuota?: number;
  maxPerEvent?: number;
  tokenTtlSeconds?: number;
}

export interface NotifyResult {
  candidates: number;
  sent: number;
  failed: number;
  skippedQuota: number;
  disabled: boolean;
  errors: string[];
}

export type NotifyEvent = "created" | "updated" | "resolved";

interface ChangeRow {
  id: number;
  public_id: string;
  page_id: number;
  kind: string;
  status: string;
  title: string;
  body: string | null;
  severity: string;
  starts_at: number;
}

interface RecipientRow {
  id: number;
  email: string;
  version: number;
  page_id: number;
}

/**
 * Notify the subscribers a change affects.
 *
 * Returns a report rather than throwing: every caller is a write path whose own
 * success must not depend on email.
 */
export async function notifyChange(
  ctx: NotifyContext,
  changePublicId: string,
  event: NotifyEvent,
): Promise<NotifyResult> {
  const result: NotifyResult = {
    candidates: 0,
    sent: 0,
    failed: 0,
    skippedQuota: 0,
    disabled: false,
    errors: [],
  };

  if (ctx.unsubscribeSecret === "" || ctx.publicBaseUrl === "") {
    // Without a signing key there is no way to produce a link that can be
    // revoked, and without a public origin there is no link to produce at all.
    // Sending a notification whose unsubscribe link cannot be trusted — or that
    // is a relative path no mail client can follow — is worse than not sending.
    // The admin write already succeeded, so this is a warning, not an error.
    result.disabled = true;
    console.warn("notifications disabled: unsubscribe secret or public base URL is not configured");
    return result;
  }

  const change = await ctx.db
    .prepare(
      `SELECT id, public_id, page_id, kind, status, title, body, severity, starts_at
         FROM change WHERE public_id = ?1`,
    )
    .bind(changePublicId)
    .first<ChangeRow>();

  if (!change) {
    result.errors.push(`no change with public id ${changePublicId}`);
    return result;
  }

  const maxPerEvent = ctx.maxPerEvent ?? MAX_RECIPIENTS_PER_EVENT;
  const dailyQuota = ctx.dailyQuota ?? DAILY_EMAIL_QUOTA;
  const ttl = ctx.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;

  // A subscriber matches when they follow any component this change touches, or
  // when they follow no component at all (page-wide). The `NOT EXISTS` clause is
  // what keeps whole-page subscribers in the result; an inner join would drop
  // them.
  const { results: recipients } = await ctx.db
    .prepare(
      `SELECT s.id, s.email, s.version, s.page_id
         FROM subscriber s
        WHERE s.page_id = ?1
          AND s.confirmed_at IS NOT NULL
          AND s.unsubscribed_at IS NULL
          AND (
                NOT EXISTS (SELECT 1 FROM subscriber_component sc WHERE sc.subscriber_id = s.id)
                OR EXISTS (
                     SELECT 1
                       FROM subscriber_component sc
                       JOIN change_component cc ON cc.component_id = sc.component_id
                      WHERE sc.subscriber_id = s.id AND cc.change_id = ?2
                   )
              )
        ORDER BY s.id
        LIMIT ?3`,
    )
    .bind(change.page_id, change.id, maxPerEvent)
    .all<RecipientRow>();

  result.candidates = recipients.length;
  if (recipients.length === 0) return result;

  const page = await ctx.db
    .prepare("SELECT slug, name FROM page WHERE id = ?1")
    .bind(change.page_id)
    .first<{ slug: string; name: string }>();
  const pageSlug = page?.slug ?? "unknown";
  const pageName = page?.name ?? "status page";

  const day = utcDay(ctx.now);

  for (const recipient of recipients) {
    const quota = await consumeEmailQuota(ctx.db, day, dailyQuota, ctx.now);
    if (!quota.allowed) {
      result.skippedQuota += 1;
      continue;
    }

    const token = await signUnsubscribeToken(
      {
        pageId: recipient.page_id,
        subscriberId: recipient.id,
        version: recipient.version,
        exp: ctx.now + ttl,
      },
      ctx.unsubscribeSecret,
    );

    const unsubscribeUrl = `${ctx.publicBaseUrl}/u/${token}`;
    const statusUrl = `${ctx.publicBaseUrl}/status/${pageSlug}`;

    const subject = buildSubject(event, change, pageName);
    const text = buildText(event, change, statusUrl, unsubscribeUrl);

    const sendResult = await ctx.sender.send({
      to: recipient.email,
      subject,
      text,
      headers: {
        // RFC 8058. The POST variant lets a mail client unsubscribe with one
        // click, without opening a page or following a link.
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    if (sendResult.ok) {
      result.sent += 1;
    } else {
      result.failed += 1;
      result.errors.push(`${redactEmail(recipient.email)}: ${sendResult.error ?? "unknown"}`);
    }
  }

  return result;
}

function buildSubject(event: NotifyEvent, change: ChangeRow, pageName: string): string {
  const label = change.kind === "maintenance" ? "Maintenance" : "Incident";
  switch (event) {
    case "created":
      return `[${pageName}] ${label} opened: ${change.title}`;
    case "resolved":
      return `[${pageName}] ${label} resolved: ${change.title}`;
    default:
      return `[${pageName}] ${label} updated: ${change.title}`;
  }
}

function buildText(
  event: NotifyEvent,
  change: ChangeRow,
  statusUrl: string,
  unsubscribeUrl: string,
): string {
  const lines: string[] = [];
  const label = change.kind === "maintenance" ? "Maintenance" : "Incident";

  lines.push(`${label} ${event === "resolved" ? "resolved" : "update"}: ${change.title}`);
  lines.push(`Status: ${change.status}`);
  if (change.severity !== "none") lines.push(`Severity: ${change.severity}`);
  lines.push("");
  if (change.body) {
    lines.push(change.body);
    lines.push("");
  }
  lines.push(`Details: ${statusUrl}`);
  lines.push("");
  lines.push("---");
  lines.push(`Unsubscribe: ${unsubscribeUrl}`);

  return lines.join("\n");
}

/** Build the notification context from the Worker environment. */
export function notifyContextFromEnv(env: Env, now: number): NotifyContext {
  return {
    db: env.DB,
    sender: emailSenderFromEnv(env),
    unsubscribeSecret: env.UNSUBSCRIBE_HMAC_KEY ?? "",
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
    now,
  };
}

/**
 * Notify, and never let a notification failure reach the caller as a failure.
 *
 * Every call site is a write path that has already committed. Turning a provider
 * outage into a 500 there would tell an operator their incident update failed
 * when it did not, and the natural reaction — saving again — would create a
 * duplicate timeline entry. The report is logged instead.
 *
 * This is containment, not silence: the counts and errors are in the log line,
 * and a `disabled` or `skippedQuota` result means the message genuinely did not
 * go out.
 */
export async function notifyChangeSafely(
  env: Env,
  changePublicId: string,
  event: NotifyEvent,
  now: number,
): Promise<void> {
  try {
    const result = await notifyChange(notifyContextFromEnv(env, now), changePublicId, event);
    console.log("notification pass", {
      change: changePublicId,
      event,
      candidates: result.candidates,
      sent: result.sent,
      failed: result.failed,
      skippedQuota: result.skippedQuota,
      disabled: result.disabled,
      errors: result.errors,
    });
  } catch (error) {
    console.error("notification pass threw", {
      change: changePublicId,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
