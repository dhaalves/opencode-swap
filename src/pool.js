import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
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

const now = () => Date.now();

function newId() {
  return randomBytes(4).toString("hex");
}

export function maskKey(key) {
  if (typeof key !== "string" || key.length < 8) return "****";
  return `${key.slice(0, 5)}...${key.slice(-4)}`;
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
    persist = true,
  } = {}) {
    this.path = path;
    this.rateLimitCooldownMs = rateLimitCooldownMs;
    this.errorCooldownMs = errorCooldownMs;
    this.authFailCooldownMs = authFailCooldownMs;
    this.persist = persist;
    this.keys = [];
    this.rr = 0; // round-robin cursor
    this._saveTimer = null;
  }

  load() {
    if (!existsSync(this.path)) return this;
    const raw = JSON.parse(readFileSync(this.path, "utf8"));
    this.keys = (raw.keys ?? []).map((k) => ({
      id: k.id ?? newId(),
      key: k.key,
      label: k.label ?? "",
      addedAt: k.addedAt ?? now(),
      cooldownUntil: k.cooldownUntil ?? 0,
      disabled: k.disabled ?? false,
      stats: {
        requests: k.stats?.requests ?? 0,
        rateLimits: k.stats?.rateLimits ?? 0,
        failures: k.stats?.failures ?? 0,
        lastUsedAt: k.stats?.lastUsedAt ?? 0,
        lastError: k.stats?.lastError ?? null,
      },
    }));
    return this;
  }

  save() {
    if (!this.persist) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, keys: this.keys }, null, 2));
    renameSync(tmp, this.path);
  }

  saveDebounced(ms = 500) {
    if (!this.persist) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), ms);
    this._saveTimer.unref?.();
  }

  add(key, label = "") {
    const existing = this.keys.find((k) => k.key === key);
    if (existing) return { record: existing, added: false };
    const record = {
      id: newId(),
      key,
      label,
      addedAt: now(),
      cooldownUntil: 0,
      disabled: false,
      stats: { requests: 0, rateLimits: 0, failures: 0, lastUsedAt: 0, lastError: null },
    };
    this.keys.push(record);
    this.save();
    return { record, added: true };
  }

  remove(idOrPrefix) {
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
    const wait = retryAfterMs != null && retryAfterMs > 0 ? retryAfterMs : this.rateLimitCooldownMs;
    k.cooldownUntil = now() + wait;
    k.stats.rateLimits += 1;
    k.stats.lastError = "429 rate limit";
    this.save();
  }

  reportAuthFail(id, message = "401/403 auth failure") {
    const k = this.keys.find((x) => x.id === id);
    if (!k) return;
    k.cooldownUntil = now() + this.authFailCooldownMs;
    k.stats.failures += 1;
    k.stats.lastError = message;
    this.save();
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
    const k = this.keys.find((x) => x.id === idOrPrefix || x.id.startsWith(idOrPrefix));
    if (!k) return null;
    k.cooldownUntil = 0;
    k.disabled = false;
    k.stats.lastError = null;
    this.save();
    return k;
  }

  status(t = now()) {
    return this.keys.map((k) => ({
      id: k.id,
      label: k.label,
      key: maskKey(k.key),
      state: k.disabled ? "disabled" : k.cooldownUntil > t ? `cooling ${Math.ceil((k.cooldownUntil - t) / 1000)}s` : "ready",
      ...k.stats,
    }));
  }
}
