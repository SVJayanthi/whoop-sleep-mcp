# whoop-sleep-mcp

A small, read-only MCP server for the **official WHOOP Developer API v2**: sleep, recovery, cycles, workouts and profile, plus a `whoop_sleep_hr_metrics` tool for heart metrics around the sleep window. Each user connects **their own** WHOOP developer app. The package ships no tokens, client IDs or personal data.

> Not affiliated with WHOOP. You need an active WHOOP membership.

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

### What the official API does not have
The WHOOP v2 public API ([docs](https://developer.whoop.com/api/)) has **no heart-rate time series, no hypnogram, no Journal, no stress data and no writes**. So this server **cannot** compute sleep-onset HR, lowest HR or when it happened, average sleeping HR, or pre-bed HR. `whoop_sleep_hr_metrics` returns those as `not_available` instead of guessing. The sleep-window heart data the API does give is per-night **resting HR and HRV (from the recovery)** plus **respiratory rate (from the sleep)**. If you need the HR curve or Journal answers, see [`unofficial/`](unofficial/README.md). It explains that option and its risks.

## 1. Create a WHOOP developer app (about 5 minutes)
1. Go to <https://developer-dashboard.whoop.com> and sign in with your WHOOP account. Create a Team when it asks.
2. Open **Apps → Create** (<https://developer-dashboard.whoop.com/apps/create>).
3. **Scopes:** tick `read:sleep`, `read:recovery`, `read:cycles`, `read:workout`, `read:profile` and `read:body_measurement`. The server also requests `offline` during sign-in, which WHOOP needs to issue a refresh token.
4. **Redirect URI:** add `http://localhost:8787/callback`. The URI used at sign-in must match it exactly. If the dashboard won't accept a localhost URL, register an HTTPS URL you control and set `WHOOP_REDIRECT_URI` to the same value. Then sign in with `auth --manual` (below).
5. Save, then copy the **Client ID** and **Client Secret**. Treat the secret like a password.

## 2. Install and authorize
Requires Node 20 or newer.
```bash
npm install -g <this-package>       # or: git clone … && npm install
export WHOOP_CLIENT_ID=…  WHOOP_CLIENT_SECRET=…
whoop-sleep-mcp auth                # opens a local callback on :8787, then saves tokens
#   no browser on this machine? use:  whoop-sleep-mcp auth --manual
#   (open the printed URL anywhere, approve, then paste the full redirect URL back)
whoop-sleep-mcp status              # confirms a refresh token is stored
```
Tokens are saved to `~/.whoop-mcp/tokens.json` with mode 600. You can change the path with `WHOOP_TOKEN_FILE`. WHOOP rotates the refresh token on every refresh, and the server saves the new one each time. Run `auth` again if WHOOP ever revokes access.

## 3. Run it
- **Local (stdio):** `whoop-sleep-mcp serve`
- **Hosted (Streamable HTTP):** `MCP_TRANSPORT=http MCP_AUTH_TOKEN=$(openssl rand -hex 32) PORT=3000 whoop-sleep-mcp serve`. The endpoint is `POST /mcp` with header `Authorization: Bearer <MCP_AUTH_TOKEN>`, and `GET /health` is open. The `Dockerfile` works on Fly, Railway, Render or a VPS. On a host with no persistent disk, seed the token with `WHOOP_REFRESH_TOKEN` and mount a volume for `WHOOP_TOKEN_FILE`, because the token rotates.

## 4. Add it to Grok Bot as a custom connector
Ask your bot: *"Add my WHOOP MCP as a custom connector."* Then give it one of these:
- **Command (runs on the bot's computer):** command `whoop-sleep-mcp`, args `["serve"]`, env `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET`. Run `whoop-sleep-mcp auth --manual` on that computer first. The bot can do this for you.
- **Remote URL:** `https://<your-host>/mcp` with header `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Check that it works by asking: *"Use whoop_last_night and tell me my restorative minutes."*

Other MCP clients (Claude Desktop, Cursor) use the same command or URL.

## Environment
| Var | Default | Purpose |
|---|---|---|
| `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` | — (required) | Your app's credentials |
| `WHOOP_REDIRECT_URI` | `http://localhost:8787/callback` | Must match the dashboard |
| `WHOOP_TOKEN_FILE` | `~/.whoop-mcp/tokens.json` | Where rotating tokens are stored |
| `WHOOP_REFRESH_TOKEN` | — | Optional bootstrap for hosted deploys |
| `MCP_TRANSPORT`, `MCP_AUTH_TOKEN`, `PORT` | stdio, —, 3000 | HTTP mode |

## Notes
- WHOOP collections return at most 25 records per page. Tools page through them up to `limit` (max 100). If WHOOP returns 429, wait a minute and retry.
- Sleeps and recoveries that WHOOP hasn't scored yet are skipped by the night-level tools.
- Run the tests with `npm test`.

MIT licensed. See `LICENSE`.
