#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, copyFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KeyPool, DEFAULT_KEYS_PATH, DEFAULT_UPSTREAM, maskKey } from "./pool.js";
import { startServer } from "./proxy.js";

const DEFAULT_PORT = 8788;

// ---------- arg parsing ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (name === "dry-run" || name === "force" || name === "quiet") {
        args[name] = true;
      } else {
        args[name] = argv[++i];
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const num = (v, fallback) => (v != null && Number.isFinite(Number(v)) ? Number(v) : fallback);

// ---------- opencode paths ----------

const opencodeDataDir = () =>
  process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "opencode") : join(homedir(), ".local", "share", "opencode");
const opencodeConfigDir = () =>
  process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "opencode") : join(homedir(), ".config", "opencode");

/** Collect opencode-go keys from auth.json + account.json. Returns [{key, label}]. */
export function collectOpencodeGoKeys({ provider = "opencode-go", dataDir = opencodeDataDir() } = {}) {
  const found = [];
  const seen = new Set();
  const push = (key, label) => {
    if (typeof key === "string" && key.length > 0 && !seen.has(key)) {
      seen.add(key);
      found.push({ key, label });
    }
  };

  const authPath = join(dataDir, "auth.json");
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      if (auth[provider]?.type === "api" && auth[provider].key) push(auth[provider].key, "auth.json");
    } catch (err) {
      console.error(`warn: could not parse ${authPath}: ${err.message}`);
    }
  }

  const accountPath = join(dataDir, "account.json");
  if (existsSync(accountPath)) {
    try {
      const store = JSON.parse(readFileSync(accountPath, "utf8"));
      for (const acc of Object.values(store.accounts ?? {})) {
        if (acc.serviceID === provider && acc.credential?.type === "api" && acc.credential.key) {
          push(acc.credential.key, `account.json:${acc.description || acc.id}`);
        }
      }
    } catch (err) {
      console.error(`warn: could not parse ${accountPath}: ${err.message}`);
    }
  }
  return found;
}

// ---------- commands ----------

function openPool(args) {
  const path = args.keys ? resolve(args.keys) : DEFAULT_KEYS_PATH;
  return new KeyPool({ path }).load();
}

async function cmdServe(args) {
  const pool = openPool(args);
  if (pool.keys.length === 0) {
    console.error(`oswap: no keys in ${pool.path}. Run 'oswap import' or 'oswap add <key>' first.`);
    process.exit(1);
  }
  const port = num(args.port, DEFAULT_PORT);
  const host = args.host ?? "127.0.0.1";
  const upstream = args.upstream ?? DEFAULT_UPSTREAM;
  const maxWaitMs = num(args["max-wait-ms"], 30_000);
  const server = await startServer({ pool, upstream, port, host, maxWaitMs });
  const addr = server.address();
  console.log(`oswap proxy listening on http://${addr.address}:${addr.port}`);
  console.log(`upstream: ${upstream} | keys: ${pool.keys.length} | max-wait: ${maxWaitMs}ms`);
  console.log(`point opencode at it: provider.opencode-go.options.baseURL = "http://${addr.address}:${addr.port}/v1"`);
  console.log(`status: http://${addr.address}:${addr.port}/oswap/status`);
}

async function cmdStatus(args) {
  const port = num(args.port, DEFAULT_PORT);
  const host = args.host ?? "127.0.0.1";
  try {
    const res = await fetch(`http://${host}:${port}/oswap/status`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    console.log(`proxy: http://${host}:${port} -> ${data.upstream}`);
    printKeyTable(data.keys);
    return;
  } catch {
    console.log(`proxy not running on ${host}:${port}; showing saved pool:`);
  }
  const pool = openPool(args);
  printKeyTable(pool.status());
}

function printKeyTable(rows) {
  if (rows.length === 0) return console.log("(no keys)");
  const cols = ["id", "label", "key", "state", "requests", "rateLimits", "failures", "lastError"];
  const widths = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))]));
  console.log(cols.map((c) => c.padEnd(widths[c])).join("  "));
  for (const r of rows) {
    console.log(cols.map((c) => String(r[c] ?? "").padEnd(widths[c])).join("  "));
  }
}

function cmdAdd(args) {
  const key = args._[1];
  if (!key) return die("usage: oswap add <api-key> [--label name]");
  const pool = openPool(args);
  const { record, added } = pool.add(key, args.label ?? "");
  console.log(added ? `added ${maskKey(record.key)} (id ${record.id})` : `key already in pool (id ${record.id})`);
}

function cmdRemove(args) {
  const id = args._[1];
  if (!id) return die("usage: oswap remove <id-or-prefix>");
  const pool = openPool(args);
  const removed = pool.remove(id);
  console.log(removed ? `removed ${maskKey(removed.key)} (id ${removed.id})` : `no key matching '${id}'`);
}

function cmdList(args) {
  printKeyTable(openPool(args).status());
}

function cmdReset(args) {
  const pool = openPool(args);
  if (args._[1]) {
    const k = pool.reset(args._[1]);
    console.log(k ? `reset ${k.id} (${k.label || maskKey(k.key)})` : `no key matching '${args._[1]}'`);
  } else {
    for (const k of pool.keys) pool.reset(k.id);
    console.log(`reset ${pool.keys.length} key(s)`);
  }
}

function cmdImport(args) {
  const found = collectOpencodeGoKeys({ provider: args.provider ?? "opencode-go" });
  if (found.length === 0) return console.log("no opencode-go keys found in auth.json / account.json");
  const pool = openPool(args);
  let added = 0;
  for (const { key, label } of found) {
    console.log(`${args["dry-run"] ? "[dry-run] would add" : "import"} ${maskKey(key)}  (${label})`);
    if (!args["dry-run"]) {
      if (pool.add(key, label).added) added++;
    }
  }
  console.log(args["dry-run"] ? `${found.length} key(s) found` : `${added} new, ${found.length - added} already present (total ${pool.keys.length})`);
}

async function cmdTest(args) {
  const pool = openPool(args);
  if (pool.keys.length === 0) return die("pool is empty");
  const upstream = (args.upstream ?? DEFAULT_UPSTREAM).replace(/\/$/, "");
  console.log(`checking ${pool.keys.length} key(s) against ${upstream}/v1/models ...`);
  for (const k of pool.keys) {
    try {
      const res = await fetch(`${upstream}/v1/models`, {
        headers: { authorization: `Bearer ${k.key}` },
        signal: AbortSignal.timeout(15_000),
      });
      console.log(`${k.id} ${maskKey(k.key)} ${k.label ? `(${k.label}) ` : ""}-> HTTP ${res.status}`);
    } catch (err) {
      console.log(`${k.id} ${maskKey(k.key)} ${k.label ? `(${k.label}) ` : ""}-> ERROR ${err.message}`);
    }
  }
}

function cmdInstall(args) {
  const port = num(args.port, DEFAULT_PORT);
  const configPath = join(opencodeConfigDir(), "opencode.json");
  if (!existsSync(configPath)) return die(`not found: ${configPath}`);
  const raw = readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  const baseURL = `http://127.0.0.1:${port}/v1`;

  const current = config.provider?.["opencode-go"]?.options?.baseURL;
  if (current === baseURL && !args.force) {
    return console.log(`opencode-go already points at ${baseURL} — nothing to do`);
  }

  const backup = `${configPath}.oswap-bak`;
  copyFileSync(configPath, backup);
  config.provider ??= {};
  config.provider["opencode-go"] ??= {};
  config.provider["opencode-go"].options ??= {};
  if (args["api-key"]) config.provider["opencode-go"].options.apiKey = args["api-key"];
  config.provider["opencode-go"].options.baseURL = baseURL;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`backup: ${backup}`);
  console.log(`opencode.json: provider.opencode-go.options.baseURL = "${baseURL}"`);
  if (existsSync(join(opencodeConfigDir(), "opencode.jsonc"))) {
    console.log("note: opencode.jsonc also exists — make sure it does not override provider.opencode-go");
  }
  console.log("restart opencode to pick up the change. Run the proxy with: oswap serve");
}

function cmdUninstall(args) {
  const configPath = join(opencodeConfigDir(), "opencode.json");
  if (!existsSync(configPath)) return die(`not found: ${configPath}`);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.provider?.["opencode-go"]?.options?.baseURL) {
    copyFileSync(configPath, `${configPath}.oswap-bak`);
    delete config.provider["opencode-go"].options.baseURL;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log("removed baseURL override; opencode-go will use https://opencode.ai/zen/go/v1 directly");
  } else {
    console.log("no baseURL override set — nothing to do");
  }
}

function die(msg) {
  console.error(`oswap: ${msg}`);
  process.exit(1);
}

function cmdHelp() {
  console.log(`oswap — opencode-go key rotator (rate-limit aware proxy)

usage: oswap <command> [options]

commands:
  serve                 run the rotation proxy (default 127.0.0.1:${DEFAULT_PORT})
  status                live pool status (from running proxy, else saved file)
  add <key>             add an opencode-go API key [--label name]
  remove <id>           remove a key (id or id prefix, see list)
  list                  list keys (masked) with stats and state
  reset [id]            clear cooldown on one key, or all if no id given
  import                import opencode-go keys from auth.json + account.json [--dry-run]
  test                  check every key against the upstream /v1/models endpoint
  install               point opencode.json provider.opencode-go at the proxy (backs up first)
  uninstall             remove the baseURL override from opencode.json

options:
  --port <n>            proxy port (default ${DEFAULT_PORT})
  --host <h>            bind host (default 127.0.0.1)
  --upstream <url>      upstream base (default ${DEFAULT_UPSTREAM})
  --max-wait-ms <n>     max time to wait for a cooling key before 429 (default 30000)
  --keys <path>         pool file (default ${DEFAULT_KEYS_PATH})
  --provider <id>       provider for import (default opencode-go)

typical setup:
  oswap import          # pull existing opencode-go keys into keys.json
  oswap add sk-...      # add more accounts
  oswap install         # point opencode at the proxy
  oswap serve           # run the proxy (keep it running while using opencode)`);
}

// ---------- entry ----------

// npm-link shims invoke cli.js through a junction while import.meta.url is realpath'd —
// compare realpaths so the entry block runs either way.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? "help";

  const commands = {
    serve: cmdServe,
    status: cmdStatus,
    add: cmdAdd,
    remove: cmdRemove,
    rm: cmdRemove,
    list: cmdList,
    ls: cmdList,
    reset: cmdReset,
    import: cmdImport,
    test: cmdTest,
    install: cmdInstall,
    uninstall: cmdUninstall,
    help: cmdHelp,
  };

  if (!commands[cmd]) die(`unknown command '${cmd}' — run 'oswap help'`);
  await commands[cmd](args);
}
