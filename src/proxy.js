import http from "node:http";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_UPSTREAM } from "./pool.js";

/** Where the code in this process was loaded from — a global install or a repo checkout. */
export const SOURCE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Version of the code actually loaded into this process, not whatever is installed elsewhere. */
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(SOURCE_DIR, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization",
]);

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_ATTEMPTS = 12;
const DEFAULT_MAX_WAIT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse retry-after-ms (ms) or Retry-After (seconds | HTTP-date) headers into ms. */
export function parseRetryAfterMs(headers) {
  const raMs = headers.get("retry-after-ms");
  if (raMs != null && raMs !== "") {
    const n = Number(raMs);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const ra = headers.get("retry-after");
  if (ra != null && ra !== "") {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return null;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function buildUpstreamHeaders(req, apiKey, bodyLength) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (value === undefined) continue;
    headers[name] = value;
  }
  headers["authorization"] = `Bearer ${apiKey}`;
  headers["content-length"] = String(bodyLength);
  return headers;
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * Forward one request to the upstream, rotating keys on 429/401/403/5xx/network
 * errors until a key succeeds, attempts run out, or all keys are cooling past
 * maxWaitMs. Retries only happen before any response byte reaches the client,
 * so SSE streams are never half-duplicated.
 */
async function proxyOnce(pool, upstream, req, res, body, { maxWaitMs, log }) {
  const url = new URL(req.url, "http://internal");
  const target = upstream.replace(/\/$/, "") + url.pathname + url.search;

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const deadline = Date.now() + maxWaitMs;
  let attempts = 0;

  for (;;) {
    if (abort.signal.aborted) return;

    let slot = pool.acquire();
    if (!slot) {
      const waitMs = pool.nextAvailableAt() - Date.now();
      if (!Number.isFinite(waitMs)) {
        return sendJson(res, 503, { error: { message: "oswap: no keys configured in pool", type: "oswap_no_keys" } });
      }
      if (Date.now() + waitMs > deadline) {
        return sendJson(
          res,
          429,
          {
            error: { message: `oswap: all keys rate-limited, next available in ${Math.ceil(waitMs / 1000)}s`, type: "oswap_all_keys_cooling" },
          },
          { "retry-after": String(Math.ceil(waitMs / 1000)) },
        );
      }
      log?.(`all keys cooling; waiting ${Math.ceil(waitMs / 1000)}s for next available key`);
      await sleep(waitMs);
      continue;
    }

    if (++attempts > MAX_ATTEMPTS) {
      return sendJson(res, 502, { error: { message: "oswap: max rotation attempts exceeded", type: "oswap_max_attempts" } });
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(target, {
        method: req.method,
        headers: buildUpstreamHeaders(req, slot.key, body.length),
        body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      pool.reportError(slot.id, `network: ${err.message}`);
      log?.(`[${slot.label || slot.id}] network error: ${err.message} -> rotating`);
      continue;
    }

    if (upstreamRes.status === 429) {
      const retryAfterMs = parseRetryAfterMs(upstreamRes.headers);
      await upstreamRes.arrayBuffer().catch(() => {}); // drain
      pool.reportRateLimit(slot.id, retryAfterMs);
      log?.(`[${slot.label || slot.id}] 429 rate-limited${retryAfterMs != null ? ` (retry-after ${retryAfterMs}ms)` : ""} -> rotating to next key`);
      continue;
    }

    if (upstreamRes.status === 401 || upstreamRes.status === 403) {
      const text = await upstreamRes.text().catch(() => "");
      pool.reportAuthFail(slot.id, `${upstreamRes.status}: ${text.slice(0, 120)}`);
      log?.(`[${slot.label || slot.id}] auth rejected (${upstreamRes.status}) -> cooling 1h, rotating`);
      continue;
    }

    if (upstreamRes.status >= 500) {
      const text = await upstreamRes.text().catch(() => "");
      pool.reportError(slot.id, `${upstreamRes.status}: ${text.slice(0, 120)}`);
      log?.(`[${slot.label || slot.id}] upstream ${upstreamRes.status} -> rotating`);
      continue;
    }

    // Success or non-retryable 4xx: stream through untouched.
    if (upstreamRes.ok) pool.reportSuccess(slot.id);
    const headers = {};
    for (const [name, value] of upstreamRes.headers.entries()) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      headers[name] = value;
    }
    // fetch already decompressed the body; stale framing headers would corrupt downstream
    delete headers["content-encoding"];
    delete headers["content-length"];
    res.writeHead(upstreamRes.status, headers);
    if (!upstreamRes.body) return res.end();
    const stream = Readable.fromWeb(upstreamRes.body);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return;
  }
}

export function createOswapServer({
  pool,
  upstream = DEFAULT_UPSTREAM,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  log = console.error,
} = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/oswap/health") {
        return sendJson(res, 200, { ok: true, upstream, version: VERSION, pid: process.pid, source: SOURCE_DIR });
      }
      if (req.method === "GET" && req.url === "/oswap/status") {
        return sendJson(res, 200, { upstream, version: VERSION, keys: pool.status() });
      }
      const body = ["GET", "HEAD"].includes(req.method) ? Buffer.alloc(0) : await readBody(req);
      await proxyOnce(pool, upstream, req, res, body, { maxWaitMs, log });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: { message: `oswap: ${err.message}`, type: "oswap_internal" } });
      else res.destroy();
    }
  });
  // Long generations: no idle/request timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  return server;
}

export async function startServer(opts) {
  const server = createOswapServer(opts);
  const port = opts?.port ?? 8788;
  const host = opts?.host ?? "127.0.0.1";
  server.listen(port, host);
  await once(server, "listening");
  return server;
}
