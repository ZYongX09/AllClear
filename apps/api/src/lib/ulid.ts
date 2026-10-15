/**
 * ULID generation.
 *
 * 48-bit big-endian millisecond timestamp followed by 80 bits of randomness,
 * Crockford base32 encoded — 26 characters, lexicographically sortable by
 * creation time.
 *
 * Written out rather than pulled in as a dependency for one reason that matters
 * here: the probe transition uses an id it generated *itself* as the
 * idempotency key for a retryable database operation, so the generator must be
 * available at exactly the call sites that need it and must not be able to
 * block or fail. This has no dependencies and no I/O.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 48 bits of timestamp fit in 10 base32 characters (50 bits, top two zero). */
const TIME_CHARS = 10;
/** 80 bits of randomness are exactly 16 base32 characters. */
const RANDOM_CHARS = 16;

export function ulid(
  now: number = Date.now(),
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(10)),
): string {
  if (random.length !== 10) {
    throw new Error(`ulid: expected 10 random bytes, got ${random.length}`);
  }

  let remaining = now;
  let time = "";
  for (let i = 0; i < TIME_CHARS; i += 1) {
    time = ENCODING[remaining % 32]! + time;
    remaining = Math.floor(remaining / 32);
  }

  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);

  let suffix = "";
  for (let i = 0; i < RANDOM_CHARS; i += 1) {
    suffix = ENCODING[Number(bits & 31n)]! + suffix;
    bits >>= 5n;
  }

  return time + suffix;
}
