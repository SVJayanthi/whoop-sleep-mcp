// Persistent store for hosted mode: OAuth clients, MCP tokens, and per-user WHOOP tokens.
// WHOOP refresh/access tokens are encrypted at rest with AES-256-GCM bound to the user id.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { deriveKey, encryptJson, decryptJson, sha256 } from "./crypto.js";

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const PENDING_TTL_MS = 15 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;

const empty = () => ({
  v: 1,
  clients: {},
  users: {},
  access: {},
  refresh: {},
  codes: {},
  pending: {},
});

export class HostedStore {
  constructor({ dir, file, encryptionKey, now = Date.now } = {}) {
    this.key = deriveKey(encryptionKey);
    this.file = file || join(dir || join(homedir(), ".whoop-mcp"), "hosted-store.json");
    this.now = now;
    this.data = this.#read();
  }

  #read() {
    if (!existsSync(this.file)) return empty();
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return { ...empty(), ...parsed };
    } catch {
      return empty();
    }
  }

  #write() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data));
    try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
    renameSync(tmp, this.file);
  }

  #prune() {
    const now = this.now();
    const nowS = Math.floor(now / 1000);
    for (const [k, rec] of Object.entries(this.data.pending)) {
      if (now - rec.createdAt > PENDING_TTL_MS) delete this.data.pending[k];
    }
    for (const [k, rec] of Object.entries(this.data.codes)) {
      if (now - rec.createdAt > CODE_TTL_MS) delete this.data.codes[k];
    }
    for (const [k, rec] of Object.entries(this.data.access)) {
      if (rec.expiresAt < nowS) delete this.data.access[k];
    }
    for (const [k, rec] of Object.entries(this.data.refresh)) {
      if (rec.expiresAt < nowS) delete this.data.refresh[k];
    }
  }

  getClient(clientId) {
    return this.data.clients[clientId] || undefined;
  }

  saveClient(client) {
    const scope = client.scope && String(client.scope).trim() ? client.scope : "whoop";
    const rec = { ...client, scope };
    this.data.clients[rec.client_id] = rec;
    this.#write();
    return rec;
  }

  putPending(state, rec) {
    this.data.pending[state] = { ...rec, createdAt: rec.createdAt ?? this.now() };
    this.#write();
  }

  takePending(state) {
    this.#prune();
    const rec = this.data.pending[state];
    if (!rec) return null;
    delete this.data.pending[state];
    this.#write();
    return rec;
  }

  putCode(code, rec) {
    this.data.codes[code] = { ...rec, createdAt: rec.createdAt ?? this.now() };
    this.#write();
  }

  peekCode(code) {
    this.#prune();
    return this.data.codes[code] || null;
  }

  takeCode(code) {
    this.#prune();
    const rec = this.data.codes[code];
    if (!rec) return null;
    delete this.data.codes[code];
    this.#write();
    return rec;
  }

  getWhoopTokens(userId) {
    const rec = this.data.users[String(userId)];
    if (!rec?.blob) return null;
    return decryptJson(this.key, rec.blob, String(userId));
  }

  setWhoopTokens(userId, tokens) {
    const id = String(userId);
    this.data.users[id] = {
      blob: encryptJson(this.key, tokens, id),
      updatedAt: this.now(),
    };
    this.#write();
  }

  whoopStoreForUser(userId) {
    const id = String(userId);
    return {
      load: () => this.getWhoopTokens(id),
      save: (tok) => this.setWhoopTokens(id, tok),
    };
  }

  issueMcpTokens({ userId, clientId, scopes, resource }) {
    const access = randomBytes(32).toString("hex");
    const refresh = randomBytes(32).toString("hex");
    const nowS = Math.floor(this.now() / 1000);
    const ah = sha256(access);
    const rh = sha256(refresh);
    const rec = {
      userId: String(userId),
      clientId,
      scopes: scopes || [],
      resource: resource ? String(resource) : undefined,
    };
    this.data.access[ah] = { ...rec, expiresAt: nowS + ACCESS_TTL_S, refreshHash: rh };
    this.data.refresh[rh] = { ...rec, expiresAt: nowS + REFRESH_TTL_S, accessHash: ah };
    this.#write();
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "bearer",
      expires_in: ACCESS_TTL_S,
      scope: (scopes || []).join(" "),
    };
  }

  lookupAccess(token) {
    this.#prune();
    return this.data.access[sha256(token)] || null;
  }

  rotateRefresh(refreshToken, clientId) {
    this.#prune();
    const rh = sha256(refreshToken);
    const rec = this.data.refresh[rh];
    if (!rec || rec.clientId !== clientId) return null;
    delete this.data.refresh[rh];
    if (rec.accessHash) delete this.data.access[rec.accessHash];
    return this.issueMcpTokens(rec);
  }

  revokeToken(token) {
    const ah = sha256(token);
    const rh = sha256(token);
    const access = this.data.access[ah];
    const refresh = this.data.refresh[rh];
    if (access) {
      delete this.data.access[ah];
      if (access.refreshHash) delete this.data.refresh[access.refreshHash];
    }
    if (refresh) {
      delete this.data.refresh[rh];
      if (refresh.accessHash) delete this.data.access[refresh.accessHash];
    }
    this.#write();
  }

  userIds() {
    return Object.keys(this.data.users);
  }
}
