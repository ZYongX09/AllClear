/**
 * Fixed-window rate limiting.
 *
 * The counter is incremented by a single SQL statement, so it is atomic under
 * concurrency. That matters: a read-then-write implementation would let exactly
 * the parallel requests a limiter exists to stop slip past it together.
 *
 * A fixed window admits up to twice the limit across a boundary — the last second
 * of one window plus the first of the next. That is documented in the migration
 * rather than fixed, because the alternatives cost more than this limit is worth.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Count after this request, including it. */
  count: number;
  limit: number;
  /** Seconds until the window rolls over. */
  retryAfterSeconds: number;
  windowStart: number;
}

/**
 * Consume one unit from `bucket`, returning whether it was allowed.
 *
 * The unit is consumed even when the request is then rejected. That is
 * intentional: it keeps the counter monotonic, so a client hammering the endpoint
 * stays rejected instead of resetting its own budget by continuing to hammer.
 */
export async function consumeRateLimit(
  db: D1Database,
  bucket: string,
  limit: number,
  windowSeconds: number,
  now: number,
): Promise<RateLimitDecision> {
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;

  const row = await db
    .prepare(
      `INSERT INTO rate_limit (bucket, window_start, count)
       VALUES (?1, ?2, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>();

  const count = row?.count ?? 1;
  return {
    allowed: count <= limit,
    count,
    limit,
    retryAfterSeconds: Math.max(1, windowStart + windowSeconds - now),
    windowStart,
  };
}

/** Drop windows that have fully expired. Called from the retention pass. */
export async function pruneRateLimits(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare("DELETE FROM rate_limit WHERE window_start < ?1")
    .bind(now - 86_400)
    .run();
  return result.meta.changes ?? 0;
}
