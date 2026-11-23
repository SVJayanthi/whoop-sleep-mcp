// Minimal client for the official WHOOP Developer API v2 (https://developer.whoop.com/api/).
// Read-only. Every user brings their own WHOOP developer app (client id/secret).
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const API_BASE = "https://api.prod.whoop.com/developer";
export const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
// "offline" is required to receive a refresh token.
export const SCOPES = [
  "offline",
  "read:profile",
  "read:body_measurement",
  "read:cycles",
  "read:recovery",
  "read:sleep",
  "read:workout",
];

export function config(env = process.env) {
  return {
    clientId: env.WHOOP_CLIENT_ID || "",
    clientSecret: env.WHOOP_CLIENT_SECRET || "",
    redirectUri: env.WHOOP_REDIRECT_URI || "http://localhost:8787/callback",
    tokenFile: env.WHOOP_TOKEN_FILE || join(homedir(), ".whoop-mcp", "tokens.json"),
    timezone: env.WHOOP_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// ---- token storage (refresh tokens rotate on every refresh, so persist them) ----
export class TokenStore {
  constructor(file, env = process.env) {
    this.file = file;
    this.env = env;
  }
  load() {
    if (existsSync(this.file)) {
      try { return JSON.parse(readFileSync(this.file, "utf8")); } catch { /* fall through */ }
    }
    // Bootstrap from env (e.g. a hosted deploy). The rotated token is then written to the file.
    if (this.env.WHOOP_REFRESH_TOKEN) return { refresh_token: this.env.WHOOP_REFRESH_TOKEN };
    return null;
  }
  save(tok) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(tok, null, 2));
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }
}

export async function exchangeToken(cfg, params, fetchImpl = fetch) {
  const body = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WHOOP token endpoint ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    scope: j.scope,
  };
}

export class WhoopClient {
  constructor({ cfg = config(), store, fetchImpl = fetch } = {}) {
    this.cfg = cfg;
    this.store = store || new TokenStore(cfg.tokenFile);
    this.fetch = fetchImpl;
    this.refreshing = null; // single-flight: concurrent refreshes would invalidate each other
  }

  async token() {
    let tok = this.store.load();
    if (!tok) throw new Error("Not authorized with WHOOP yet. Run `whoop-sleep-mcp auth` (see README).");
    if (tok.access_token && tok.expires_at && tok.expires_at - Date.now() > 60_000) return tok.access_token;
    if (!tok.refresh_token) throw new Error("No WHOOP refresh token stored. Re-run `whoop-sleep-mcp auth`.");
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const fresh = await exchangeToken(
            this.cfg,
            { grant_type: "refresh_token", refresh_token: tok.refresh_token, scope: "offline" },
            this.fetch,
          );
          if (!fresh.refresh_token) fresh.refresh_token = tok.refresh_token;
          this.store.save(fresh);
          return fresh.access_token;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  async get(path, query = {}) {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` } });
      if (res.status === 401 && attempt === 0) {
        const tok = this.store.load();
        if (tok) this.store.save({ ...tok, expires_at: 0 }); // force a refresh, then retry once
        continue;
      }
      if (res.status === 404) return null;
      const text = await res.text();
      if (res.status === 429) throw new Error("WHOOP rate limit hit (429). Wait a minute and retry.");
      if (!res.ok) throw new Error(`WHOOP API ${res.status} on ${path}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    }
    throw new Error("WHOOP rejected the token twice. Re-run `whoop-sleep-mcp auth`.");
  }

  // Collections are paginated (limit <= 25, `nextToken`). Fetch up to maxRecords.
  async collection(path, { start, end, limit = 25, maxRecords = 25 } = {}) {
    const out = [];
    let nextToken;
    do {
      const page = await this.get(path, { start, end, limit: Math.min(25, limit), nextToken });
      if (!page) break;
      out.push(...(page.records || []));
      nextToken = page.next_token;
    } while (nextToken && out.length < maxRecords);
    return out.slice(0, maxRecords);
  }

  profile() { return this.get("/v2/user/profile/basic"); }
  body() { return this.get("/v2/user/measurement/body"); }
  cycles(o) { return this.collection("/v2/cycle", o); }
  recoveries(o) { return this.collection("/v2/recovery", o); }
  sleeps(o) { return this.collection("/v2/activity/sleep", o); }
  workouts(o) { return this.collection("/v2/activity/workout", o); }
  sleepById(id) { return this.get(`/v2/activity/sleep/${encodeURIComponent(id)}`); }
  recoveryForCycle(cycleId) { return this.get(`/v2/cycle/${encodeURIComponent(cycleId)}/recovery`); }
}
