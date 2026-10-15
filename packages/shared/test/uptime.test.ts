import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEIGHTS,
  aggregateUptime,
  clamp01,
  computeCoverageIntervals,
  computeUptime,
  defaultCoverageGapMax,
  startOfUtcDay,
  utcDay,
  type Interval,
  type UptimeImpact,
  type UptimeInput,
  type UptimeMaintenance,
} from "../src/uptime";

/**
 * The M3 gate.
 *
 * Every case below is a way the uptime number can be wrong while still looking
 * plausible, which is why they are asserted against exact seconds rather than
 * against a range. The two that matter most are the cross-severity overlap (a
 * naive implementation charges the same minute twice and reports an uptime below
 * zero) and the stalled-prober case (a naive implementation charges an
 * unmonitored week as downtime).
 */

const DAY = 86_400;
const W0 = 1_699_920_000; // start of a UTC day
const W1 = W0 + DAY;
const AVAILABLE = W0 - 30 * DAY;
/** Evaluation time for a *complete* window: just past its end. */
const NOW = W1 + 1;

function window(over: Partial<UptimeInput> = {}): UptimeInput {
  return {
    windowStart: W0,
    windowEnd: W1,
    availableSince: AVAILABLE,
    now: NOW,
    impacts: [],
    maintenances: [],
    coverage: [{ start: W0, end: W1 }],
    ...over,
  };
}

function probe(
  severity: UptimeImpact["severity"],
  startAt: number,
  endAt: number | null,
): UptimeImpact {
  return { severity, startAt, endAt, source: "probe" };
}

function manual(
  severity: UptimeImpact["severity"],
  startAt: number,
  endAt: number | null,
): UptimeImpact {
  return { severity, startAt, endAt, source: "manual" };
}

function maintenance(startAt: number, endAt: number | null): UptimeMaintenance {
  return { startAt, endAt };
}

function fullCoverage(): Interval {
  return { start: W0, end: W1 };
}

describe("a window with no faults", () => {
  it("reports 100% when covered and clean", () => {
    const result = computeUptime(window());
    expect(result.uptime).toBe(1);
    expect(result.coveredSeconds).toBe(DAY);
    expect(result.unknownSeconds).toBe(0);
    expect(result.weightedDowntimeSeconds).toBe(0);
    expect(result.worstStatus).toBe("operational");
    expect(result.partial).toBe(false);
    expect(result.ongoing).toBe(false);
  });

  it("charges a single fault at its weight", () => {
    const result = computeUptime(
      window({ impacts: [probe("full_outage", W0, W0 + 3600)] }),
    );
    expect(result.weightedDowntimeSeconds).toBe(3600);
    expect(result.uptime).toBeCloseTo(1 - 3600 / DAY, 10);
    expect(result.worstStatus).toBe("full_outage");
  });
});

describe("overlap is charged once, at the worst weight", () => {
  it("does not double-charge a partial and a full outage covering the same hour", () => {
    // The naive calculation — union the intervals per severity, then add the
    // severities — charges this hour twice: 3600 x 1.0 plus 3600 x 0.5. That is
    // 5400 seconds of downtime inside a 3600-second span, and an uptime that
    // falls below zero once the overlap is large enough.
    const result = computeUptime(
      window({
        impacts: [
          probe("full_outage", W0, W0 + 3600),
          probe("partial_outage", W0, W0 + 3600),
        ],
      }),
    );

    const naiveUnionThenSum = 3600 * DEFAULT_WEIGHTS.full_outage + 3600 * DEFAULT_WEIGHTS.partial_outage;
    expect(naiveUnionThenSum).toBe(5400);
    expect(result.weightedDowntimeSeconds).toBe(3600);
    expect(result.weightedDowntimeSeconds).not.toBe(naiveUnionThenSum);
    expect(result.uptime).toBeGreaterThan(0);
    expect(result.worstStatus).toBe("full_outage");
  });

  it("charges only the overlap once when two faults partially overlap", () => {
    const result = computeUptime(
      window({
        impacts: [
          probe("full_outage", W0, W0 + 3600),
          probe("partial_outage", W0 + 1800, W0 + 5400),
        ],
      }),
    );
    // [0,1800) at 1.0, [1800,3600) at 1.0, [3600,5400) at 0.5
    expect(result.weightedDowntimeSeconds).toBe(1800 + 1800 + 900);
    expect(result.worstStatus).toBe("full_outage");
  });

  it("unions same-severity overlaps instead of adding them", () => {
    const result = computeUptime(
      window({
        impacts: [
          probe("degraded_performance", W0, W0 + 3600),
          probe("degraded_performance", W0 + 1800, W0 + 5400),
        ],
      }),
    );
    // Union is 5400 s at 0.25. Summing the two intervals would give 1800.
    expect(result.weightedDowntimeSeconds).toBeCloseTo(5400 * 0.25, 10);
    expect(result.weightedDowntimeSeconds).not.toBeCloseTo(2 * 3600 * 0.25, 10);
  });

  it("never produces an uptime below zero even with an extreme weight", () => {
    const result = computeUptime(
      window({
        impacts: [probe("full_outage", W0, W1)],
        weights: { ...DEFAULT_WEIGHTS, full_outage: 4 },
      }),
    );
    expect(result.uptime).toBe(0);
  });
});

describe("windows that do not line up with the day boundary", () => {
  it("splits a fault that crosses midnight without double counting or losing time", () => {
    const crossing = probe("full_outage", W1 - 1800, W1 + 1800);

    const yesterday = computeUptime(window({ impacts: [crossing] }));
    // `now` has to be past the part of the fault that falls on the second day,
    // otherwise the "today" window is clipped to the instant after midnight.
    const today = computeUptime(
      window({
        windowStart: W1,
        windowEnd: W1 + DAY,
        now: W1 + 3600,
        impacts: [crossing],
        coverage: [{ start: W1, end: W1 + DAY }],
      }),
    );

    expect(yesterday.weightedDowntimeSeconds).toBe(1800);
    expect(today.weightedDowntimeSeconds).toBe(1800);
    // The two days account for the whole fault, once each.
    expect(yesterday.weightedDowntimeSeconds + today.weightedDowntimeSeconds).toBe(3600);
  });
});

describe("the window is clipped to the component's lifetime and to now", () => {
  it("returns null when the component did not exist yet", () => {
    const result = computeUptime(
      window({ availableSince: W1 + 100, now: W1 + 200 }),
    );
    expect(result.uptime).toBeNull();
    expect(result.coveredSeconds).toBe(0);
    expect(result.segments).toEqual([]);
  });

  it("measures only the part of the window after the component existed", () => {
    const result = computeUptime(window({ availableSince: W0 + 3600 }));
    expect(result.coveredSeconds).toBe(DAY - 3600);
    expect(result.uptime).toBe(1);
  });

  it("marks a window that extends past now as partial and does not extrapolate", () => {
    const result = computeUptime(window({ windowEnd: W1, now: W0 + 3600 }));
    expect(result.partial).toBe(true);
    expect(result.coveredSeconds).toBe(3600);
    expect(result.uptime).toBe(1);
  });

  it("marks an open impact as ongoing", () => {
    const result = computeUptime(
      window({ impacts: [probe("full_outage", W0 + 1800, null)], now: W0 + 3600 }),
    );
    expect(result.ongoing).toBe(true);
    expect(result.weightedDowntimeSeconds).toBe(1800);
  });
});

describe("maintenance is excluded from the denominator, but cannot hide a fault", () => {
  it("returns null rather than 100% when maintenance covers the whole window", () => {
    const result = computeUptime(window({ maintenances: [maintenance(W0, W1)] }));
    expect(result.uptime).toBeNull();
    expect(result.coveredSeconds).toBe(0);
    expect(result.excludedSeconds).toBe(DAY);
    expect(result.worstStatus).toBe("maintenance");
  });

  it("keeps a fault that falls inside a maintenance window in the record", () => {
    const result = computeUptime(
      window({
        maintenances: [maintenance(W0, W1)],
        impacts: [probe("full_outage", W0, W0 + 3600)],
      }),
    );
    // The other 23 hours are still excluded, but the outage is not laundered.
    expect(result.excludedSeconds).toBe(DAY - 3600);
    expect(result.coveredSeconds).toBe(3600);
    expect(result.weightedDowntimeSeconds).toBe(3600);
    expect(result.uptime).toBe(0);
    expect(result.worstStatus).toBe("full_outage");
  });
});

describe("downtime requires evidence", () => {
  it("returns null, not 100%, when there is no coverage at all", () => {
    const result = computeUptime(window({ coverage: [] }));
    expect(result.uptime).toBeNull();
    expect(result.coveredSeconds).toBe(0);
    expect(result.unknownSeconds).toBe(DAY);
    expect(result.worstStatus).toBe("unknown");
  });

  it("returns null on a completely empty input", () => {
    const result = computeUptime(
      window({ impacts: [], maintenances: [], coverage: [] }),
    );
    expect(result.uptime).toBeNull();
    expect(result.worstStatus).toBe("unknown");
  });

  it("does not charge an open fault to time the prober stopped covering", () => {
    // Coverage exists for the first hour and then stops. A fault opens 30
    // minutes in and is never closed, because the prober that would have closed
    // it is the thing that broke. The unmonitored 23 hours must not be charged
    // as downtime.
    const result = computeUptime(
      window({
        coverage: [{ start: W0, end: W0 + 3600 }],
        impacts: [probe("full_outage", W0 + 1800, null)],
      }),
    );

    expect(result.coveredSeconds).toBe(3600);
    expect(result.unknownSeconds).toBe(DAY - 3600);
    expect(result.weightedDowntimeSeconds).toBe(1800);
    expect(result.uptime).toBeCloseTo(0.5, 10);
    expect(result.ongoing).toBe(true);
  });

  it("counts a hand-entered fault even where no probe covers it", () => {
    const result = computeUptime(
      window({ coverage: [], impacts: [manual("full_outage", W0, W0 + 3600)] }),
    );
    expect(result.coveredSeconds).toBe(3600);
    expect(result.weightedDowntimeSeconds).toBe(3600);
    expect(result.uptime).toBe(0);
    expect(result.worstStatus).toBe("full_outage");
  });

  it("reports unknown for a day that is mostly unmeasured", () => {
    const result = computeUptime(
      window({ coverage: [{ start: W0, end: W0 + 3600 }] }),
    );
    expect(result.worstStatus).toBe("unknown");
    expect(result.unknownSeconds).toBeGreaterThan(result.coveredSeconds);
  });
});

describe("coverage intervals", () => {
  it("produces nothing from a single observation", () => {
    // One sample cannot bracket an interval, so there is nothing to intersect a
    // fault with. A component probed once is uncovered, not fully covered.
    expect(computeCoverageIntervals([W0], 120)).toEqual([]);
  });

  it("merges adjacent observations into one run", () => {
    expect(computeCoverageIntervals([W0, W0 + 60, W0 + 120, W0 + 180], 120)).toEqual([
      { start: W0, end: W0 + 180 },
    ]);
  });

  it("breaks the run where the gap exceeds the maximum", () => {
    expect(computeCoverageIntervals([W0, W0 + 60, W0 + 1000, W0 + 1060], 120)).toEqual([
      { start: W0, end: W0 + 60 },
      { start: W0 + 1000, end: W0 + 1060 },
    ]);
  });

  it("does not extend coverage past the final observation", () => {
    const intervals = computeCoverageIntervals([W0, W0 + 60], 120);
    expect(intervals).toEqual([{ start: W0, end: W0 + 60 }]);
  });

  it("uses max(2 x interval, 120) as the default gap", () => {
    expect(defaultCoverageGapMax(60)).toBe(120);
    expect(defaultCoverageGapMax(10)).toBe(120);
    expect(defaultCoverageGapMax(600)).toBe(1200);
  });
});

describe("aggregation sums seconds rather than averaging percentages", () => {
  it("weights each component by the evidence it contributed", () => {
    const barelyCovered = computeUptime(
      window({
        coverage: [{ start: W0, end: W0 + 100 }],
        impacts: [probe("full_outage", W0, W0 + 100)],
      }),
    );
    const wellCovered = computeUptime(
      window({ coverage: [{ start: W0, end: W0 + 10_000 }] }),
    );

    expect(barelyCovered.uptime).toBe(0);
    expect(wellCovered.uptime).toBe(1);

    const averaged = (0 + 1) / 2;
    const aggregated = aggregateUptime([barelyCovered, wellCovered]);
    expect(aggregated).not.toBeCloseTo(averaged, 3);
    expect(aggregated).toBeCloseTo(1 - 100 / 10_100, 10);
  });

  it("returns null when nothing contributed measurable time", () => {
    expect(aggregateUptime([])).toBeNull();
    expect(aggregateUptime([computeUptime(window({ coverage: [] }))])).toBeNull();
  });
});

describe("clamp01", () => {
  it("bounds and sanitises its input", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("day helpers", () => {
  it("round-trips a UTC day boundary", () => {
    expect(startOfUtcDay(W0 + 1234)).toBe(W0);
    expect(utcDay(W0)).toBe("2023-11-14");
    expect(utcDay(W1)).toBe("2023-11-15");
  });
});

describe("the sweep partition is complete", () => {
  it("covers the window exactly once with no gaps", () => {
    const result = computeUptime(
      window({
        coverage: [{ start: W0, end: W0 + 7200 }],
        impacts: [
          probe("partial_outage", W0 + 600, W0 + 3000),
          manual("full_outage", W0 + 2000, W0 + 5000),
        ],
        maintenances: [maintenance(W0 + 5000, W0 + 6000)],
      }),
    );

    const spanned = result.segments.reduce((total, segment) => total + (segment.end - segment.start), 0);
    expect(spanned).toBe(DAY);

    const accounted =
      result.coveredSeconds + result.unknownSeconds + result.excludedSeconds;
    expect(accounted).toBe(DAY);

    // No segment overlaps its neighbour.
    for (let i = 1; i < result.segments.length; i += 1) {
      expect(result.segments[i]!.start).toBe(result.segments[i - 1]!.end);
    }
  });
});
