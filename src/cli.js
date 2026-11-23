#!/usr/bin/env node
// whoop-sleep-mcp  auth [--manual] | serve [--http] [--hosted] | status
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { config, TokenStore, exchangeToken, AUTH_URL, SCOPES } from "./whoop.js";
import { isHostedMode } from "./http.js";

const cfg = config();
const cmd = process.argv[2] || "serve";
const flags = new Set(process.argv.slice(3));

function need() {
  if (!cfg.clientId || !cfg.clientSecret) {
    console.error("Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET (from your app at developer-dashboard.whoop.com).");
    process.exit(1);
  }
}

async function auth() {
  need();
  const state = randomBytes(8).toString("hex").slice(0, 8); // WHOOP wants an 8-char state
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: SCOPES.join(" "), state,
  }).toString();
  console.log("\nOpen this URL, sign in to WHOOP and approve:\n\n" + url + "\n");

  let code;
  if (flags.has("--manual")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const pasted = await rl.question("After approving, paste the FULL URL your browser was sent to: ");
    rl.close();
    const u = new URL(pasted.trim());
    if (u.searchParams.get("state") !== state) throw new Error("State mismatch; start again.");
    code = u.searchParams.get("code");
  } else {
    const ru = new URL(cfg.redirectUri);
    code = await new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        const u = new URL(req.url, cfg.redirectUri);
        if (u.pathname !== ru.pathname) { res.writeHead(404).end(); return; }
        const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain" })
          .end(ok ? "WHOOP connected. You can close this tab." : "Authorization failed or state mismatch.");
        srv.close();
        ok ? resolve(u.searchParams.get("code")) : reject(new Error(u.searchParams.get("error_description") || "authorization failed"));
      }).listen(Number(ru.port) || 80, ru.hostname);
      console.log(`Waiting for the redirect on ${cfg.redirectUri} ...`);
    });
  }
  if (!code) throw new Error("No authorization code in the redirect.");
  const tok = await exchangeToken(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri });
  if (!tok.refresh_token) console.warn("Warning: no refresh token returned. Is the `offline` scope enabled for your app?");
  new TokenStore(cfg.tokenFile).save(tok);
  console.log(`Saved tokens to ${cfg.tokenFile} (mode 600). Scopes: ${tok.scope || "(not reported)"}`);
}

async function serve() {
  if (isHostedMode(process.env, flags)) {
    need();
    if (!process.env.TOKEN_ENCRYPTION_KEY) {
      console.error("Hosted mode needs TOKEN_ENCRYPTION_KEY (e.g. `openssl rand -hex 32`).");
      process.exit(1);
    }
    const { listenHosted } = await import("./http.js");
    await listenHosted({ env: process.env });
    return;
  }
  const { buildServer } = await import("./server.js");
  if (!flags.has("--http") && process.env.MCP_TRANSPORT !== "http") {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    await buildServer().connect(new StdioServerTransport());
    return;
  }
  const secret = process.env.MCP_AUTH_TOKEN;
  if (!secret || secret.length < 32) {
    console.error("HTTP mode needs MCP_AUTH_TOKEN (>= 32 chars, e.g. `openssl rand -hex 32`). For multi-user OAuth, set MCP_MODE=hosted and TOKEN_ENCRYPTION_KEY instead.");
    process.exit(1);
  }
  const { listenSharedToken } = await import("./http.js");
  await listenSharedToken({ env: process.env });
}

function status() {
  if (isHostedMode(process.env, flags)) {
    console.log(JSON.stringify({
      mode: "hosted",
      client_id_set: !!cfg.clientId,
      client_secret_set: !!cfg.clientSecret,
      encryption_key_set: !!process.env.TOKEN_ENCRYPTION_KEY,
      data_dir: process.env.DATA_DIR || process.env.HOSTED_STORE_FILE || "(default ~/.whoop-mcp)",
    }, null, 2));
    return;
  }
  const t = new TokenStore(cfg.tokenFile).load();
  console.log(JSON.stringify({
    mode: "local",
    client_id_set: !!cfg.clientId, client_secret_set: !!cfg.clientSecret, redirect_uri: cfg.redirectUri,
    token_file: cfg.tokenFile, has_refresh_token: !!t?.refresh_token,
    access_token_valid_for_s: t?.expires_at ? Math.max(0, Math.round((t.expires_at - Date.now()) / 1000)) : 0,
  }, null, 2));
}

({ auth, serve, status }[cmd] || (() => { console.error("usage: whoop-sleep-mcp auth [--manual] | serve [--http] [--hosted] | status"); process.exit(1); }))()
  .catch?.((e) => { console.error(e.message || e); process.exit(1); });
