import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyPool, maskKey } from "../src/pool.js";
import { parseRetryAfterMs } from "../src/proxy.js";

const makePool = (keys, opts = {}) => {
  const pool = new KeyPool({ persist: false, ...opts });
  for (const [i, k] of keys.entries()) pool.add(k, `k${i}`);
  return pool;
};

test("add dedupes by key value", () => {
  const pool = makePool(["aaa"]);
  const again = pool.add("aaa");
  assert.equal(again.added, false);
  assert.equal(pool.keys.length, 1);
});

test("acquire rotates round-robin across usable keys", () => {
  const pool = makePool(["a", "b", "c"]);
  const order = [pool.acquire().key, pool.acquire().key, pool.acquire().key, pool.acquire().key];
  assert.deepEqual(order, ["a", "b", "c", "a"]);
});

test("rate-limited key is skipped and cooldown honors retryAfterMs", () => {
  const pool = makePool(["a", "b"]);
  const first = pool.acquire(); // a
  const before = Date.now();
  pool.reportRateLimit(first.id, 5000);
  const rec = pool.keys.find((k) => k.key === "a");
  assert.ok(rec.cooldownUntil >= before + 5000 && rec.cooldownUntil <= Date.now() + 5000);
  assert.equal(rec.stats.rateLimits, 1);
  // next acquisitions only pick b
  assert.equal(pool.acquire().key, "b");
  assert.equal(pool.acquire().key, "b");
});

test("default cooldown applies when no retry-after given", () => {
  const pool = makePool(["a"], { rateLimitCooldownMs: 60_000 });
  pool.reportRateLimit(pool.keys[0].id, null);
  assert.ok(pool.keys[0].cooldownUntil > Date.now() + 50_000);
});

test("nextAvailableAt: 0 when usable, earliest cooldown when all cooling, Infinity when empty", () => {
  const pool = makePool(["a", "b"]);
  assert.equal(pool.nextAvailableAt(), 0);
  pool.reportRateLimit(pool.keys[0].id, 1000);
  pool.reportRateLimit(pool.keys[1].id, 9000);
  const next = pool.nextAvailableAt();
  assert.ok(next > Date.now() && next <= Date.now() + 1000);
  assert.equal(new KeyPool({ persist: false }).nextAvailableAt(), Infinity);
});

test("acquire returns null when every key is cooling", () => {
  const pool = makePool(["a"]);
  pool.reportRateLimit(pool.keys[0].id, 60_000);
  assert.equal(pool.acquire(), null);
});

test("auth fail cools the key down for a long time", () => {
  const pool = makePool(["a"], { authFailCooldownMs: 3_600_000 });
  pool.reportAuthFail(pool.keys[0].id);
  assert.ok(pool.keys[0].cooldownUntil > Date.now() + 3_500_000);
  assert.equal(pool.keys[0].stats.failures, 1);
});

test("reset clears cooldown and disabled", () => {
  const pool = makePool(["a"]);
  pool.reportRateLimit(pool.keys[0].id, 60_000);
  pool.keys[0].disabled = true;
  pool.reset(pool.keys[0].id);
  assert.equal(pool.keys[0].cooldownUntil, 0);
  assert.equal(pool.keys[0].disabled, false);
  assert.equal(pool.acquire().key, "a");
});

test("success clears a previous cooldown", () => {
  const pool = makePool(["a"]);
  const k = pool.keys[0];
  k.cooldownUntil = Date.now() + 60_000;
  pool.reportSuccess(k.id);
  assert.equal(k.cooldownUntil, 0);
});

test("maskKey hides the secret", () => {
  assert.equal(maskKey("sk-1234567890abcdef"), "sk-12...cdef");
  assert.equal(maskKey("short"), "****");
});

test("parseRetryAfterMs: retry-after-ms wins, Retry-After seconds, absent -> null", () => {
  const h = (obj) => new Headers(obj);
  assert.equal(parseRetryAfterMs(h({ "retry-after-ms": "1500" })), 1500);
  assert.equal(parseRetryAfterMs(h({ "retry-after": "2" })), 2000);
  assert.equal(parseRetryAfterMs(h({ "retry-after-ms": "100", "retry-after": "9" })), 100);
  assert.equal(parseRetryAfterMs(h({})), null);
  assert.ok(parseRetryAfterMs(h({ "retry-after": new Date(Date.now() + 3000).toUTCString() })) > 0);
});
