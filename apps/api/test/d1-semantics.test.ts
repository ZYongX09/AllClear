import { describe, expect, it } from "vitest";

import { testEnv as env } from "./env";

/**
 * Two measured properties of D1 that the probe state machine is built on.
 *
 * These are asserted rather than assumed because `transition.ts` takes its
 * concurrency design from them. If a future runtime change invalidates either,
 * the state machine's guarantees change with it and this file should fail first.
 *
 * Both were originally established by a scratch experiment that only logged its
 * findings; keeping them as assertions means the assumption is checked on every
 * run rather than recorded in a comment nobody re-reads.
 */
describe("D1 concurrency semantics", () => {
  it("lets exactly one of two concurrent compare-and-swaps apply", async () => {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS cas_probe (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
    ).run();
    await env.DB.prepare("DELETE FROM cas_probe").run();
    await env.DB.prepare("INSERT INTO cas_probe (id, n) VALUES (1, 0)").run();

    const compareAndSwap = () =>
      env.DB.batch([
        env.DB.prepare("UPDATE cas_probe SET n = n + 1 WHERE id = 1 AND n = 0"),
      ]);

    const [a, b] = await Promise.all([compareAndSwap(), compareAndSwap()]);
    const row = await env.DB.prepare("SELECT n FROM cas_probe WHERE id = 1").first<{ n: number }>();

    // This is the property the transition's guard depends on: a zero-row UPDATE
    // is reported as `changes: 0`, not as an error, and the two batches do not
    // both see the pre-update value.
    const changes = [a[0]?.meta.changes, b[0]?.meta.changes].sort();
    expect(changes).toEqual([0, 1]);
    expect(row?.n).toBe(1);
  });

  it("rejects the loser when two concurrent batches insert the same unique key", async () => {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS uniq_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL UNIQUE)",
    ).run();
    await env.DB.prepare("DELETE FROM uniq_probe").run();

    const insert = () => env.DB.batch([env.DB.prepare("INSERT INTO uniq_probe (k) VALUES ('same')")]);

    const settled = await Promise.allSettled([insert(), insert()]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");

    // A constraint violation is a reachable outcome of a race, not a bug, which
    // is why `transition.ts` translates it into a retry instead of throwing.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.status === "rejected" ? rejected[0].reason : "")).toMatch(
      /UNIQUE constraint failed|SQLITE_CONSTRAINT/,
    );

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM uniq_probe").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
