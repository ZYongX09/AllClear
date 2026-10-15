import { describe, expect, it } from "vitest";

import { aggregateDayUptime, type SnapshotDay } from "../src/snapshot";

/**
 * The number printed above a component's calendar.
 *
 * It is a fold over the stored daily rows, so the two ways it can lie are the
 * two ways the rows can: counting an unmeasured day as healthy, and letting a
 * component with a second of coverage weigh as much as one with a month.
 */

function day(overrides: Partial<SnapshotDay> = {}): SnapshotDay {
  return {
    day: "2026-01-01",
    uptime: 1,
    status: "operational",
    coveredSeconds: 86_400,
    unknownSeconds: 0,
    ...overrides,
  };
}

describe("aggregateDayUptime", () => {
  it("returns null with no days at all", () => {
    expect(aggregateDayUptime([])).toBeNull();
  });

  it("skips days that were never measured", () => {
    // `uptime: null` means nothing was measurable. Folding it in as 1.0 would
    // manufacture a perfect record out of an absence of measurement; folding it
    // in as 0 would invent an outage.
    const measured = day({ uptime: 0.5, coveredSeconds: 3_600 });
    expect(aggregateDayUptime([measured, day({ uptime: null, coveredSeconds: 0 })])).toBe(0.5);
  });

  it("returns null when every day is unmeasured", () => {
    expect(
      aggregateDayUptime([
        day({ uptime: null, coveredSeconds: 0 }),
        day({ uptime: null, coveredSeconds: 0 }),
      ]),
    ).toBeNull();
  });

  it("weights by covered seconds rather than averaging days", () => {
    // A day with a full 86400 covered seconds at 50%, and a day with one hour at
    // 0%. Averaging the two percentages gives 25%; summing the seconds gives
    // (43200 + 3600) / (86400 + 3600) = 0.5200.
    const result = aggregateDayUptime([
      day({ uptime: 0.5, coveredSeconds: 86_400 }),
      day({ uptime: 0, coveredSeconds: 3_600 }),
    ]);
    expect(result).toBeCloseTo(1 - 46_800 / 90_000, 12);
  });

  it("ignores a day whose covered seconds are zero even if uptime is set", () => {
    // Not reachable through `computeUptime`, which returns null whenever covered
    // seconds are zero — but a hand-written row must not be able to divide by
    // nothing.
    const result = aggregateDayUptime([
      day({ uptime: 0, coveredSeconds: 0 }),
      day({ uptime: 1, coveredSeconds: 3_600 }),
    ]);
    expect(result).toBe(1);
  });

  it("is exactly 1 when every measured day was clean", () => {
    expect(aggregateDayUptime([day(), day({ uptime: 1, coveredSeconds: 100 })])).toBe(1);
  });

  it("is exactly 0 when every measured second was down", () => {
    expect(aggregateDayUptime([day({ uptime: 0 }), day({ uptime: 0 })])).toBe(0);
  });

  it("clamps rather than returning a negative uptime", () => {
    // A hand-written row with a nonsensical negative uptime must not propagate.
    expect(aggregateDayUptime([day({ uptime: -3, coveredSeconds: 3_600 })])).toBe(0);
  });
});
