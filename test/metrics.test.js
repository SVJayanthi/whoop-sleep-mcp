import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhoopClient, TokenStore } from "../src/whoop.js";
import { summarizeSleep, sleepHrMetrics, nightlyRows, localDate } from "../src/metrics.js";
import { buildServer } from "../src/server.js";

// Shapes copied from the response samples at developer.whoop.com/api (synthetic values).
const sleep = (id, end, sws, rem, rr) => ({
  id, cycle_id: 1, start: new Date(Date.parse(end) - 8 * 3600e3).toISOString(), end, timezone_offset: "-08:00",
  nap: false, score_state: "SCORED",
  score: { stage_summary: { total_in_bed_time_milli: 8 * 3600e3, total_awake_time_milli: 1800e3, total_light_sleep_time_milli: 4 * 3600e3,
    total_slow_wave_sleep_time_milli: sws * 60e3, total_rem_sleep_time_milli: rem * 60e3, sleep_cycle_count: 4, disturbance_count: 9 },
    respiratory_rate: rr, sleep_efficiency_percentage: 92, sleep_consistency_percentage: 80, sleep_performance_percentage: 90 },
});
const rec = (sleep_id, rhr, hrv) => ({ cycle_id: 1, sleep_id, score_state: "SCORED",
  score: { user_calibrating: false, recovery_score: 60, resting_heart_rate: rhr, hrv_rmssd_milli: hrv, spo2_percentage: 96, skin_temp_celsius: 33.5 } });

test("localDate uses WHOOP offset", () => {
  assert.equal(localDate("2026-01-05T06:30:00.000Z", "-08:00"), "2026-01-04");
  assert.equal(localDate("2026-01-05T15:30:00.000Z", "-08:00"), "2026-01-05");
});

test("restorative = SWS + REM, HR metrics vs baseline, unavailable fields declared", () => {
  const s = [sleep("a", "2026-01-05T15:00:00Z", 90, 100, 15), sleep("b", "2026-01-04T15:00:00Z", 80, 90, 14), sleep("c", "2026-01-03T15:00:00Z", 70, 80, 16)];
  const r = [rec("a", 50, 60), rec("b", 52, 50), rec("c", 54, 40)];
  const rows = nightlyRows(s, r);
  assert.equal(summarizeSleep(rows[0].sleep).restorative_min, 190);
  const hist = rows.slice(1).map((x) => ({ ...summarizeSleep(x.sleep), resting_hr_bpm: x.recovery.score.resting_heart_rate, hrv_rmssd_ms: x.recovery.score.hrv_rmssd_milli }));
  const m = sleepHrMetrics(rows[0].sleep, rows[0].recovery, hist);
  assert.equal(m.resting_hr_bpm, 50);
  assert.equal(m.baseline.resting_hr_bpm, 53);
  assert.equal(m.vs_baseline.resting_hr_bpm, -3);
  assert.equal(m.vs_baseline.hrv_rmssd_ms, 15);
  assert.equal(m.vs_baseline.restorative_min, 30);
  assert.ok(m.not_available.includes("lowest_hr_bpm"));
});

test("client refreshes once, rotates refresh token, paginates", async () => {
  const file = join(tmpdir(), `whoop-test-${process.pid}.json`);
  const store = new TokenStore(file, { WHOOP_REFRESH_TOKEN: "r0" });
  let refreshes = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes("/oauth2/token")) {
      refreshes++;
      assert.match(String(init.body), /refresh_token=r0/);
      return new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3600 }));
    }
    assert.equal(init.headers.Authorization, "Bearer a1");
    const p = new URL(u);
    if (!p.searchParams.get("nextToken")) return new Response(JSON.stringify({ records: [1, 2], next_token: "t2" }));
    return new Response(JSON.stringify({ records: [3] }));
  };
  const c = new WhoopClient({ cfg: { clientId: "x", clientSecret: "y" }, store, fetchImpl });
  const [a, b] = await Promise.all([c.cycles({ maxRecords: 10 }), c.cycles({ maxRecords: 1 })]);
  assert.deepEqual(a, [1, 2, 3]);
  assert.deepEqual(b, [1]);
  assert.equal(refreshes, 1);
  assert.equal(store.load().refresh_token, "r1");
});

test("server registers the expected tools", () => {
  const s = buildServer(new WhoopClient({ cfg: { clientId: "x", clientSecret: "y" }, store: new TokenStore("/nonexistent", {}) }));
  const names = Object.keys(s._registeredTools).sort();
  assert.deepEqual(names, ["whoop_cycles", "whoop_last_night", "whoop_profile", "whoop_recoveries", "whoop_sleep_hr_metrics", "whoop_sleeps", "whoop_workouts"]);
});
