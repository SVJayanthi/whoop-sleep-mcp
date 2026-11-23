import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedApp, createSharedTokenApp } from "../src/http.js";
import { HostedStore } from "../src/store.js";
import { WhoopClient } from "../src/whoop.js";

const ENC = "b".repeat(64);

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function mockWhoop({ users, byCode }) {
  const refresh = {};
  for (const rec of Object.values(byCode)) refresh[rec.refresh] = rec;
  return async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/oauth2/token")) {
      const body = new URLSearchParams(String(init.body || ""));
      if (body.get("grant_type") === "authorization_code") {
        const rec = byCode[body.get("code")];
        if (!rec) return new Response("bad code", { status: 400 });
        return json({ access_token: rec.access, refresh_token: rec.refresh, expires_in: 3600, scope: "offline" });
      }
      if (body.get("grant_type") === "refresh_token") {
        const rec = refresh[body.get("refresh_token")];
        if (!rec) return new Response("bad refresh", { status: 400 });
        const nextRefresh = rec.refresh + "-n";
        const nextAccess = rec.access + "-n";
        refresh[nextRefresh] = { ...rec, access: nextAccess, refresh: nextRefresh };
        delete refresh[rec.refresh];
        rec.access = nextAccess;
        rec.refresh = nextRefresh;
        users[nextAccess] = users[rec.access] || rec.user;
        return json({ access_token: nextAccess, refresh_token: nextRefresh, expires_in: 3600 });
      }
      return new Response("bad grant", { status: 400 });
    }
    const token = String(init.headers?.Authorization || "").replace(/^Bearer\s+/i, "");
    const user = users[token];
    if (!user) return new Response("nope", { status: 401 });
    if (u.includes("/v2/user/profile/basic")) return json(user.profile);
    if (u.includes("/v2/user/measurement/body")) return json(user.body || {});
    if (u.includes("/v2/activity/sleep")) return json({ records: user.sleeps || [] });
    if (u.includes("/v2/recovery")) return json({ records: user.recoveries || [] });
    if (u.includes("/v2/cycle")) return json({ records: user.cycles || [] });
    if (u.includes("/v2/activity/workout")) return json({ records: user.workouts || [] });
    return new Response("missing", { status: 404 });
  };
}

function sampleUser(id, access, label) {
  const end = "2026-01-05T15:00:00.000Z";
  return {
    access,
    refresh: `r-${id}`,
    profile: { user_id: id, email: `${label}@example.com`, first_name: label, last_name: "Test" },
    body: { height_meter: 1.8, weight_kilogram: 70, max_heart_rate: 190 },
    sleeps: [{
      id: `s-${id}`, cycle_id: id, start: "2026-01-05T07:00:00.000Z", end,
      timezone_offset: "-08:00", nap: false, score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: 8 * 3600e3, total_awake_time_milli: 1800e3,
          total_light_sleep_time_milli: 4 * 3600e3, total_slow_wave_sleep_time_milli: 90 * 60e3,
          total_rem_sleep_time_milli: 100 * 60e3, sleep_cycle_count: 4, disturbance_count: 9,
        },
        respiratory_rate: 15, sleep_efficiency_percentage: 92,
      },
    }],
    recoveries: [{
      cycle_id: id, sleep_id: `s-${id}`, score_state: "SCORED",
      score: { recovery_score: id === 1 ? 40 : 90, resting_heart_rate: id === 1 ? 50 : 70, hrv_rmssd_milli: 60 },
    }],
    cycles: [{ id, start: "2026-01-05T07:00:00.000Z", score: { strain: 8 } }],
    workouts: [],
  };
}

function parseMcp(text) {
  const trimmed = String(text).trim();
  if (trimmed.startsWith("event:") || trimmed.includes("\ndata:")) {
    const datas = [...trimmed.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]));
    return datas.find((d) => d.result || d.error) || datas.at(-1);
  }
  return JSON.parse(trimmed);
}

async function mcp(origin, token, method, params = {}, id = 1) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  let body;
  try { body = parseMcp(text); } catch { body = text; }
  return { res, body, text };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

async function registerAndLogin(origin, whoopCode, redirectUri = "http://127.0.0.1:9/cb") {
  const { verifier, challenge } = pkce();
  const reg = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "test-mcp",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "whoop",
    }),
  });
  const regText = await reg.text();
  assert.equal(reg.status, 201, regText);
  const client = JSON.parse(regText);
  const authorize = new URL("/authorize", origin);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "whoop",
    state: "mcpstate",
    resource: `${origin}/mcp`,
  }).toString();
  const ares = await fetch(authorize, { redirect: "manual" });
  assert.equal(ares.status, 302);
  const whoopUrl = new URL(ares.headers.get("location"));
  assert.match(whoopUrl.hostname, /whoop\.com/);
  assert.equal(whoopUrl.searchParams.get("state").length, 8);
  const cb = new URL("/callback", origin);
  cb.search = new URLSearchParams({ code: whoopCode, state: whoopUrl.searchParams.get("state") }).toString();
  const cres = await fetch(cb, { redirect: "manual" });
  const cbText = await cres.text();
  assert.equal(cres.status, 302, cbText);
  const back = new URL(cres.headers.get("location"));
  assert.equal(back.searchParams.get("state"), "mcpstate");
  const tokenRes = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code"),
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      resource: `${origin}/mcp`,
    }),
  });
  const tokenText = await tokenRes.text();
  assert.equal(tokenRes.status, 200, tokenText);
  const tokens = JSON.parse(tokenText);
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  return { client, tokens };
}

test("hosted OAuth metadata, DCR, WHOOP delegate, token, isolation, tools/list", async (t) => {
  const alice = sampleUser(1, "access-alice", "Alice");
  const bob = sampleUser(2, "access-bob", "Bob");
  const store = new HostedStore({ dir: mkdtempSync(join(tmpdir(), "whoop-oauth-")), encryptionKey: ENC });
  const fetchImpl = mockWhoop({
    users: { "access-alice": alice, "access-bob": bob },
    byCode: {
      codeA: { access: "access-alice", refresh: "r-1", user_id: 1 },
      codeB: { access: "access-bob", refresh: "r-2", user_id: 2 },
    },
  });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const hosted = await createHostedApp({
    env: {
      NODE_ENV: "test",
      WHOOP_CLIENT_ID: "cid",
      WHOOP_CLIENT_SECRET: "csecret",
      TOKEN_ENCRYPTION_KEY: ENC,
      MCP_RATE_LIMIT: "off",
      PUBLIC_URL: origin,
    },
    store,
    fetchImpl,
    publicUrl: origin,
    rateLimit: false,
  });
  const server = await new Promise((resolve, reject) => {
    const s = hosted.app.listen(port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  t.after(() => new Promise((r) => server.close(r)));

  const unauth = await mcp(origin, null, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(unauth.res.status, 401);
  assert.match(unauth.res.headers.get("www-authenticate") || "", /resource_metadata=/);

  const prm = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.ok(prm.authorization_servers?.length);
  assert.equal(prm.resource, `${origin}/mcp`);
  assert.equal((await fetch(`${origin}/.well-known/oauth-protected-resource`)).status, 200);

  const asJson = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
  assert.ok(asJson.authorization_endpoint.endsWith("/authorize"));
  assert.ok(asJson.registration_endpoint.endsWith("/register"));
  assert.deepEqual(asJson.code_challenge_methods_supported, ["S256"]);

  const health = await (await fetch(`${origin}/health`)).json();
  assert.equal(health.mode, "hosted");
  assert.equal(health.redirect_uri, `${origin}/callback`);

  const a = await registerAndLogin(origin, "codeA");
  const b = await registerAndLogin(origin, "codeB", "http://127.0.0.1:9/cb2");
  assert.notEqual(a.tokens.access_token, b.tokens.access_token);
  assert.equal(store.getWhoopTokens("1").refresh_token, "r-1");
  assert.equal(store.getWhoopTokens("2").refresh_token, "r-2");

  const initA = await mcp(origin, a.tokens.access_token, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(initA.res.status, 200, initA.text);
  const toolsA = await mcp(origin, a.tokens.access_token, "tools/list", {}, 2);
  assert.equal(toolsA.res.status, 200, toolsA.text);
  const names = (toolsA.body.result?.tools || []).map((x) => x.name).sort();
  assert.deepEqual(names, [
    "whoop_cycles", "whoop_last_night", "whoop_profile", "whoop_recoveries",
    "whoop_sleep_hr_metrics", "whoop_sleeps", "whoop_workouts",
  ]);

  const payload = (body) => JSON.parse(body.result.content[0].text);
  const sleepA = payload((await mcp(origin, a.tokens.access_token, "tools/call", { name: "whoop_sleeps", arguments: { limit: 5 } }, 3)).body);
  const sleepB = payload((await mcp(origin, b.tokens.access_token, "tools/call", { name: "whoop_sleeps", arguments: { limit: 5 } }, 4)).body);
  const recA = payload((await mcp(origin, a.tokens.access_token, "tools/call", { name: "whoop_recoveries", arguments: { limit: 5 } }, 5)).body);
  const recB = payload((await mcp(origin, b.tokens.access_token, "tools/call", { name: "whoop_recoveries", arguments: { limit: 5 } }, 6)).body);
  assert.equal(sleepA[0].sleep_id, "s-1");
  assert.equal(sleepB[0].sleep_id, "s-2");
  assert.equal(recA[0].resting_hr_bpm, 50);
  assert.equal(recB[0].resting_hr_bpm, 70);
  const profA = payload((await mcp(origin, a.tokens.access_token, "tools/call", { name: "whoop_profile", arguments: {} }, 7)).body);
  const profB = payload((await mcp(origin, b.tokens.access_token, "tools/call", { name: "whoop_profile", arguments: {} }, 8)).body);
  assert.equal(profA.profile.first_name, "Alice");
  assert.equal(profB.profile.first_name, "Bob");

  const rotated = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: a.tokens.refresh_token,
      client_id: a.client.client_id,
    }),
  });
  const rotatedText = await rotated.text();
  assert.equal(rotated.status, 200, rotatedText);
  const next = JSON.parse(rotatedText);
  assert.notEqual(next.access_token, a.tokens.access_token);
  assert.equal((await mcp(origin, a.tokens.access_token, "tools/list")).res.status, 401);
  assert.equal((await mcp(origin, next.access_token, "tools/list", {}, 9)).res.status, 200);
});

test("shared-token HTTP still lists tools (single-user fallback)", async (t) => {
  const secret = "x".repeat(32);
  const user = sampleUser(7, "tok", "Solo");
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/oauth2/token")) return json({ access_token: "tok", refresh_token: "r", expires_in: 3600 });
    if (u.includes("/profile")) return json(user.profile);
    if (u.includes("/body")) return json(user.body);
    return json({ records: [] });
  };
  const app = await createSharedTokenApp({
    secret,
    clientFactory: () => new WhoopClient({
      cfg: { clientId: "x", clientSecret: "y" },
      store: { load: () => ({ access_token: "tok", refresh_token: "r", expires_at: Date.now() + 3600_000 }), save() {} },
      fetchImpl,
    }),
  });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  const ok = await mcp(origin, secret, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" },
  });
  assert.equal(ok.res.status, 200, ok.text);
  const tools = await mcp(origin, secret, "tools/list", {}, 2);
  assert.ok((tools.body.result?.tools || []).length >= 7);
});
