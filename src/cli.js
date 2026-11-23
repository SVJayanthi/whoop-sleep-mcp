#!/usr/bin/env node
// whoop-sleep-mcp  auth [--manual] | serve [--http] | status
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { config, TokenStore, exchangeToken, AUTH_URL, SCOPES } from "./whoop.js";

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
  const { buildServer } = await import("./server.js");
  if (!flags.has("--http") && process.env.MCP_TRANSPORT !== "http") {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    await buildServer().connect(new StdioServerTransport());
    return;
  }
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const express = (await import("express")).default;
  const secret = process.env.MCP_AUTH_TOKEN;
  if (!secret || secret.length < 32) { console.error("HTTP mode needs MCP_AUTH_TOKEN (>= 32 chars, e.g. `openssl rand -hex 32`)."); process.exit(1); }
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.get("/health", (_q, r) => r.json({ ok: true }));
  app.use("/mcp", (req, res, next) => {
    const got = Buffer.from((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(secret);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).json({ error: "unauthorized" });
    next();
  });
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
    const server = buildServer();
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all("/mcp", (_q, r) => r.status(405).json({ error: "POST only (stateless Streamable HTTP)" }));
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.error(`whoop-sleep-mcp HTTP on :${port}/mcp`));
}

function status() {
  const t = new TokenStore(cfg.tokenFile).load();
  console.log(JSON.stringify({
    client_id_set: !!cfg.clientId, client_secret_set: !!cfg.clientSecret, redirect_uri: cfg.redirectUri,
    token_file: cfg.tokenFile, has_refresh_token: !!t?.refresh_token,
    access_token_valid_for_s: t?.expires_at ? Math.max(0, Math.round((t.expires_at - Date.now()) / 1000)) : 0,
  }, null, 2));
}

({ auth, serve, status }[cmd] || (() => { console.error("usage: whoop-sleep-mcp auth [--manual] | serve [--http] | status"); process.exit(1); }))()
  .catch?.((e) => { console.error(e.message || e); process.exit(1); });
