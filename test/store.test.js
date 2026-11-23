import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveKey, encryptJson, decryptJson } from "../src/crypto.js";
import { HostedStore } from "../src/store.js";
import { WhoopClient } from "../src/whoop.js";

const key = "a".repeat(64);

test("encrypted blob is bound to user id (cannot be swapped)", () => {
  const k = deriveKey(key);
  const blob = encryptJson(k, { refresh_token: "secret-a" }, "1");
  assert.throws(() => decryptJson(k, blob, "2"));
  assert.equal(decryptJson(k, blob, "1").refresh_token, "secret-a");
});

test("per-user WHOOP tokens stay isolated and ciphertext is not plaintext on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "whoop-store-"));
  const store = new HostedStore({ dir, encryptionKey: key });
  store.setWhoopTokens("10", { refresh_token: "r-alice", access_token: "a-alice" });
  store.setWhoopTokens("20", { refresh_token: "r-bob", access_token: "a-bob" });
  assert.equal(store.getWhoopTokens("10").refresh_token, "r-alice");
  assert.equal(store.getWhoopTokens("20").refresh_token, "r-bob");
  assert.equal(store.getWhoopTokens("99"), null);

  const raw = readFileSync(store.file, "utf8");
  assert.equal(raw.includes("r-alice"), false);
  assert.equal(raw.includes("r-bob"), false);
  assert.equal(raw.includes("a-alice"), false);
  assert.match(raw, /"blob":/);

  // Moving Alice's blob onto Bob's slot must fail closed, not decrypt as Bob.
  const parsed = JSON.parse(raw);
  parsed.users["20"] = parsed.users["10"];
  const hijack = new HostedStore({ dir: mkdtempSync(join(tmpdir(), "whoop-store-")), encryptionKey: key });
  hijack.data = parsed;
  assert.throws(() => hijack.getWhoopTokens("20"));
});

test("WhoopClient refresh rotation writes only that user's encrypted tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whoop-store-"));
  const store = new HostedStore({ dir, encryptionKey: key });
  store.setWhoopTokens("1", { refresh_token: "r0" });
  store.setWhoopTokens("2", { refresh_token: "keep-me" });
  let refreshes = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/oauth2/token")) {
      refreshes++;
      assert.match(String(init.body), /refresh_token=r0/);
      return new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3600 }));
    }
    return new Response(JSON.stringify({ records: [{ id: 1 }] }));
  };
  const c = new WhoopClient({
    cfg: { clientId: "x", clientSecret: "y" },
    store: store.whoopStoreForUser("1"),
    fetchImpl,
  });
  await c.cycles({ maxRecords: 1 });
  assert.equal(refreshes, 1);
  assert.equal(store.getWhoopTokens("1").refresh_token, "r1");
  assert.equal(store.getWhoopTokens("2").refresh_token, "keep-me");
});

test("MCP refresh tokens rotate and revoke", () => {
  const store = new HostedStore({ dir: mkdtempSync(join(tmpdir(), "whoop-store-")), encryptionKey: key });
  const first = store.issueMcpTokens({ userId: "1", clientId: "c", scopes: ["whoop"], resource: "https://x/mcp" });
  assert.ok(store.lookupAccess(first.access_token));
  const rotated = store.rotateRefresh(first.refresh_token, "c");
  assert.equal(store.lookupAccess(first.access_token), null);
  assert.ok(store.lookupAccess(rotated.access_token));
  assert.equal(store.rotateRefresh(first.refresh_token, "c"), null);
  store.revokeToken(rotated.access_token);
  assert.equal(store.lookupAccess(rotated.access_token), null);
});
