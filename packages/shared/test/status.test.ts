import { describe, expect, it } from "vitest";

import {
  aggregateStatus,
  deriveComponentStatus,
  deriveEventStatus,
  isImpactActive,
  worstFault,
  type Derivation,
  type DeriveInput,
  type EventEvidence,
  type ImpactWindow,
  type MaintenanceWindow,
  type MonitoringEvidence,
} from "../src/status";

const NOW = 1_700_000_000;
const FRESHNESS_MAX = 300;

const impact = (over: Partial<ImpactWindow> = {}): ImpactWindow => ({
  severity: "full_outage",
  startsAt: NOW - 60,
  endsAt: null,
  ...over,
});

const maintenance = (over: Partial<MaintenanceWindow> = {}): MaintenanceWindow => ({
  status: "in_progress",
  startsAt: NOW - 60,
  endsAt: null,
  ...over,
});

const okProbe = (lastProbeAt = NOW - 10): MonitoringEvidence => ({
  kind: "probe",
  lastProbeAt,
  ok: true,
});
const failingProbe = (lastProbeAt = NOW - 10): MonitoringEvidence => ({
  kind: "probe",
  lastProbeAt,
  ok: false,
});
const uncovered: MonitoringEvidence = { kind: "uncovered" };

function events(over: Partial<EventEvidence> = {}): EventEvidence {
  return { impacts: [], maintenances: [], ...over };
}

function derive(
  eventEvidence: Partial<EventEvidence>,
  monitoring: MonitoringEvidence = okProbe(),
): Derivation {
  const input: DeriveInput = {
    events: events(eventEvidence),
    monitoring,
    statusFreshnessMax: FRESHNESS_MAX,
  };
  return deriveComponentStatus(input, NOW);
}

describe("worstFault", () => {
  it("orders the three severities", () => {
    expect(worstFault("degraded_performance", "partial_outage")).toBe("partial_outage");
    expect(worstFault("partial_outage", "full_outage")).toBe("full_outage");
    expect(worstFault("degraded_performance", "full_outage")).toBe("full_outage");
  });

  it("is order-independent", () => {
    const all = ["degraded_performance", "partial_outage", "full_outage"] as const;
    for (const a of all) {
      for (const b of all) {
        expect(worstFault(a, b)).toBe(worstFault(b, a));
      }
    }
  });
});

describe("isImpactActive", () => {
  it("treats the window as half-open [start, end)", () => {
    expect(isImpactActive(impact({ startsAt: NOW, endsAt: null }), NOW)).toBe(true);
    expect(isImpactActive(impact({ startsAt: NOW + 1, endsAt: null }), NOW)).toBe(false);
    expect(isImpactActive(impact({ startsAt: NOW - 10, endsAt: NOW }), NOW)).toBe(false);
    expect(isImpactActive(impact({ startsAt: NOW - 10, endsAt: NOW + 1 }), NOW)).toBe(true);
  });
});

describe("deriveEventStatus", () => {
  it("returns null when no event is active", () => {
    expect(deriveEventStatus(events(), NOW)).toBeNull();
  });

  it("takes the worst of several concurrently active impacts", () => {
    const result = deriveEventStatus(
      events({
        impacts: [
          impact({ severity: "degraded_performance" }),
          impact({ severity: "partial_outage" }),
          impact({ severity: "full_outage" }),
        ],
      }),
      NOW,
    );
    expect(result).toBe("full_outage");
  });

  it("does not let a smaller active impact mask a larger one", () => {
    const result = deriveEventStatus(
      events({ impacts: [impact({ severity: "full_outage" }), impact({ severity: "partial_outage" })] }),
      NOW,
    );
    expect(result).toBe("full_outage");
  });

  it("ignores an impact that has not started yet", () => {
    expect(
      deriveEventStatus(events({ impacts: [impact({ startsAt: NOW + 60 })] }), NOW),
    ).toBeNull();
  });

  it("ignores an impact that has already ended", () => {
    expect(
      deriveEventStatus(events({ impacts: [impact({ endsAt: NOW - 1 })] }), NOW),
    ).toBeNull();
  });

  it("treats scheduled maintenance as contributing nothing", () => {
    expect(
      deriveEventStatus(events({ maintenances: [maintenance({ status: "scheduled" })] }), NOW),
    ).toBeNull();
  });

  it("treats completed maintenance as contributing nothing", () => {
    expect(
      deriveEventStatus(events({ maintenances: [maintenance({ status: "completed" })] }), NOW),
    ).toBeNull();
  });

  it("reports maintenance while it is in progress inside its window", () => {
    expect(
      deriveEventStatus(
        events({ maintenances: [maintenance({ startsAt: NOW - 10, endsAt: NOW + 600 })] }),
        NOW,
      ),
    ).toBe("maintenance");
  });

  it("does not report maintenance before its window opens", () => {
    expect(
      deriveEventStatus(
        events({ maintenances: [maintenance({ startsAt: NOW + 1, endsAt: NOW + 600 })] }),
        NOW,
      ),
    ).toBeNull();
  });

  it("does not report maintenance once its window has closed", () => {
    expect(
      deriveEventStatus(
        events({ maintenances: [maintenance({ startsAt: NOW - 600, endsAt: NOW })] }),
        NOW,
      ),
    ).toBeNull();
  });

  it("prefers a fault over an overlapping maintenance window", () => {
    expect(
      deriveEventStatus(
        events({
          impacts: [impact({ severity: "partial_outage" })],
          maintenances: [maintenance()],
        }),
        NOW,
      ),
    ).toBe("partial_outage");
  });
});

describe("deriveComponentStatus — monitoring evidence", () => {
  it("is operational only when a fresh probe says so", () => {
    expect(derive({}, okProbe())).toEqual({ status: "operational", reason: "monitoring_ok" });
  });

  it("is unknown when no probe target exists", () => {
    expect(derive({}, uncovered)).toEqual({
      status: "unknown",
      reason: "monitoring_uncovered",
    });
  });

  it("is unknown when the probe data is older than the freshness threshold", () => {
    const result = derive({}, okProbe(NOW - FRESHNESS_MAX - 1));
    expect(result).toEqual({ status: "unknown", reason: "monitoring_stale" });
  });

  it("still counts a probe result exactly at the freshness boundary", () => {
    expect(derive({}, okProbe(NOW - FRESHNESS_MAX))).toEqual({
      status: "operational",
      reason: "monitoring_ok",
    });
  });

  it("does not report a fresh failing probe as operational", () => {
    expect(derive({}, failingProbe())).toEqual({
      status: "unknown",
      reason: "monitoring_failing_unclassified",
    });
  });

  it("never reports operational when the probe has stopped reporting", () => {
    // The whole point of the second stage: a stopped probe is silence, and
    // silence is not uptime.
    for (const stale of [okProbe(NOW - 10_000), failingProbe(NOW - 10_000)]) {
      expect(derive({}, stale).status).toBe("unknown");
    }
  });
});

describe("deriveComponentStatus — events take precedence over monitoring", () => {
  it("reports an active fault even with no probe coverage", () => {
    // An incident is direct evidence. It does not need a probe to corroborate it.
    expect(derive({ impacts: [impact({ severity: "partial_outage" })] }, uncovered)).toEqual({
      status: "partial_outage",
      reason: "active_fault",
    });
  });

  it("reports an active fault even when a fresh probe looks healthy", () => {
    expect(derive({ impacts: [impact({ severity: "full_outage" })] }, okProbe()).status).toBe(
      "full_outage",
    );
  });

  it("reports maintenance even with no probe coverage", () => {
    // Maintenance is declared, not measured, so missing coverage does not make
    // it unknown.
    expect(derive({ maintenances: [maintenance()] }, uncovered)).toEqual({
      status: "maintenance",
      reason: "active_maintenance",
    });
  });
});

describe("deriveComponentStatus — resolving one incident does not clear another", () => {
  it("keeps the component degraded while a second impact is still open", () => {
    const result = derive({
      impacts: [
        // Incident A: resolved, so its interval is closed.
        impact({ severity: "partial_outage", startsAt: NOW - 3600, endsAt: NOW - 60 }),
        // Incident B: still open.
        impact({ severity: "degraded_performance", startsAt: NOW - 30, endsAt: null }),
      ],
    });

    expect(result).toEqual({ status: "degraded_performance", reason: "active_fault" });
  });

  it("does not fall back to operational when a resolved incident is the only one", () => {
    // With the incident closed the component is driven by monitoring, and here
    // the probe is still failing — so it is unknown, not operational.
    const result = derive(
      { impacts: [impact({ severity: "full_outage", endsAt: NOW - 60 })] },
      failingProbe(),
    );
    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("monitoring_failing_unclassified");
  });

  it("becomes operational once the last incident closes and the probe agrees", () => {
    const result = derive({ impacts: [impact({ endsAt: NOW - 60 })] }, okProbe());
    expect(result).toEqual({ status: "operational", reason: "monitoring_ok" });
  });
});

describe("aggregateStatus", () => {
  it("is unknown for an empty group", () => {
    expect(aggregateStatus([])).toBe("unknown");
  });

  it("takes the worst fault in the group", () => {
    expect(
      aggregateStatus(["operational", "degraded_performance", "full_outage", "maintenance"]),
    ).toBe("full_outage");
  });

  it("lets unknown outrank benign states", () => {
    // A group is not healthy merely because the members that can be measured
    // are healthy.
    expect(aggregateStatus(["operational", "unknown"])).toBe("unknown");
    expect(aggregateStatus(["maintenance", "unknown"])).toBe("unknown");
  });

  it("is operational only when every member is operational", () => {
    expect(aggregateStatus(["operational", "operational"])).toBe("operational");
    expect(aggregateStatus(["operational", "maintenance"])).toBe("maintenance");
  });
});
