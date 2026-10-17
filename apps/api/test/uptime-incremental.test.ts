import { beforeEach, describe, expect, it } from 'vitest';
import { computeDailyUptime, computeIncrementalDailyUptimeBatch, persistDailyUptime,
  type DailyUptimeRow } from '../src/lib/uptime-recompute';
import { runScheduledMaintenance } from '../src/lib/maintenance';
import { applyRetention } from '../src/lib/retention';
import { applyProbeObservation } from '../src/probe/transition';
import { testEnv as env } from './env';
import { createComponent, createPage, createProbeTarget } from './helpers';

const START = Date.parse('2026-05-10T00:00:00Z') / 1000;
const DAY = 86400;
let sequence = 0;
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM page').run();
  await env.DB.prepare('UPDATE maintenance_job SET next_run_at=0,lease_until=0,claim_token=NULL,completed_day=NULL,cursor_day=NULL,failures=0').run();
});
async function fixture() {
  const page = await createPage();
  const component = await createComponent(page.id, { availableSince: START - 4 * DAY });
  const target = await createProbeTarget(component.id);
  const observe = async (at: number, ok = true) => {
    expect((await applyProbeObservation(env.DB, { targetId: target.id,
      observedAt: at, ok, resultId: `incremental-${++sequence}` })).kind).toBe('applied');
  };
  return { page, component, target, observe };
}
function publicValues(row: DailyUptimeRow) {
  return { covered: row.coveredSeconds, unknown: row.unknownSeconds,
    weighted: row.downtimeWeighted, uptime: row.uptime, status: row.worstStatus };
}
async function refresh(componentId: number, now: number, day = '2026-05-10') {
  const row = (await computeIncrementalDailyUptimeBatch(env.DB, [{ componentId, day }], now))[0]!;
  const oracle = (await computeDailyUptime(env.DB, componentId, day, now))!;
  expect(publicValues(row)).toEqual(publicValues(oracle));
  await persistDailyUptime(env.DB, row, now);
  return row;
}

describe('exact incremental daily prefixes', () => {
  it('never commits the unknown tail and repairs it with an actual successor', async () => {
    const f = await fixture();
    await f.observe(START + 10);
    const single = await refresh(f.component.id, START + 100);
    expect(single.coveredSeconds).toBe(0);
    expect(single.prefix!.at).toBe(START + 10);
    expect(single.prefix!.unknown).toBe(10);
    await f.observe(START + 110);
    const bracketed = await refresh(f.component.id, START + 115);
    expect(bracketed.coveredSeconds).toBe(100);
    expect(bracketed.unknownSeconds).toBe(15);
    await refresh(f.component.id, START + 200);
    await f.observe(START + 231); // strict gap > 120: no coverage across it
    const gap = await refresh(f.component.id, START + 240);
    expect(gap.coveredSeconds).toBe(100);
    await f.observe(START + 351); // gap exactly 120 is covered
    expect((await refresh(f.component.id, START + 360)).coveredSeconds).toBe(220);
  });

  it('tracks additive worst-fault durations, manual evidence and maintenance overlap', async () => {
    const f = await fixture();
    for (let at = START; at <= START + 600; at += 60) await f.observe(at);
    await refresh(f.component.id, START + 300);
    await env.DB.prepare(`INSERT INTO impact(public_id,component_id,severity,start_at,end_at,created_at,updated_at)
      VALUES('partial',?1,'partial_outage',?2,?3,?2,?2),('full',?1,'full_outage',?4,?3,?4,?4)`)
      .bind(f.component.id, START + 100, START + 400, START + 200).run();
    await env.DB.prepare(`INSERT INTO change(public_id,page_id,kind,status,title,severity,starts_at,ends_at,created_at,updated_at)
      VALUES('maint',?1,'maintenance','completed','work','none',?2,?3,?2,?2)`)
      .bind(f.page.id, START, START + 500).run();
    await env.DB.prepare(`INSERT INTO change_component(change_id,component_id)
      SELECT id,?1 FROM change WHERE public_id='maint'`).bind(f.component.id).run();
    const faults = await refresh(f.component.id, START + 600);
    expect(faults.downtimeWeighted).toBe(250);
    expect(faults.prefix!.full).toBe(200);
    await env.DB.prepare("DELETE FROM impact WHERE public_id='full'").run();
    const removed = await refresh(f.component.id, START + 600);
    expect(removed.worstStatus).toBe('partial_outage');
    expect(removed.prefix!.full).toBe(0);
    await env.DB.prepare("DELETE FROM impact WHERE public_id='partial'").run();
    expect((await refresh(f.component.id, START + 600)).worstStatus).toBe('maintenance');
    await env.DB.prepare('DELETE FROM probe_target WHERE id=?1').bind(f.target.id).run();
    await refresh(f.component.id, START + 700);
  });

  it('rebuilds retroactive first failure and first recovery, including older days', async () => {
    const f = await fixture();
    await f.observe(START - 2 * DAY);
    await f.observe(START - 2 * DAY + 60, false);
    await refresh(f.component.id, START - 2 * DAY + 70, '2026-05-08');
    await f.observe(START - 2 * DAY + 120, false);
    await refresh(f.component.id, START - 2 * DAY + 130, '2026-05-08');
    await f.observe(START - 2 * DAY + 180, false);
    expect((await refresh(f.component.id, START - 2 * DAY + 190, '2026-05-08')).downtimeWeighted).toBe(60);
    await f.observe(START - 2 * DAY + 240, true);
    await refresh(f.component.id, START - 2 * DAY + 250, '2026-05-08');
    await f.observe(START - 2 * DAY + 300, true);
    expect((await refresh(f.component.id, START - 2 * DAY + 310, '2026-05-08')).downtimeWeighted).toBe(90);
    // A much later edit must be repaired despite being outside today/yesterday.
    await env.DB.prepare("UPDATE impact SET severity='full_outage' WHERE component_id=?1").bind(f.component.id).run();
    await env.DB.prepare("UPDATE maintenance_job SET next_run_at=?1 WHERE job<>'repair'").bind(START + DAY).run();
    const repaired = await runScheduledMaintenance(env.DB, START + 600);
    expect(repaired.errors).toEqual([]);
    expect(repaired.rolledUp).toBe(1);
    const stored = await env.DB.prepare("SELECT downtime_weighted FROM daily_uptime WHERE component_id=?1 AND day='2026-05-08'")
      .bind(f.component.id).first<{ downtime_weighted: number }>();
    expect(stored!.downtime_weighted).toBe(180);
  });

  it('requires an observed midnight successor and never reuses an oracle tail', async () => {
    const f = await fixture();
    await f.observe(START + DAY - 30);
    const before = await refresh(f.component.id, START + DAY + 20);
    expect(before.coveredSeconds).toBe(0);
    await f.observe(START + DAY + 30);
    expect((await refresh(f.component.id, START + DAY + 30)).coveredSeconds).toBe(30);
    const oracle = (await computeDailyUptime(env.DB, f.component.id, '2026-05-10', START + DAY + 40))!;
    await persistDailyUptime(env.DB, oracle, START + DAY + 40);
    expect((await refresh(f.component.id, START + DAY + 50)).prefix!.at).toBe(START + DAY);
  });

  it('guards mutation races, backwards time and same-revision cursor regression', async () => {
    const f = await fixture();
    await f.observe(START);
    const old = await refresh(f.component.id, START + 10);
    await f.observe(START + 60);
    await refresh(f.component.id, START + 70);
    await persistDailyUptime(env.DB, old, START + 80);
    let stored = await env.DB.prepare('SELECT prefix_state FROM daily_uptime WHERE component_id=?1')
      .bind(f.component.id).first<{ prefix_state: string }>();
    expect(JSON.parse(stored!.prefix_state).at).toBe(START + 60);
    await env.DB.prepare('UPDATE probe_target SET interval_seconds=300 WHERE id=?1').bind(f.target.id).run();
    await persistDailyUptime(env.DB, old, START + 100);
    await refresh(f.component.id, START + 50); // new revision can legitimately reset time/cursor
    stored = await env.DB.prepare('SELECT prefix_state FROM daily_uptime WHERE component_id=?1')
      .bind(f.component.id).first<{ prefix_state: string }>();
    expect(JSON.parse(stored!.prefix_state).at).toBe(START);
  });

  it('materializes missing retained days and restarts repair after a second edit', async () => {
    const f = await fixture();
    const old = START - 10 * DAY;
    await env.DB.prepare('UPDATE component SET available_since=?2,rollup_dirty_from=NULL WHERE id=?1')
      .bind(f.component.id,old-DAY).run();
    await env.DB.prepare('UPDATE component SET rollup_dirty_from=NULL,rollup_dirty=0 WHERE id=?1')
      .bind(f.component.id).run();
    await env.DB.prepare(`INSERT INTO impact(public_id,component_id,severity,start_at,end_at,created_at,updated_at)
      VALUES('backdated-missing',?1,'partial_outage',?2,?3,?2,?2)`)
      .bind(f.component.id, old + 60,old + 120).run();
    await env.DB.prepare("UPDATE maintenance_job SET next_run_at=?1 WHERE job<>'repair'").bind(START + DAY).run();
    expect((await runScheduledMaintenance(env.DB,START + 600)).rolledUp).toBe(1);
    expect(await env.DB.prepare("SELECT covered_seconds,downtime_weighted FROM daily_uptime WHERE component_id=?1 AND day='2026-04-30'")
      .bind(f.component.id).first()).toEqual({ covered_seconds: 60,downtime_weighted: 30 });
    await env.DB.prepare("UPDATE impact SET severity='full_outage' WHERE public_id='backdated-missing'").run();
    expect((await runScheduledMaintenance(env.DB,START + 660)).rolledUp).toBe(1);
    expect(await env.DB.prepare("SELECT downtime_weighted FROM daily_uptime WHERE component_id=?1 AND day='2026-04-30'")
      .bind(f.component.id).first()).toEqual({ downtime_weighted: 60 });
    await runScheduledMaintenance(env.DB,START + 720);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_uptime WHERE component_id=?1")
      .bind(f.component.id).first()).toEqual({ n: 2 });
  });

  it('clips missing-day repair to retention and the archived watermark', async () => {
    const f = await fixture();
    await persistDailyUptime(env.DB,{ componentId:f.component.id,day:'2026-05-01',coveredSeconds:60,
      unknownSeconds:DAY-60,downtimeWeighted:0,uptime:1,worstStatus:'operational',archived:true },START);
    await env.DB.prepare(`INSERT INTO impact(public_id,component_id,severity,start_at,end_at,created_at,updated_at)
      VALUES('ancient',?1,'full_outage',?2,?3,?2,?2)`)
      .bind(f.component.id,START - 3650*DAY,START - 3650*DAY + 60).run();
    await env.DB.prepare("UPDATE maintenance_job SET next_run_at=?1 WHERE job<>'repair'").bind(START + DAY).run();
    await runScheduledMaintenance(env.DB,START + 600);
    expect((await env.DB.prepare('SELECT day FROM daily_uptime WHERE component_id=?1 ORDER BY day')
      .bind(f.component.id).all()).results).toEqual([{day:'2026-05-01'},{day:'2026-05-02'}]);
  });

  it('rejects an in-flight prefix when a historical sample fills its gap', async () => {
    const f = await fixture();
    await f.observe(START);
    await refresh(f.component.id,START + 1);
    await f.observe(START + 240);
    const pending = (await computeIncrementalDailyUptimeBatch(env.DB,[{componentId:f.component.id,day:'2026-05-10'}],START + 240))[0]!;
    expect(pending.coveredSeconds).toBe(0);
    await env.DB.prepare(`INSERT INTO probe_result(public_id,probe_target_id,observed_at,ok,created_at)
      VALUES('racing-backfill',?1,?2,1,?2)`).bind(f.target.id,START + 120).run();
    await persistDailyUptime(env.DB,pending,START + 240);
    expect(await env.DB.prepare('SELECT covered_seconds FROM daily_uptime WHERE component_id=?1')
      .bind(f.component.id).first()).toEqual({ covered_seconds:0 });
    expect((await refresh(f.component.id,START + 241)).coveredSeconds).toBe(240);
  });

  it('retains raw evidence when an event mutates between archival read and commit', async () => {
    const f = await fixture();
    await f.observe(START);
    await f.observe(START + 60);
    const result = await applyRetention(env.DB, START + 32 * DAY, {
      maxDays: 1,
      computeDay: async (db, componentId, day, now) => {
        const row = await computeDailyUptime(db, componentId, day, now);
        await db.prepare(`INSERT INTO impact(public_id,component_id,severity,start_at,end_at,created_at,updated_at)
          VALUES('archive-race',?1,'full_outage',?2,?3,?2,?2)`)
          .bind(componentId, START, START + 60).run();
        return row;
      },
    });
    expect(result.rollupFailures).toBe(1);
    expect(result.deleted).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM probe_result WHERE probe_target_id=?1')
      .bind(f.target.id).first()).toEqual({ n: 2 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_uptime WHERE component_id=?1 AND archived=1')
      .bind(f.component.id).first()).toEqual({ n: 0 });
    expect((await applyRetention(env.DB, START + 32 * DAY, { maxDays: 1 })).rollupFailures).toBe(0);
  });

  it('rejects a cold archive when a monotonic raw import arrives after its evidence read', async () => {
    const f = await fixture();
    await f.observe(START);
    await f.observe(START + 60);
    const result = await applyRetention(env.DB, START + 32 * DAY, {
      maxDays: 1,
      computeDay: async (db, componentId, day, now) => {
        const row = await computeDailyUptime(db, componentId, day, now);
        expect(row!.coveredSeconds).toBe(60);
        await db.prepare(`INSERT INTO probe_result(public_id,probe_target_id,observed_at,ok,created_at)
          VALUES('archive-monotonic-import',?1,?2,1,?2)`)
          .bind(f.target.id, START + 120).run();
        return row;
      },
    });
    expect(result.rollupFailures).toBe(1);
    expect(result.deleted).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM probe_result WHERE probe_target_id=?1')
      .bind(f.target.id).first()).toEqual({ n: 3 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_uptime WHERE component_id=?1 AND archived=1')
      .bind(f.component.id).first()).toEqual({ n: 0 });
    expect((await applyRetention(env.DB, START + 32 * DAY, { maxDays: 1 })).rollupFailures).toBe(0);
    expect(await env.DB.prepare('SELECT covered_seconds,archived FROM daily_uptime WHERE component_id=?1')
      .bind(f.component.id).first()).toEqual({ covered_seconds: 120, archived: 1 });
  });

  it('does not dirty revisions for healthy appends or scheduler timestamps', async () => {
    const f = await fixture();
    await f.observe(START);
    await refresh(f.component.id, START + 1);
    const before = await env.DB.prepare('SELECT rollup_revision FROM component WHERE id=?1').bind(f.component.id).first();
    await f.observe(START + 60);
    await env.DB.prepare('UPDATE probe_target SET updated_at=?2,next_check_at=?2 WHERE id=?1')
      .bind(f.target.id, START + 120).run();
    expect(await env.DB.prepare('SELECT rollup_revision FROM component WHERE id=?1').bind(f.component.id).first()).toEqual(before);
    await refresh(f.component.id, START + 70);
    await env.DB.prepare(`INSERT INTO probe_result(public_id,probe_target_id,observed_at,ok,created_at)
      VALUES('historical-backfill',?1,?2,1,?2)`).bind(f.target.id, START + 30).run();
    expect(await env.DB.prepare('SELECT rollup_revision FROM component WHERE id=?1').bind(f.component.id).first()).not.toEqual(before);
    await refresh(f.component.id, START + 80);
  });
});
