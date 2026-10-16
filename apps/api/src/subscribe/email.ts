/**
 * Outbound email, and the counter that stops it running away.
 *
 * ## Delivery is not wired to a provider here
 *
 * `createEmailSender` uses a `send_email` binding when one is configured and falls
 * back to a *recording* sender that logs the message and reports success. The
 * fallback exists so that the subscription flow can be built, tested and reasoned
 * about before a sending domain is verified, and so that a missing binding
 * degrades to "nothing was sent" rather than to a 500 on the subscribe form.
 *
 * The consequence must not be glossed over: **with the recording sender, no email
 * is delivered.** The double opt-in flow is therefore implemented and unit-tested
 * but not verified end to end against a real mailbox. That is recorded in
 * docs/spec/subscriptions.md rather than left for someone to discover.
 *
 * ## Why the counter is incremented by the statement that checks it
 *
 * `email_quota` is a global daily ceiling, and a runaway loop — a subscriber list
 * that suddenly matches everything, a retry storm — must hit a wall and stop rather
 * than turn into a bill. `consumeEmailQuota` does the increment and the check in a
 * single `INSERT ... ON CONFLICT ... RETURNING` statement and decides on the
 * post-increment value, so the check is atomic with respect to concurrent requests:
 * two callers cannot observe the same `sent` value, and exactly `limit` sends are
 * permitted per day.
 *
 * The count is deliberately taken *before* the caller sends, so a send that then
 * fails still consumes quota. That direction is the safe one — the ceiling can be
 * reached early, never exceeded. (An earlier version of this comment described a
 * check-then-increment with a race window between the two; there is no window, and
 * the ordering was the other way round.)
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Extra headers, used for `List-Unsubscribe` and its one-click variant. */
  headers?: Record<string, string>;
}

export interface EmailSender {
  readonly kind: "binding" | "recording";
  send(message: EmailMessage): Promise<{ ok: boolean; error?: string }>;
}

/**
 * The `send_email` binding's shape, declared structurally.
 *
 * Declared here rather than generated from `wrangler.jsonc` because the binding
 * is optional: adding it to the config would make `wrangler deploy` fail on any
 * account without a verified sending domain, which would break the deploy path
 * for everyone who only wants the status page.
 */
export interface EmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text: string;
    html?: string;
    headers?: Record<string, string>;
  }): Promise<unknown>;
}

export interface EmailConfig {
  binding?: EmailBinding | undefined;
  from: string;
}

export function createEmailSender(config: EmailConfig): EmailSender {
  const binding = config.binding;
  if (!binding) {
    return {
      kind: "recording",
      async send(message) {
        // Logged with the recipient redacted. A confirmation link in a log is a
        // capability, so only the fact that a message was produced is recorded.
        console.log("email not sent: no binding configured", {
          to: redactEmail(message.to),
          subject: message.subject,
        });
        return { ok: true };
      },
    };
  }

  return {
    kind: "binding",
    async send(message) {
      try {
        await binding.send({
          to: message.to,
          from: config.from,
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          ...(message.headers === undefined ? {} : { headers: message.headers }),
        });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * Build the sender from the Worker's environment.
 *
 * The binding is optional in `Env` because it is absent from `wrangler.jsonc`
 * on purpose: declaring a `send_email` binding makes `wrangler deploy` fail on
 * any account without a verified sending domain, which would break deployment
 * for everyone who only wants a status page. Absent means recording, and
 * recording means nothing is delivered.
 */
export function emailSenderFromEnv(env: Env): EmailSender {
  return createEmailSender({
    ...(env.EMAIL === undefined ? {} : { binding: env.EMAIL }),
    from: env.EMAIL_FROM ?? "status@localhost",
  });
}

/** `a***@example.com`. Enough to correlate a log line, not enough to be a leak. */
export function redactEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const first = email.slice(0, 1);
  return `${first}***${email.slice(at)}`;
}

export interface QuotaDecision {
  allowed: boolean;
  used: number;
  limit: number;
}

/**
 * The global daily send ceiling.
 *
 * It lives here, next to the counter it bounds, rather than beside either of the
 * two callers. Both the subscribe route and the notification path need the same
 * number, and the admin view reports it — three readers is exactly the situation
 * where two copies drift and the operator is told a limit the code does not
 * enforce.
 */
export const DAILY_EMAIL_QUOTA = 2000;

/** Consume one send from the global daily budget. */
export async function consumeEmailQuota(
  db: D1Database,
  day: string,
  limit: number,
  now: number,
): Promise<QuotaDecision> {
  const row = await db
    .prepare(
      `INSERT INTO email_quota (day, sent, created_at, updated_at)
       VALUES (?1, 1, ?2, ?2)
       ON CONFLICT(day) DO UPDATE SET sent = sent + 1, updated_at = ?2
       RETURNING sent`,
    )
    .bind(day, now)
    .first<{ sent: number }>();

  const used = row?.sent ?? 1;
  return { allowed: used <= limit, used, limit };
}

/**
 * Read the current usage without consuming any.
 *
 * Currently unused. It was written for the admin view of the send budget, which
 * is not built yet; the honest state is that nothing calls this, so the
 * remaining allowance is not visible anywhere. Kept because it is the read half
 * of `consumeEmailQuota` and the tests exercise both halves of the pair.
 */
export async function readEmailQuota(
  db: D1Database,
  day: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT sent FROM email_quota WHERE day = ?1")
    .bind(day)
    .first<{ sent: number }>();
  return row?.sent ?? 0;
}
