import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPool } from "../src/pool.js";

/**
 * The pool file is shared between a long-running `oswap serve` and short-lived
 * CLI processes. These tests pin the concurrency contract between them.
 */

let dir;
let path;
const open = () => new KeyPool({ path }).load();
const onDisk = () => JSON.parse(readFileSync(path, "utf8")).keys;
const labels = (keys) => keys.map((k) => k.label).sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oswap-test-"));
  path = join(dir, "keys.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a running server's stat flush does not drop a key the CLI added", () => {
  const server = open();
  server.add("a", "original");

  open().add("b", "added-by-cli"); // separate process

  server.acquire(); // hot path: flushes stats from a list that predates "b"
  server.saveRuntime();

  assert.deepEqual(labels(onDisk()), ["added-by-cli", "original"]);
});

test("a running server's stat flush does not resurrect a key the CLI removed", () => {
  const server = open();
  server.add("a", "keep");
  server.add("b", "doomed");

  const cli = open();
  cli.remove(cli.keys.find((k) => k.label === "doomed").id);

  server.acquire();
  server.saveRuntime();

  assert.deepEqual(labels(onDisk()), ["keep"]);
});

test("the server picks up a CLI-added key without a restart", () => {
  const server = open();
  server.add("a", "original");
  assert.equal(server.usable().length, 1);

  open().add("b", "added-by-cli");

  assert.deepEqual([server.acquire().key, server.acquire().key].sort(), ["a", "b"]);
});

test("the server stops handing out a CLI-removed key", () => {
  const server = open();
  server.add("a", "keep");
  server.add("b", "doomed");

  const cli = open();
  cli.remove(cli.keys.find((k) => k.label === "doomed").id);

  assert.deepEqual([server.acquire().key, server.acquire().key], ["a", "a"]);
});

test("a CLI write keeps rotation stats the server recorded meanwhile", () => {
  const server = open();
  server.add("a", "original");

  server.acquire();
  server.reportRateLimit(server.keys[0].id, 60_000);
  const cooldown = onDisk()[0].cooldownUntil;
  assert.ok(cooldown > Date.now());

  open().add("b", "added-by-cli");

  const kept = onDisk().find((k) => k.label === "original");
  assert.equal(kept.stats.requests, 1);
  assert.equal(kept.stats.rateLimits, 1);
  assert.equal(kept.cooldownUntil, cooldown);
});

test("CLI reset clears a cooldown the server wrote", () => {
  const server = open();
  server.add("a", "original");
  server.reportRateLimit(server.keys[0].id, 60_000);

  const cli = open();
  cli.reset(cli.keys[0].id);

  assert.equal(onDisk()[0].cooldownUntil, 0);
  assert.equal(server.acquire().key, "a"); // server sees the reset too
});

test("add dedupes against a key another process already wrote", () => {
  open().add("a", "first");
  const second = open();
  assert.equal(second.add("a", "duplicate").added, false);
  assert.equal(onDisk().length, 1);
});
