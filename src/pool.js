import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

// User-level pool location: the npm package dir is wiped on every upgrade,
// so keys.json must live outside it.
const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, "oswap")
  : join(homedir(), ".config", "oswap");
export const DEFAULT_KEYS_PATH = join(CONFIG_DIR, "keys.json");
export const DEFAULT_UPSTREAM = "https://opencode.ai/zen/go";

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const DEFAULT_ERROR_COOLDOWN_MS = 30_000;
const DEFAULT_AUTH_FAIL_COOLDOWN_MS = 3_600_000; // 1h: key is probably dead, not throttled
// Upstream sends the *weekly-reset date* as Retry-After even when only the short
// (rolling) window tripped, which would bench a key for days. Cap what we honor so
// we re-probe within the hour and recover as soon as the real limit clears.
const DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS = 3_600_000; // 1h

const now = () => Date.now();

function newId() {
  return randomBytes(4).toString("hex");
}

export function maskKey(key) {
  if (typeof key !== "string" || key.length < 8) return "****";
  return `${key.slice(0, 5)}...${key.slice(-4)}`;
}

/** Fill in every field a record may be missing so the rest of the code never guards. */
function normalizeKeys(raw) {
  return (raw ?? []).map((k) => ({
    id: k.id ?? newId(),
    key: k.key,
    label: k.label ?? "",
    addedAt: k.addedAt ?? now(),
    cooldownUntil: k.cooldownUntil ?? 0,
    disabled: k.disabled ?? false,
    resetAt: k.resetAt ?? 0,
    stats: {
      requests: k.stats?.requests ?? 0,
      rateLimits: k.stats?.rateLimits ?? 0,
      failures: k.stats?.failures ?? 0,
      lastUsedAt: k.stats?.lastUsedAt ?? 0,
      lastError: k.stats?.lastError ?? null,
    },
  }));
}

/** Cheap change fingerprint for the pool file; null when it does not exist. */
function stamp(path) {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/** Identity/label come from `base`; live rotation state comes from `runtime`. */
function withRuntime(base, runtime) {
  return {
    ...base,
    cooldownUntil: runtime.cooldownUntil,
    disabled: runtime.disabled,
    resetAt: runtime.resetAt,
    stats: runtime.stats,
  };
}

/**
 * Pool of opencode-go API keys with round-robin rotation and per-key
 * cooldowns. Persisted as JSON (atomic tmp+rename) so stats/cooldowns
 * survive restarts.
 */
export class KeyPool {
  constructor({
    path = DEFAULT_KEYS_PATH,
    rateLimitCooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    errorCooldownMs = DEFAULT_ERROR_COOLDOWN_MS,
    authFailCooldownMs = DEFAULT_AUTH_FAIL_COOLDOWN_MS,
    maxRateLimitCooldownMs = DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS,
    persist = true,
  } = {}) {
    this.path = path;
    this.rateLimitCooldownMs = rateLimitCooldownMs;
    this.errorCooldownMs = errorCooldownMs;
    this.authFailCooldownMs = authFailCooldownMs;
    this.maxRateLimitCooldownMs = maxRateLimitCooldownMs;
    this.persist = persist;
    this.keys = [];
    this.rr = 0; // round-robin cursor
    this._saveTimer = null;
    this._diskStamp = null;
  }

  load() {
    const disk = this._readDisk();
    if (disk) this.keys = disk;
    return this;
  }

  /** Parsed pool file, or null when it is missing/unreadable. Also refreshes the change stamp. */
  _readDisk() {
    if (!existsSync(this.path)) return null;
    try {
      const keys = normalizeKeys(JSON.parse(readFileSync(this.path, "utf8")).keys);
      this._diskStamp = stamp(this.path);
      return keys;
    } catch (err) {
      console.error(`warn: could not read ${this.path}: ${err.message}`);
      return null;
    }
  }

  _write(keys) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, keys }, null, 2));
    renameSync(tmp, this.path);
    this._diskStamp = stamp(this.path);
  }

  /**
   * Adopt the key list from disk when another process changed it, keeping this
   * process's live rotation state for the keys that survived. Cheap enough
   * (one stat) to call on every request; that is what lets a long-running
   * `oswap serve` see `oswap add` / `oswap remove` without a restart.
   */
  refresh() {
    if (!this.persist) return this;
    const current = stamp(this.path);
    if (current === null || current === this._diskStamp) return this;
    const disk = this._readDisk();
    if (!disk) return this;
    const mine = new Map(this.keys.map((k) => [k.id, k]));
    this.keys = disk.map((k) => {
      const local = mine.get(k.id);
      if (!local) return k; // added by another process
      // Ours is the live rotation state — unless another process reset this key
      // after we last touched it, in which case the reset is what's newer.
      return k.resetAt > local.resetAt ? k : withRuntime(k, local);
    });
    return this;
  }

  /**
   * Write after a deliberate membership change (add/remove/reset): this
   * process's key list wins. Rotation state written by a running proxy since
   * we loaded is preserved, except for ids in `ownRuntimeIds` — those we are
   * deliberately changing ourselves (a reset).
   */
  save(ownRuntimeIds = []) {
    if (!this.persist) return;
    const disk = this._readDisk();
    if (disk) {
      const keep = new Set(ownRuntimeIds);
      const onDisk = new Map(disk.map((k) => [k.id, k]));
      this.keys = this.keys.map((k) => (onDisk.has(k.id) && !keep.has(k.id) ? withRuntime(k, onDisk.get(k.id)) : k));
    }
    this._write(this.keys);
  }

  /**
   * Write a rotation-state update (stats/cooldowns). Membership on disk wins,
   * so a concurrent `oswap add` / `oswap remove` is never clobbered by the
   * long-running proxy flushing its in-memory list.
   */
  saveRuntime() {
    if (!this.persist) return;
    this.refresh();
    this._write(this.keys);
  }

  saveDebounced(ms = 500) {
    if (!this.persist) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveRuntime(), ms);
    this._saveTimer.unref?.();
  }

  add(key, label = "") {
    this.refresh();
    const existing = this.keys.find((k) => k.key === key);
    if (existing) return { record: existing, added: false };
    const record = {
      id: newId(),
      key,
      label,
      addedAt: now(),
      cooldownUntil: 0,
      disabled: false,
      resetAt: 0,
      stats: { requests: 0, rateLimits: 0, failures: 0, lastUsedAt: 0, lastError: null },
    };
    this.keys.push(record);
    this.save();
    return { record, added: true };
  }

  remove(idOrPrefix) {
    this.refresh();
    const i = this.keys.findIndex((k) => k.id === idOrPrefix || k.id.startsWith(idOrPrefix));
    if (i === -1) return null;
    const [removed] = this.keys.splice(i, 1);
    this.save();
    return removed;
  }

  usable(t = now()) {
    return this.keys.filter((k) => !k.disabled && k.cooldownUntil <= t);
  }

  /**
   * Next key in round-robin order that is neither disabled nor cooling down.
   * Returns null when every key is unavailable; caller checks nextAvailableAt().
   */
  acquire(t = now()) {
    this.refresh();
    const ok = this.usable(t);
    if (ok.length === 0) return null;
    const picked = ok[this.rr % ok.length];
    this.rr = (this.rr + 1) % Math.max(ok.length, 1);
    picked.stats.requests += 1;
    picked.stats.lastUsedAt = t;
    this.saveDebounced();
    return picked;
  }

  /** Earliest timestamp when any key becomes usable again (0 if one is usable now, Infinity if none exist/all disabled). */
  nextAvailableAt(t = now()) {
    if (this.usable(t).length > 0) return 0;
    const candidates = this.keys.filter((k) => !k.disabled).map((k) => k.cooldownUntil);
    if (candidates.length === 0) return Infinity;
    return Math.min(...candidates);
  }

  reportSuccess(id) {
    const k = this.keys.find((x) => x.id === id);
    if (!k) return;
    k.cooldownUntil = 0;
    k.stats.lastError = null;
    this.saveDebounced();
  }

  reportRateLimit(id, retryAfterMs) {
    const k = this.keys.find((x) => x.id === id);
    if (!k) return;
    const requested = retryAfterMs != null && retryAfterMs > 0 ? retryAfterMs : this.rateLimitCooldownMs;
    const wait = Math.min(requested, this.maxRateLimitCooldownMs);
    k.cooldownUntil = now() + wait;
    k.stats.rateLimits += 1;
    k.stats.lastError = "429 rate limit";
    this.saveRuntime();
  }

  reportAuthFail(id, message = "401/403 auth failure") {
    const k = this.keys.find((x) => x.id === id);
    if (!k) return;
    k.cooldownUntil = now() + this.authFailCooldownMs;
    k.stats.failures += 1;
    k.stats.lastError = message;
    this.saveRuntime();
  }

  reportError(id, message = "upstream/network error") {
    const k = this.keys.find((x) => x.id === id);
    if (!k) return;
    k.cooldownUntil = now() + this.errorCooldownMs;
    k.stats.failures += 1;
    k.stats.lastError = message;
    this.saveDebounced();
  }

  reset(idOrPrefix) {
    this.refresh();
    const k = this.keys.find((x) => x.id === idOrPrefix || x.id.startsWith(idOrPrefix));
    if (!k) return null;
    k.cooldownUntil = 0;
    k.disabled = false;
    k.stats.lastError = null;
    k.resetAt = now(); // marks our cleared cooldown as newer than whatever a proxy last wrote
    this.save([k.id]);
    return k;
  }

  status(t = now()) {
    this.refresh();
    return this.keys.map((k) => ({
      id: k.id,
      label: k.label,
      key: maskKey(k.key),
      state: k.disabled ? "disabled" : k.cooldownUntil > t ? `cooling ${Math.ceil((k.cooldownUntil - t) / 1000)}s` : "ready",
      ...k.stats,
    }));
  }
}
