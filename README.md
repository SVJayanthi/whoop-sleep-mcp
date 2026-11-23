# whoop-sleep-mcp

This is a small read-only MCP server for the **official WHOOP Developer API v2**. It lets a chat client (Grok Bot, Cursor, Claude Desktop, and others) read your sleep, recovery, strain, workouts and profile — plus a `whoop_sleep_hr_metrics` tool that compares last night with a rolling baseline.

**Two ways to run it:**

- **Hosted (the easy path for most people):** the owner registers **one** WHOOP developer app and deploys this server once. Everyone else adds the server URL as a remote MCP connector and signs in with their own WHOOP account in the browser. No API keys, no terminal, no per-user developer app.
- **Local (single user):** you create a WHOOP developer app yourself, run `whoop-sleep-mcp auth`, and talk to the server over stdio on your machine.

> Not affiliated with WHOOP. You need an active WHOOP membership.

## For people using a hosted server

You do not need a WHOOP developer account.

1. Get the server URL from whoever deployed it. It looks like `https://something.onrender.com/mcp`.
2. In your MCP client, add a **remote / custom connector** (in Grok Bot: ask it to add a custom connector; in Cursor: a custom MCP connector). Paste that URL. You do not paste any keys.
3. When the client opens a browser window, sign in to WHOOP and approve access.
4. Ask something like: *Use whoop_last_night and tell me my restorative minutes.*

The server stores your WHOOP tokens on the host, encrypted, isolated from other users. You can disconnect later from WHOOP's own account settings.

If your client cannot do OAuth for remote MCP, ask the host about the single-user HTTP fallback (a shared bearer token). That mode cannot separate users and is only for a private deploy of one person.

## For the person hosting this

Pick **Render**. It has a Deploy button, a persistent disk for tokens, and a Node runtime. Fly.io, Railway or a VPS with a volume also work (see `Dockerfile`); Render is the path documented below because it is one-click for a non-ops owner.

You will need: a [Render](https://render.com) account, a WHOOP account, and a paid Render web service (**Starter or above**) so the disk survives restarts. Free Render instances have an ephemeral filesystem, which would drop everyone's WHOOP refresh tokens on each deploy.

### 1. Create a WHOOP developer app

1. Open <https://developer-dashboard.whoop.com> and sign in with your WHOOP account. Create a Team if it asks.
2. **Apps → Create** (<https://developer-dashboard.whoop.com/apps/create>).
3. **Scopes:** tick `read:sleep`, `read:recovery`, `read:cycles`, `read:workout`, `read:profile` and `read:body_measurement`. During sign-in the server also requests `offline`, which WHOOP needs to issue a refresh token.
4. **Redirect URI:** you will set this to `https://<your-host>/callback` after the first deploy (step 3). For now you can save the app and edit the URI once you have the Render URL.
5. Copy the **Client ID** and **Client Secret**. Treat the secret like a password. These stay on the host as environment variables; users never see them.

Unreviewed WHOOP apps may be limited in how many members can connect. Check the current limit and how to request a higher tier in WHOOP's own docs: [App Approval](https://developer.whoop.com/docs/developing/app-approval/).

### 2. Deploy on Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/SVJayanthi/whoop-sleep-mcp)

1. Click **Deploy to Render**. Sign in to Render if needed.
2. When it asks for environment variables, paste:
   - `WHOOP_CLIENT_ID` — from the WHOOP dashboard
   - `WHOOP_CLIENT_SECRET` — from the WHOOP dashboard
3. Leave `TOKEN_ENCRYPTION_KEY` to be generated. `MCP_MODE=hosted` and a 1 GB disk at `/var/data` come from `render.yaml`.
4. Create the service. When it is live, copy the public URL, e.g. `https://whoop-sleep-mcp.onrender.com`.

### 3. Point WHOOP at this host

Back in the WHOOP developer dashboard, edit the app's **Redirect URI** so it is **exactly**:

```text
https://<your-service>.onrender.com/callback
```

No trailing slash. It must match what the server prints at boot (`WHOOP redirect URI must be exactly: …`) and what `GET /health` reports as `redirect_uri`.

### 4. Hand the URL to users

Give people:

```text
https://<your-service>.onrender.com/mcp
```

They add that as a remote MCP connector and sign in with WHOOP. Open `https://<your-service>.onrender.com/` in a browser for a short reminder page.

### Environment the host sets

| Var | Who sets it | Purpose |
|---|---|---|
| `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` | You | The one WHOOP developer app |
| `TOKEN_ENCRYPTION_KEY` | Render generates, or `openssl rand -hex 32` | Encrypts each user's WHOOP tokens at rest |
| `MCP_MODE` | `hosted` in `render.yaml` | Multi-user OAuth over Streamable HTTP |
| `DATA_DIR` | `/var/data` on Render | Persistent disk for the encrypted store |
| `PUBLIC_URL` | optional | Canonical public origin. On Render, `RENDER_EXTERNAL_URL` is used if this is unset |
| `WHOOP_REDIRECT_URI` | optional | Override if the callback is not `$PUBLIC_URL/callback` |

Do not set `MCP_AUTH_TOKEN` in hosted mode. That switches the process back to a single shared bearer.

## What the official API does not have

The WHOOP v2 public API ([docs](https://developer.whoop.com/api/)) has **no heart-rate time series, no hypnogram, no Journal, no stress data and no writes**. So this server **cannot** compute sleep-onset HR, lowest HR or when it happened, average sleeping HR, or pre-bed HR. `whoop_sleep_hr_metrics` returns those as `not_available` instead of guessing. The sleep-window heart data the API does give is per-night **resting HR and HRV (from the recovery)** plus **respiratory rate (from the sleep)**. If you need the HR curve or Journal answers, see [`unofficial/`](unofficial/README.md). It explains that option and its risks.

## Tools

| Tool | What it returns |
|---|---|
| `whoop_profile` | Name and email, height, weight, WHOOP max HR |
| `whoop_sleeps` | Per sleep: start/end, in-bed, light, **SWS, REM, restorative (SWS+REM)**, awake, disturbances, cycles, respiratory rate, efficiency, consistency, performance, sleep need. Naps are flagged |
| `whoop_recoveries` | Recovery %, **resting HR**, **HRV (RMSSD, ms)**, SpO2 %, skin temp °C |
| `whoop_cycles` | Day strain, kJ, average and max HR for the whole cycle |
| `whoop_workouts` | Sport, times, strain, avg/max HR, kJ, distance, HR-zone minutes |
| `whoop_last_night` | Latest scored main sleep, its recovery, and the current cycle |
| `whoop_sleep_hr_metrics` | One night's RHR, HRV, respiratory rate, SpO2, skin temp and restorative minutes, each compared with a rolling baseline of earlier nights (7 by default). It lists which HR metrics the API does not expose |

## Local single-user mode

Requires Node 20 or newer. Create a WHOOP app as in hosting step 1, but set **Redirect URI** to `http://localhost:8787/callback`.

```bash
npm install -g <this-package>       # or: git clone … && npm install
export WHOOP_CLIENT_ID=…  WHOOP_CLIENT_SECRET=…
whoop-sleep-mcp auth                # opens a local callback on :8787, then saves tokens
#   no browser on this machine? use:  whoop-sleep-mcp auth --manual
whoop-sleep-mcp status
whoop-sleep-mcp serve               # stdio MCP
```

Tokens are saved to `~/.whoop-mcp/tokens.json` with mode 600 (`WHOOP_TOKEN_FILE` to change). WHOOP rotates the refresh token on every refresh; the server saves the new one.

**Single-user HTTP** (one person, a shared secret — not OAuth, not multi-user):

```bash
MCP_TRANSPORT=http MCP_AUTH_TOKEN=$(openssl rand -hex 32) PORT=3000 whoop-sleep-mcp serve
```

`POST /mcp` with `Authorization: Bearer <MCP_AUTH_TOKEN>`. `GET /health` is open. Use this only when you cannot run hosted OAuth; every client that has the token is the same user.

## How hosted auth works

Remote MCP over Streamable HTTP follows the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization): protected-resource metadata, an OAuth authorization server, PKCE, and dynamic client registration. This process **is** that authorization server. It does not send people to a generic login page of our own; `/authorize` redirects to WHOOP, `/callback` stores that person's WHOOP tokens (encrypted, keyed by WHOOP user id), and then issues an MCP access token to the client. The TypeScript SDK's `mcpAuthRouter` + `OAuthServerProvider` implement the wire format.

A per-user connector URL token was considered and rejected as the default: it is easier to type, but every user would need a unique secret URL, there is no browser sign-in, and clients that already know MCP OAuth would not use it. The shared `MCP_AUTH_TOKEN` HTTP mode remains only for a private single-user deploy.

## Notes

- WHOOP collections return at most 25 records per page. Tools page through them up to `limit` (max 100). If WHOOP returns 429, wait a minute and retry.
- Sleeps and recoveries that WHOOP hasn't scored yet are skipped by the night-level tools.
- Run the tests with `npm test`.

MIT licensed. See `LICENSE`.
