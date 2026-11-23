import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WhoopClient } from "./whoop.js";
import { summarizeSleep, summarizeRecovery, sleepHrMetrics, nightlyRows } from "./metrics.js";

const iso = z.string().describe("ISO-8601 date-time, e.g. 2026-01-05T00:00:00Z");
const range = {
  start: iso.optional().describe("Inclusive lower bound. Default: 7 days ago."),
  end: iso.optional().describe("Exclusive upper bound. Default: now."),
  limit: z.number().int().min(1).max(100).optional().describe("Max records (default 10, max 100; paged 25 at a time)."),
};
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const wrap = (fn) => async (args) => {
  try { return json(await fn(args || {})); }
  catch (e) { return { isError: true, content: [{ type: "text", text: String(e?.message || e) }] }; }
};
const opts = (a, defDays = 7) => ({ start: a.start || daysAgo(defDays), end: a.end, maxRecords: a.limit || 10 });

export function buildServer(client = new WhoopClient()) {
  const server = new McpServer({ name: "whoop-sleep-mcp", version: "0.1.0" });

  server.tool("whoop_profile", "Basic WHOOP profile (name, email) plus body measurements (height, weight, WHOOP max HR).", {},
    wrap(async () => ({ profile: await client.profile(), body: await client.body() })));

  server.tool("whoop_sleeps", "Sleep records (naps included, flagged). Stage minutes, restorative (SWS+REM) minutes, respiratory rate, efficiency, consistency, sleep need. Times are UTC plus WHOOP's timezone_offset.", range,
    wrap(async (a) => (await client.sleeps(opts(a))).map(summarizeSleep)));

  server.tool("whoop_recoveries", "Recovery records: recovery %, resting HR, HRV (RMSSD, ms), SpO2 %, skin temp (C). One per sleep.", range,
    wrap(async (a) => (await client.recoveries(opts(a))).map(summarizeRecovery)));

  server.tool("whoop_cycles", "Physiological cycles (roughly wake-to-wake days): day strain, kJ, average and max HR for the whole cycle, step count when returned.", range,
    wrap(async (a) => client.cycles(opts(a))));

  server.tool("whoop_workouts", "Workouts: sport, start/end, strain, average/max HR, kJ, distance, HR-zone durations.", range,
    wrap(async (a) => client.workouts(opts(a))));

  server.tool("whoop_last_night",
    "Last night in one call: the latest scored main sleep (not a nap), its recovery, and today's cycle strain so far.", {},
    wrap(async () => {
      const [sleeps, recs, cycles] = await Promise.all([
        client.sleeps({ start: daysAgo(3), maxRecords: 10 }),
        client.recoveries({ start: daysAgo(3), maxRecords: 10 }),
        client.cycles({ start: daysAgo(2), maxRecords: 2 }),
      ]);
      const [latest] = nightlyRows(sleeps, recs);
      return {
        sleep: summarizeSleep(latest?.sleep) ?? null,
        recovery: summarizeRecovery(latest?.recovery) ?? null,
        current_cycle: cycles[0] ?? null,
        message: latest ? undefined : "No scored main sleep in the last 3 days (WHOOP may still be scoring).",
      };
    }));

  server.tool("whoop_sleep_hr_metrics",
    "Heart metrics around the sleep window for one night (default: most recent): resting HR, HRV RMSSD, respiratory rate, SpO2, skin temp, restorative minutes, each vs a rolling baseline of prior nights. States plainly which HR metrics the public API does not expose (sleep-onset HR, lowest HR and time, HR time series).",
    {
      wake_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Local wake date YYYY-MM-DD. Default: latest scored night."),
      baseline_nights: z.number().int().min(0).max(30).optional().describe("Prior nights to average for the baseline (default 7)."),
    },
    wrap(async (a) => {
      const n = a.baseline_nights ?? 7;
      const anchor = a.wake_date ? Date.parse(a.wake_date + "T23:59:59Z") + 86_400_000 : Date.now();
      const start = new Date(anchor - (n + 4) * 86_400_000).toISOString();
      const end = new Date(anchor).toISOString();
      const [sleeps, recs] = await Promise.all([
        client.sleeps({ start, end, maxRecords: 2 * n + 10 }),
        client.recoveries({ start, end, maxRecords: 2 * n + 10 }),
      ]);
      const rows = nightlyRows(sleeps, recs);
      const idx = a.wake_date ? rows.findIndex((x) => summarizeSleep(x.sleep).wake_date === a.wake_date) : 0;
      if (idx < 0 || !rows[idx]) return { message: `No scored main sleep found for wake date ${a.wake_date ?? "(latest)"}.` };
      const history = rows.slice(idx + 1, idx + 1 + n).map((x) => ({
        ...summarizeSleep(x.sleep),
        ...summarizeRecovery(x.recovery),
      }));
      return sleepHrMetrics(rows[idx].sleep, rows[idx].recovery, history);
    }));

  return server;
}
