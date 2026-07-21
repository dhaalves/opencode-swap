import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { KeyPool } from "../src/pool.js";
import { startServer } from "../src/proxy.js";

/**
 * Fake upstream: behavior keyed on the Bearer token it receives.
 *  - "bad"  -> 429 with retry-after-ms: 60000
 *  - "dead" -> 401
 *  - "good" -> 200 JSON echo of which key served
 *  - "sse"  -> 200 text/event-stream
 */
function makeUpstream() {
  return http.createServer((req, res) => {
    const key = (req.headers.authorization ?? "").replace("Bearer ", "");
    if (key === "bad") {
      res.writeHead(429, { "retry-after-ms": "60000", "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "slow down" }));
    }
    if (key === "dead") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid key" }));
    }
    if (key === "sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: chunk1\n\n");
      setTimeout(() => {
        res.write("data: chunk2\n\n");
        res.end("data: [DONE]\n\n");
      }, 20);
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ servedBy: key, path: req.url, echo: body }));
    });
  });
}

let upstream, upstreamPort, server, pool;

async function boot(keys) {
  pool = new KeyPool({ persist: false });
  keys.forEach((k, i) => pool.add(k, `key${i}`));
  server = await startServer({
    pool,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    port: 0,
    log: () => {},
  });
  return server.address().port;
}

before(async () => {
  upstream = makeUpstream();
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  upstreamPort = upstream.address().port;
});

after(async () => {
  server?.close();
  upstream?.close();
});

test("rotates from 429 key to healthy key and returns upstream response", async () => {
  const port = await boot(["bad", "good"]);
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ignored-by-oswap" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.servedBy, "good");
  assert.equal(data.path, "/v1/chat/completions");
  // the bad key got marked and skipped
  const bad = pool.keys.find((k) => k.key === "bad");
  assert.equal(bad.stats.rateLimits, 1);
  assert.ok(bad.cooldownUntil > Date.now());
  server.close();
});

test("401 key is cooled for a long time and rotation continues", async () => {
  const port = await boot(["dead", "good"]);
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).servedBy, "good");
  const dead = pool.keys.find((k) => k.key === "dead");
  assert.ok(dead.cooldownUntil > Date.now() + 3_500_000);
  server.close();
});

test("SSE stream passes through untouched", async () => {
  const port = await boot(["sse"]);
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream: true }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const text = await res.text();
  assert.equal(text, "data: chunk1\n\ndata: chunk2\n\ndata: [DONE]\n\n");
  server.close();
});

test("all keys cooling past maxWait -> 429 with retry-after", async () => {
  pool = new KeyPool({ persist: false, rateLimitCooldownMs: 120_000 });
  pool.add("bad");
  server = await startServer({ pool, upstream: `http://127.0.0.1:${upstreamPort}`, port: 0, maxWaitMs: 500, log: () => {} });
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("retry-after"));
  const data = await res.json();
  assert.equal(data.error.type, "oswap_all_keys_cooling");
  server.close();
});

test("no keys configured -> 503", async () => {
  pool = new KeyPool({ persist: false });
  server = await startServer({ pool, upstream: `http://127.0.0.1:${upstreamPort}`, port: 0, log: () => {} });
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(res.status, 503);
  server.close();
});

test("/oswap/status reports masked keys", async () => {
  const port = await boot(["sk-goodkey123456"]);
  const res = await fetch(`http://127.0.0.1:${port}/oswap/status`);
  const data = await res.json();
  assert.equal(data.keys.length, 1);
  assert.match(data.keys[0].key, /\.\.\./);
  assert.equal(data.keys[0].state, "ready");
  server.close();
});
