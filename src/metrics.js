// Pure helpers that turn official WHOOP v2 records into sleep-window metrics.
// Nothing here invents data: fields WHOOP's public API does not return are null + listed in `not_available`.

const MIN = 60_000;
const mins = (ms) => (typeof ms === "number" ? Math.round(ms / MIN) : null);
const r1 = (x) => (typeof x === "number" ? Math.round(x * 10) / 10 : null);

// Local calendar date (YYYY-MM-DD) of an ISO instant, using WHOOP's own "-05:00" style offset.
export function localDate(iso, offset) {
  if (!iso) return null;
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset || "+00:00");
  const sign = m && m[1] === "-" ? -1 : 1;
  const offMin = m ? sign * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(Date.parse(iso) + offMin * MIN).toISOString().slice(0, 10);
}

export function localTime(iso, offset) {
  if (!iso) return null;
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset || "+00:00");
  const sign = m && m[1] === "-" ? -1 : 1;
  const offMin = m ? sign * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(Date.parse(iso) + offMin * MIN).toISOString().slice(11, 16) + (offset ? ` (${offset})` : "");
}

export function summarizeSleep(s) {
  if (!s) return null;
  const st = s.score?.stage_summary || {};
  const asleep = ["total_light_sleep_time_milli", "total_slow_wave_sleep_time_milli", "total_rem_sleep_time_milli"]
    .map((k) => st[k]).filter((v) => typeof v === "number");
  const sws = st.total_slow_wave_sleep_time_milli, rem = st.total_rem_sleep_time_milli;
  return {
    sleep_id: s.id,
    cycle_id: s.cycle_id,
    nap: !!s.nap,
    score_state: s.score_state,
    start: s.start,
    end: s.end,
    timezone_offset: s.timezone_offset,
    wake_date: localDate(s.end, s.timezone_offset),
    lights_out_local: localTime(s.start, s.timezone_offset),
    wake_local: localTime(s.end, s.timezone_offset),
    in_bed_min: mins(st.total_in_bed_time_milli),
    asleep_min: asleep.length === 3 ? mins(asleep.reduce((a, b) => a + b, 0)) : null,
    awake_min: mins(st.total_awake_time_milli),
    light_min: mins(st.total_light_sleep_time_milli),
    sws_min: mins(sws),
    rem_min: mins(rem),
    restorative_min: typeof sws === "number" && typeof rem === "number" ? mins(sws + rem) : null,
    sleep_cycles: st.sleep_cycle_count ?? null,
    disturbances: st.disturbance_count ?? null,
    respiratory_rate_bpm: r1(s.score?.respiratory_rate),
    efficiency_pct: r1(s.score?.sleep_efficiency_percentage),
    consistency_pct: r1(s.score?.sleep_consistency_percentage),
    performance_pct: r1(s.score?.sleep_performance_percentage),
    sleep_need_baseline_min: mins(s.score?.sleep_needed?.baseline_milli),
  };
}

export function summarizeRecovery(r) {
  if (!r) return null;
  return {
    cycle_id: r.cycle_id,
    sleep_id: r.sleep_id,
    score_state: r.score_state,
    user_calibrating: r.score?.user_calibrating ?? null,
    recovery_pct: r.score?.recovery_score ?? null,
    resting_hr_bpm: r.score?.resting_heart_rate ?? null,
    hrv_rmssd_ms: r1(r.score?.hrv_rmssd_milli),
    spo2_pct: r1(r.score?.spo2_percentage),
    skin_temp_c: r1(r.score?.skin_temp_celsius),
  };
}

export const NOT_IN_PUBLIC_API = [
  "sleep_onset_hr_bpm",
  "lowest_hr_bpm",
  "lowest_hr_time",
  "avg_sleeping_hr_bpm",
  "pre_sleep_hr_bpm",
  "hr_time_series",
  "hypnogram",
];

const mean = (xs) => {
  const v = xs.filter((x) => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

// One record per main (non-nap) sleep, joined to its recovery by sleep_id.
// `history` = earlier nights (most recent first) used for a rolling baseline.
export function sleepHrMetrics(sleep, recovery, history = []) {
  const s = summarizeSleep(sleep);
  const r = summarizeRecovery(recovery);
  const base = {
    nights: history.length,
    resting_hr_bpm: r1(mean(history.map((h) => h.resting_hr_bpm))),
    hrv_rmssd_ms: r1(mean(history.map((h) => h.hrv_rmssd_ms))),
    respiratory_rate_bpm: r1(mean(history.map((h) => h.respiratory_rate_bpm))),
    restorative_min: r1(mean(history.map((h) => h.restorative_min))),
  };
  const delta = (k) => (typeof row[k] === "number" && typeof base[k] === "number" ? r1(row[k] - base[k]) : null);
  const row = {
    wake_date: s?.wake_date ?? null,
    lights_out_local: s?.lights_out_local ?? null,
    wake_local: s?.wake_local ?? null,
    asleep_min: s?.asleep_min ?? null,
    restorative_min: s?.restorative_min ?? null,
    sws_min: s?.sws_min ?? null,
    rem_min: s?.rem_min ?? null,
    disturbances: s?.disturbances ?? null,
    resting_hr_bpm: r?.resting_hr_bpm ?? null, // WHOOP measures RHR during sleep
    hrv_rmssd_ms: r?.hrv_rmssd_ms ?? null, // WHOOP's sleep-derived HRV
    respiratory_rate_bpm: s?.respiratory_rate_bpm ?? null,
    spo2_pct: r?.spo2_pct ?? null,
    skin_temp_c: r?.skin_temp_c ?? null,
    recovery_pct: r?.recovery_pct ?? null,
    score_state: { sleep: s?.score_state ?? null, recovery: r?.score_state ?? null },
  };
  return {
    ...row,
    baseline: base,
    vs_baseline: {
      resting_hr_bpm: delta("resting_hr_bpm"),
      hrv_rmssd_ms: delta("hrv_rmssd_ms"),
      respiratory_rate_bpm: delta("respiratory_rate_bpm"),
      restorative_min: delta("restorative_min"),
    },
    not_available: NOT_IN_PUBLIC_API,
    note:
      "WHOOP's public API v2 gives per-night RHR, HRV (RMSSD), respiratory rate, SpO2 and skin temperature, but no heart-rate time series, so sleep-onset HR, lowest HR and its time, and pre-sleep HR cannot be computed from it.",
  };
}

// Join sleeps (non-nap) to recoveries and compute metrics for the latest night + baseline.
export function nightlyRows(sleeps, recoveries) {
  const recBySleep = new Map(recoveries.map((r) => [r.sleep_id, r]));
  const mains = sleeps.filter((s) => !s.nap && s.score_state === "SCORED").sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
  return mains.map((s) => ({ sleep: s, recovery: recBySleep.get(s.id) || null }));
}
