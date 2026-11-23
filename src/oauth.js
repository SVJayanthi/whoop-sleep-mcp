// MCP authorization server that delegates sign-in to WHOOP OAuth.
// MCP clients talk OAuth 2.1 + PKCE + DCR to this process; this process talks OAuth 2.0 to WHOOP.
import { randomBytes } from "node:crypto";
import { AUTH_URL, API_BASE, SCOPES, exchangeToken } from "./whoop.js";
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export function sameResource(a, b) {
  if (!a || !b) return false;
  const n = (u) => String(u).replace(/\/$/, "");
  return n(a) === n(b);
}

export class WhoopDelegatingOAuthProvider {
  constructor({ store, whoopCfg, mcpResource, fetchImpl = fetch }) {
    this.store = store;
    this.whoopCfg = whoopCfg;
    this.mcpResource = mcpResource; // URL of this server's /mcp
    this.fetchImpl = fetchImpl;
    this.clientsStore = {
      getClient: async (id) => store.getClient(id),
      registerClient: async (client) => store.saveClient(client),
    };
  }

  async authorize(client, params, res) {
    if (params.resource && !sameResource(params.resource, this.mcpResource)) {
      throw new InvalidRequestError("resource does not match this MCP server");
    }
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }
    // WHOOP requires state to be exactly 8 characters. Map it to the MCP client's state.
    const whoopState = randomBytes(4).toString("hex");
    this.store.putPending(whoopState, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes?.length ? params.scopes : ["whoop"],
      state: params.state,
      resource: (params.resource || this.mcpResource).href ?? String(params.resource || this.mcpResource),
    });
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.whoopCfg.clientId,
      redirect_uri: this.whoopCfg.redirectUri,
      scope: SCOPES.join(" "),
      state: whoopState,
    }).toString();
    res.redirect(url.toString());
  }

  async completeWhoopCallback(whoopCode, whoopState) {
    const pending = this.store.takePending(whoopState);
    if (!pending) throw new Error("Unknown or expired sign-in. Close this tab and try connecting again.");
    const tok = await exchangeToken(
      this.whoopCfg,
      { grant_type: "authorization_code", code: whoopCode, redirect_uri: this.whoopCfg.redirectUri },
      this.fetchImpl,
    );
    if (!tok.refresh_token) {
      throw new Error("WHOOP did not return a refresh token. Enable the `offline` scope on the WHOOP app.");
    }
    const profileRes = await this.fetchImpl(`${API_BASE}/v2/user/profile/basic`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const text = await profileRes.text();
    if (!profileRes.ok) throw new Error(`WHOOP profile ${profileRes.status}: ${text.slice(0, 200)}`);
    const profile = JSON.parse(text);
    const userId = profile?.user_id;
    if (userId == null) throw new Error("WHOOP profile did not include user_id.");
    this.store.setWhoopTokens(userId, tok);
    const code = randomBytes(24).toString("hex");
    this.store.putCode(code, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      userId: String(userId),
    });
    return { redirectUri: pending.redirectUri, code, state: pending.state };
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const rec = this.store.peekCode(authorizationCode);
    if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
    const rec = this.store.takeCode(authorizationCode);
    if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    if (redirectUri && rec.redirectUri && redirectUri !== rec.redirectUri) {
      throw new InvalidGrantError("redirect_uri mismatch");
    }
    if (resource && rec.resource && !sameResource(resource, rec.resource)) {
      throw new InvalidGrantError("resource mismatch");
    }
    return this.store.issueMcpTokens({
      userId: rec.userId,
      clientId: client.client_id,
      scopes: rec.scopes,
      resource: rec.resource || this.mcpResource.href,
    });
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    if (resource && !sameResource(resource, this.mcpResource)) {
      throw new InvalidGrantError("resource mismatch");
    }
    const issued = this.store.rotateRefresh(refreshToken, client.client_id);
    if (!issued) throw new InvalidGrantError("Invalid refresh token");
    if (scopes?.length) issued.scope = scopes.join(" ");
    return issued;
  }

  async verifyAccessToken(token) {
    const rec = this.store.lookupAccess(token);
    if (!rec) throw new InvalidTokenError("Invalid or expired token");
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes || [],
      expiresAt: rec.expiresAt,
      resource: rec.resource ? new URL(rec.resource) : this.mcpResource,
      extra: { whoopUserId: rec.userId },
    };
  }

  async revokeToken(_client, request) {
    if (request?.token) this.store.revokeToken(request.token);
  }
}
