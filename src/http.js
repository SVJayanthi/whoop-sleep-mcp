// Streamable HTTP MCP: shared-bearer (single user) and hosted OAuth (multi-user).
import { timingSafeEqual } from "node:crypto";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { config, WhoopClient } from "./whoop.js";
import { HostedStore } from "./store.js";
import { WhoopDelegatingOAuthProvider } from "./oauth.js";

export function publicBaseUrl(env = process.env, port = Number(env.PORT) || 3000) {
  const raw = env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${port}`;
  return String(raw).replace(/\/$/, "");
}

function cors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, mcp-protocol-version, mcp-session-id, last-event-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, WWW-Authenticate");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

async function handleMcp(req, res, client) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer(client);
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

function landingHtml(base) {
  const mcp = `${base}/mcp`;
  return `<!doctype html>
<meta charset="utf-8">
<title>WHOOP sleep MCP</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.45">
<h1>WHOOP sleep MCP</h1>
<p>This is a remote MCP server. Add it as a custom connector in Grok Bot, Cursor, or another MCP client, then sign in with your WHOOP account when asked. You do not need API keys.</p>
<p>Connector URL:</p>
<pre style="background:#f4f4f4;padding:0.8rem;overflow:auto">${mcp}</pre>
<p>Health: <a href="/health">/health</a>. Not affiliated with WHOOP.</p>
</body>`;
}

export async function createSharedTokenApp({ secret, clientFactory } = {}) {
  if (!secret || secret.length < 32) throw new Error("HTTP mode needs MCP_AUTH_TOKEN (>= 32 chars, e.g. `openssl rand -hex 32`).");
  const express = (await import("express")).default;
  const app = express();
  app.use(cors);
  app.use(express.json({ limit: "1mb" }));
  app.get("/health", (_q, r) => r.json({ ok: true, mode: "shared-token" }));
  app.use("/mcp", (req, res, next) => {
    const got = Buffer.from((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(secret);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).json({ error: "unauthorized" });
    next();
  });
  app.post("/mcp", async (req, res) => {
    const client = clientFactory ? clientFactory() : new WhoopClient();
    await handleMcp(req, res, client);
  });
  app.all("/mcp", (_q, r) => r.status(405).json({ error: "POST only (stateless Streamable HTTP)" }));
  return app;
}

export async function createHostedApp({
  env = process.env,
  store,
  fetchImpl = fetch,
  publicUrl,
  whoopCfg,
  clientForUser,
  rateLimit,
} = {}) {
  const express = (await import("express")).default;
  const port = Number(env.PORT) || 3000;
  const base = publicUrl || publicBaseUrl(env, port);
  const issuerUrl = new URL(base);
  const mcpResource = new URL("/mcp", issuerUrl);
  const cfg = whoopCfg || {
    ...config(env),
    redirectUri: env.WHOOP_REDIRECT_URI || `${base}/callback`,
  };
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("Hosted mode needs WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET.");
  }
  const hosted = store || new HostedStore({
    dir: env.DATA_DIR,
    file: env.HOSTED_STORE_FILE,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
  });
  const provider = new WhoopDelegatingOAuthProvider({
    store: hosted,
    whoopCfg: cfg,
    mcpResource,
    fetchImpl,
  });
  const disableLimits = rateLimit === false || env.NODE_ENV === "test" || env.MCP_RATE_LIMIT === "off";
  const rl = disableLimits ? { rateLimit: false } : {};

  const app = express();
  app.use(cors);
  app.use(mcpAuthRouter({
    provider,
    issuerUrl,
    baseUrl: issuerUrl,
    resourceServerUrl: mcpResource,
    resourceName: "whoop-sleep-mcp",
    scopesSupported: ["whoop"],
    serviceDocumentationUrl: new URL("https://github.com/SVJayanthi/whoop-sleep-mcp"),
    authorizationOptions: rl,
    tokenOptions: rl,
    revocationOptions: rl,
    clientRegistrationOptions: { ...rl, clientSecretExpirySeconds: 0 },
  }));
  // Some MCP clients only probe the origin well-known, not the /mcp suffix.
  app.get("/.well-known/oauth-protected-resource", (_q, r) => {
    r.json({
      resource: mcpResource.href,
      authorization_servers: [issuerUrl.href],
      scopes_supported: ["whoop"],
      resource_name: "whoop-sleep-mcp",
    });
  });

  app.get("/callback", async (req, res) => {
    try {
      if (req.query.error) {
        res.status(400).type("html").send(errorPage(req.query.error_description || req.query.error));
        return;
      }
      const code = String(req.query.code || "");
      const state = String(req.query.state || "");
      if (!code || !state) {
        res.status(400).type("html").send(errorPage("Missing code or state from WHOOP."));
        return;
      }
      const { redirectUri, code: ourCode, state: ourState } = await provider.completeWhoopCallback(code, state);
      const target = new URL(redirectUri);
      target.searchParams.set("code", ourCode);
      if (ourState) target.searchParams.set("state", ourState);
      res.redirect(target.toString());
    } catch (e) {
      res.status(400).type("html").send(errorPage(e.message || String(e)));
    }
  });

  app.get("/health", (_q, r) => r.json({
    ok: true,
    mode: "hosted",
    redirect_uri: cfg.redirectUri,
  }));
  app.get("/", (_q, r) => r.type("html").send(landingHtml(base)));

  const bearerAuth = requireBearerAuth({
    verifier: { verifyAccessToken: (t) => provider.verifyAccessToken(t) },
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpResource),
    expectedResource: mcpResource,
  });
  app.use("/mcp", bearerAuth);
  app.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
    const userId = req.auth?.extra?.whoopUserId;
    if (!userId) return res.status(401).json({ error: "unauthorized" });
    const client = clientForUser
      ? clientForUser(userId, req.auth)
      : new WhoopClient({ cfg, store: hosted.whoopStoreForUser(userId), fetchImpl });
    await handleMcp(req, res, client);
  });
  app.all("/mcp", (_q, r) => r.status(405).json({ error: "POST only (stateless Streamable HTTP)" }));

  return { app, provider, store: hosted, mcpResource, issuerUrl, whoopCfg: cfg };
}

function errorPage(msg) {
  return `<!doctype html><meta charset="utf-8"><title>WHOOP sign-in failed</title>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem">
<h1>Could not connect WHOOP</h1>
<p>${String(msg).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</p>
<p>Close this tab and try adding the connector again.</p>
</body>`;
}

export async function listenSharedToken({ env = process.env, clientFactory } = {}) {
  const app = await createSharedTokenApp({ secret: env.MCP_AUTH_TOKEN, clientFactory });
  const port = Number(env.PORT) || 3000;
  await new Promise((resolve, reject) => {
    const s = app.listen(port, "0.0.0.0", () => {
      console.error(`whoop-sleep-mcp HTTP on :${port}/mcp (shared bearer token)`);
      resolve(s);
    });
    s.on("error", reject);
  });
}

export async function listenHosted({ env = process.env, fetchImpl = fetch } = {}) {
  const { app, whoopCfg } = await createHostedApp({ env, fetchImpl });
  const port = Number(env.PORT) || 3000;
  await new Promise((resolve, reject) => {
    const s = app.listen(port, "0.0.0.0", () => {
      console.error(`whoop-sleep-mcp hosted MCP on :${port}/mcp`);
      console.error(`WHOOP redirect URI must be exactly: ${whoopCfg.redirectUri}`);
      resolve(s);
    });
    s.on("error", reject);
  });
}

export function isHostedMode(env = process.env, flags = new Set()) {
  if (flags.has("--hosted") || env.MCP_MODE === "hosted") return true;
  if (flags.has("--http") || env.MCP_TRANSPORT === "http") {
    return Boolean(env.TOKEN_ENCRYPTION_KEY) && !env.MCP_AUTH_TOKEN;
  }
  return false;
}
