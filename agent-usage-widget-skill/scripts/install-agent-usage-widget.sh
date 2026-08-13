#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
unset CLAUDE_CODE_OAUTH_TOKEN

INSTALL_DIR="${AGENT_USAGE_WIDGET_DIR:-$HOME/.agent-usage-widget}"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.agentusage.widget.plist"
APP_LABEL="com.agentusage.widget"

mkdir -p "$INSTALL_DIR"/{App,Sources/AgentUsageWidget,scripts,build,.cache}
chmod 700 "$INSTALL_DIR" "$INSTALL_DIR/.cache"

cat > "$INSTALL_DIR/scripts/usage-summary.js" <<'NODE'
#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const HOME = process.env.HOME;
const INSTALL_DIR = process.env.AGENT_USAGE_WIDGET_DIR || path.join(HOME, ".agent-usage-widget");
const CLAUDE_ROOT = path.join(HOME, ".claude", "projects");
const CODEX_ROOT = path.join(HOME, ".codex", "sessions");
const CLAUDE_COOKIE_DB = path.join(HOME, "Library", "Application Support", "Claude", "Cookies");
const CODEX_AUTH = path.join(HOME, ".codex", "auth.json");
const CACHE_DIR = path.join(INSTALL_DIR, ".cache");
const CLAUDE_USAGE_CACHE = path.join(CACHE_DIR, "claude-usage-percentages.json");
const CODEX_USAGE_CACHE = path.join(CACHE_DIR, "codex-usage-percentages.json");
const FORCE_CLAUDE_REFRESH = process.argv.includes("--refresh-claude") || process.argv.includes("--refresh");
const QUOTA_ONLY = process.argv.includes("--quota-only");

// Affects --text rendering only. The JSON output stays language-neutral (raw percentages
// and epoch seconds) so the widget can localize it itself without re-running this script
// on every language change.
const LANG = (() => {
  const flag = process.argv.find((arg) => arg.startsWith("--lang="));
  const requested = (flag ? flag.slice("--lang=".length) : process.env.AGENT_USAGE_WIDGET_LANG || "")
    .toLowerCase();
  if (requested.startsWith("en")) return "en";
  if (requested.startsWith("zh")) return "zh";
  return "zh";
})();

const TEXT = {
  zh: {
    locale: "zh-TW",
    codexTitle: "Codex 可用額度",
    claudeTitle: "Claude 可用額度",
    fiveHour: "5 小時",
    oneWeek: "1 週",
    noLimitOnPlan: "此方案無此限制",
    already100: "已是 100%",
    recovery: (when) => `回復 100%：${when}`,
    claudeReadFailed: (error) => `Claude 讀取失敗：${error}`,
    dataAge: (age) => `（${age}資料）`,
    minutesAgo: (n) => `${n} 分鐘前`,
    hoursAgo: (n) => `${n} 小時前`,
    daysAgo: (n) => `${n} 天前`,
  },
  en: {
    locale: "en-US",
    codexTitle: "Codex quota left",
    claudeTitle: "Claude quota left",
    fiveHour: "5 hours",
    oneWeek: "1 week",
    noLimitOnPlan: "no such limit on this plan",
    already100: "already 100%",
    recovery: (when) => `back to 100%: ${when}`,
    claudeReadFailed: (error) => `Claude read failed: ${error}`,
    dataAge: (age) => ` (data from ${age})`,
    minutesAgo: (n) => `${n} min ago`,
    hoursAgo: (n) => `${n} h ago`,
    daysAgo: (n) => `${n} d ago`,
  },
};

const T = TEXT[LANG];

const now = new Date();
const nowMs = now.getTime();
const hourStartMs = nowMs - 60 * 60 * 1000;
const weekStartMs = startOfLocalWeek(now).getTime();
// Codex windows are rolling (5h / 7-day). Scan session files by an 8-day lookback
// so the newest rate-limit snapshot is found even after an idle gap or early in the
// local week, instead of being dropped by the narrower local-week-start filter.
const CODEX_SCAN_SINCE_MS = nowMs - 8 * 24 * 60 * 60 * 1000;

function startOfLocalWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

function emptyBucket() {
  return { total: 0, input: 0, cacheCreation: 0, cacheRead: 0, output: 0, reasoning: 0, events: 0 };
}

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function addUsage(bucket, usage) {
  const input = number(usage.input_tokens);
  const cacheCreation = number(usage.cache_creation_input_tokens);
  const cacheRead = number(usage.cache_read_input_tokens ?? usage.cached_input_tokens);
  const output = number(usage.output_tokens);
  const reasoning = number(usage.reasoning_output_tokens);
  bucket.total += number(usage.total_tokens) || input + cacheCreation + cacheRead + output;
  bucket.input += input;
  bucket.cacheCreation += cacheCreation;
  bucket.cacheRead += cacheRead;
  bucket.output += output;
  bucket.reasoning += reasoning;
  bucket.events += 1;
}

async function walkJsonlFiles(root, sinceMs) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = await fs.promises.stat(full);
          if (stat.mtimeMs + 5 * 60 * 1000 >= sinceMs) files.push(full);
        } catch {}
      }
    }
  }
  await walk(root);
  return files;
}

async function readJsonLines(file, onObject) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    try {
      await onObject(JSON.parse(line), file);
    } catch {}
  }
}

async function summarizeClaude() {
  const hour = emptyBucket();
  const week = emptyBucket();
  const [files, official] = await Promise.all([
    QUOTA_ONLY ? Promise.resolve([]) : walkJsonlFiles(CLAUDE_ROOT, weekStartMs),
    fetchClaudeOfficialUsage({ force: FORCE_CLAUDE_REFRESH }),
  ]);
  const seen = new Set();

  for (const file of files) {
    await readJsonLines(file, async (row) => {
      const usage = row?.message?.usage;
      const timestamp = Date.parse(row?.timestamp || "");
      if (!usage || !Number.isFinite(timestamp) || timestamp < weekStartMs) return;
      const dedupeKey = row?.message?.id ? `msg:${row.message.id}` : `${row.timestamp}:${JSON.stringify(usage)}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      addUsage(week, usage);
      if (timestamp >= hourStartMs) addUsage(hour, usage);
    });
  }

  return { hour, week, official, filesScanned: files.length, dedupedEvents: seen.size };
}

async function fetchClaudeOfficialUsage({ force = false } = {}) {
  if (!force) {
    const cached = readClaudeUsageCache({ maxAgeMs: Infinity });
    if (cached) return { ...cached, cache: "cached" };
    return { available: false, error: "manual_refresh_required" };
  }

  try {
    const session = readClaudeDesktopSession();
    if (!session.orgId || !session.cookieHeader) return { available: false, error: "missing_session" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(`https://claude.ai/api/organizations/${encodeURIComponent(session.orgId)}/usage`, {
        signal: controller.signal,
        headers: {
          accept: "application/json, text/plain, */*",
          cookie: session.cookieHeader,
          referer: "https://claude.ai/settings/usage",
          origin: "https://claude.ai",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AgentUsageWidget",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return { available: false, error: `http_${response.status}` };

    const data = await response.json();
    // Prefer data.limits: it is what the Claude settings UI renders, so the widget
    // cannot disagree with the app. The flat seven_day_* fields are legacy and the
    // per-model one is dead weight — on a Max plan whose scoped weekly window is
    // Fable, seven_day_sonnet is null while limits carries the real Fable entry.
    const fromLimits = normalizeClaudeLimitsArray(data.limits);
    const official = {
      available: true,
      fetchedAt: new Date().toISOString(),
      fiveHour: fromLimits?.fiveHour ?? normalizeClaudeLimit(data.five_hour),
      weekAll: fromLimits?.weekAll ?? normalizeClaudeLimit(data.seven_day),
      weekScoped: fromLimits?.weekScoped ?? {
        ...normalizeClaudeLimit(pickClaudeWindow(data, "seven_day_sonnet", "sonnet")),
        label: "Sonnet",
      },
    };
    writeClaudeUsageCache(official);
    return { ...official, cache: "live" };
  } catch (error) {
    // Surface WHY the live fetch failed. A bare catch here made every failure —
    // wrong node build, no network, keychain denied — look identical to "no data",
    // which is unusably hard to debug. Only the error message is kept, never the
    // request, cookies, or org id.
    const reason = String(error?.message || error).slice(0, 120);
    const cached = readClaudeUsageCache({ maxAgeMs: Infinity });
    if (cached) return { ...cached, cache: "stale", error: `live_unavailable:${reason}` };
    return { available: false, error: `unavailable:${reason}` };
  }
}

// Live Codex quota. The local session logs only get written while the Codex CLI runs — the
// desktop app keeps its rate limits in memory — so log-derived numbers can be a day stale
// and disagree with the app. This is the same endpoint the app itself reads.
async function fetchCodexOfficialUsage({ force = false } = {}) {
  if (!force) {
    const cached = readCodexUsageCache();
    if (cached) return { ...cached, cache: "cached" };
    return { available: false, error: "manual_refresh_required" };
  }

  try {
    const session = readCodexSession();
    if (!session.accessToken || !session.accountId) return { available: false, error: "missing_session" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch("https://chatgpt.com/backend-api/codex/usage", {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${session.accessToken}`,
          "chatgpt-account-id": session.accountId,
          originator: "codex_cli_rs",
          "user-agent": "AgentUsageWidget",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return { available: false, error: `http_${response.status}` };

    const official = normalizeCodexUsage(await response.json());
    if (official.available) writeCodexUsageCache(official);
    return { ...official, cache: "live" };
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 120);
    const cached = readCodexUsageCache();
    if (cached) return { ...cached, cache: "stale", error: `live_unavailable:${reason}` };
    return { available: false, error: `unavailable:${reason}` };
  }
}

// The OAuth material the Codex CLI itself uses. Held in memory only: never cached, logged,
// or written back to disk — only the resulting percentages are cached.
function readCodexSession() {
  try {
    const auth = JSON.parse(fs.readFileSync(CODEX_AUTH, "utf8"));
    return {
      accessToken: auth?.tokens?.access_token || "",
      accountId: auth?.tokens?.account_id || "",
    };
  } catch {
    return { accessToken: "", accountId: "" };
  }
}

// Windows are NOT in fixed slots: on a plan with no 5-hour limit, primary_window IS the
// weekly one and secondary_window is null. Classify by limit_window_seconds, exactly as
// the log parser classifies by window_minutes.
function normalizeCodexUsage(data) {
  const windows = [data?.rate_limit?.primary_window, data?.rate_limit?.secondary_window];
  let fiveHour = null;
  let week = null;
  for (const window of windows) {
    if (!window || !Number.isFinite(window.used_percent)) continue;
    const seconds = Number(window.limit_window_seconds);
    if (!Number.isFinite(seconds)) continue;
    const entry = { usedPercent: window.used_percent, resetsAt: finiteOrNull(window.reset_at) };
    if (seconds <= 6 * 3600) fiveHour = entry;
    else if (seconds >= 3 * 86400) week = entry;
  }
  return {
    available: Boolean(fiveHour || week),
    fetchedAt: new Date().toISOString(),
    fiveHour,
    week,
  };
}

function readCodexUsageCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(CODEX_USAGE_CACHE, "utf8"));
    if (!cached || cached.available !== true) return null;
    return {
      available: true,
      fetchedAt: typeof cached.fetchedAt === "string" ? cached.fetchedAt : null,
      fiveHour: cached.fiveHour || null,
      week: cached.week || null,
    };
  } catch {
    return null;
  }
}

function writeCodexUsageCache(official) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${CODEX_USAGE_CACHE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(official, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, CODEX_USAGE_CACHE);
  } catch {}
}

function readClaudeDesktopSession() {
  if (!fs.existsSync(CLAUDE_COOKIE_DB)) return { orgId: "", cookieHeader: "" };
  const password = execFileSync("security", ["find-generic-password", "-s", "Claude Safe Storage", "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!password) return { orgId: "", cookieHeader: "" };

  const query =
    "select host_key||char(9)||name||char(9)||value||char(9)||hex(encrypted_value) " +
    "from cookies where host_key in ('.claude.ai','claude.ai') order by host_key,name;";
  const rows = execFileSync("sqlite3", [CLAUDE_COOKIE_DB, query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim().split("\n").filter(Boolean);

  const pairs = [];
  let orgId = "";
  for (const line of rows) {
    const [host, name, plainValue, encryptedHex] = line.split("\t");
    let value = plainValue || "";
    if (!value && encryptedHex) value = decryptChromiumCookie(host, encryptedHex, password);
    if (!isSafeCookieValue(value)) continue;
    pairs.push(`${name}=${value}`);
    if (host === ".claude.ai" && name === "lastActiveOrg") orgId = value;
  }
  return { orgId, cookieHeader: pairs.join("; ") };
}

function decryptChromiumCookie(host, encryptedHex, password) {
  const encrypted = Buffer.from(encryptedHex, "hex");
  if (!encrypted.subarray(0, 3).equals(Buffer.from("v10"))) return "";
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  let decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  const digest = crypto.createHash("sha256").update(host).digest();
  if (decrypted.length > digest.length && decrypted.subarray(0, digest.length).equals(digest)) {
    decrypted = decrypted.subarray(digest.length);
  }
  return decrypted.toString("utf8");
}

function isSafeCookieValue(value) {
  return typeof value === "string" && value.length > 0 && !/[\r\n;]/.test(value);
}

function normalizeClaudeLimit(limit) {
  if (!limit || typeof limit !== "object") return { usedPercent: null, resetsAt: null };
  let usedPercent = finiteOrNull(limit.utilization ?? limit.used_percentage ?? limit.usedPercent);
  let resetsAt = parseReset(limit.resets_at ?? limit.resetsAt);
  // A reset already in the past means the window is back to full: report 100%
  // available (used 0%) rather than the stale pre-reset value.
  if (isWindowExpired(resetsAt)) {
    usedPercent = 0;
    resetsAt = null;
  }
  return { usedPercent, resetsAt };
}

// The usage API's `limits` array is the source the Claude UI itself renders: one entry
// per window, each tagged by `kind`, with the scoped weekly window naming its model in
// `scope.model.display_name` (e.g. "Fable"). Returns null when absent so the caller can
// fall back to the legacy flat fields.
function normalizeClaudeLimitsArray(limits) {
  if (!Array.isArray(limits) || limits.length === 0) return null;
  const pick = (kind) => limits.find((entry) => entry && entry.kind === kind) || null;
  const toLimit = (entry) => normalizeClaudeLimit(entry ? { utilization: entry.percent, resets_at: entry.resets_at } : null);
  const session = pick("session");
  const weeklyAll = pick("weekly_all");
  const scoped = pick("weekly_scoped");
  if (!session && !weeklyAll && !scoped) return null;
  return {
    fiveHour: toLimit(session),
    weekAll: toLimit(weeklyAll),
    weekScoped: { ...toLimit(scoped), label: scoped?.scope?.model?.display_name || null },
  };
}

function isWindowExpired(resetsAtSeconds) {
  return Number.isFinite(resetsAtSeconds) && resetsAtSeconds * 1000 <= nowMs;
}

function pickClaudeWindow(data, exactKey, keyword) {
  if (!data || typeof data !== "object") return null;
  if (data[exactKey] && typeof data[exactKey] === "object") return data[exactKey];
  for (const key of Object.keys(data)) {
    if (key.toLowerCase().includes(keyword) && data[key] && typeof data[key] === "object") {
      return data[key];
    }
  }
  return null;
}

// A reset already in the past means the window rolled over, so the pre-reset percentage
// is not current usage. If the reading is younger than the window it rolled out of,
// nothing can have been spent in the new window yet, so 100% available is a fact. If the
// reading is older than that, usage since then is simply unobserved — the Codex desktop
// app keeps its rate limits in memory and only the Codex CLI writes these snapshots — so
// report unknown instead of inventing a full quota.
function applyWindowExpiry(window) {
  if (!window || typeof window !== "object") return window;
  if (!isWindowExpired(window.resets_at)) return window;
  const observedAtMs = Number.isFinite(window.observed_at) ? window.observed_at * 1000 : null;
  const windowMs = Number.isFinite(window.window_minutes) ? window.window_minutes * 60 * 1000 : 0;
  const readingCoversCurrentWindow = observedAtMs !== null && nowMs - observedAtMs <= windowMs;
  return { ...window, used_percent: readingCoversCurrentWindow ? 0 : null, resets_at: null };
}

function codexNewestObservedAtMs(rateLimits) {
  const stamps = [rateLimits?.primary?.observed_at, rateLimits?.secondary?.observed_at]
    .filter((value) => Number.isFinite(value))
    .map((value) => value * 1000);
  return stamps.length ? Math.max(...stamps) : null;
}

function formatAge(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return T.minutesAgo(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return T.hoursAgo(hours);
  return T.daysAgo(Math.round(hours / 24));
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function parseReset(value) {
  if (Number.isFinite(value)) return value > 10_000_000_000 ? value / 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }
  if (value && typeof value === "object") {
    for (const key of ["seconds", "_seconds", "epoch_seconds", "epochSeconds"]) {
      if (Number.isFinite(value[key])) return value[key];
    }
  }
  return null;
}

function readClaudeUsageCache({ maxAgeMs }) {
  try {
    const stat = fs.statSync(CLAUDE_USAGE_CACHE);
    if (nowMs - stat.mtimeMs > maxAgeMs) return null;
    const cached = JSON.parse(fs.readFileSync(CLAUDE_USAGE_CACHE, "utf8"));
    if (!cached || cached.available !== true) return null;
    // weekSonnet is the pre-`limits` cache shape; keep reading it so an existing cache
    // written by an older install still renders instead of showing n/a.
    const scoped = cached.weekScoped || cached.weekSonnet || null;
    return {
      available: true,
      fetchedAt: typeof cached.fetchedAt === "string" ? cached.fetchedAt : null,
      fiveHour: normalizeClaudeLimit(cached.fiveHour),
      weekAll: normalizeClaudeLimit(cached.weekAll),
      weekScoped: { ...normalizeClaudeLimit(scoped), label: scoped?.label || (cached.weekSonnet ? "Sonnet" : null) },
    };
  } catch {
    return null;
  }
}

function writeClaudeUsageCache(official) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${CLAUDE_USAGE_CACHE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(official, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, CLAUDE_USAGE_CACHE);
  } catch {}
}

async function summarizeCodex() {
  const hour = emptyBucket();
  const week = emptyBucket();
  // Live quota first; the log scan below is the fallback for when there is no usable
  // Codex login (token missing or expired).
  const official = await fetchCodexOfficialUsage({ force: FORCE_CLAUDE_REFRESH });
  let files = await walkJsonlFiles(CODEX_ROOT, QUOTA_ONLY ? nowMs - 12 * 60 * 60 * 1000 : CODEX_SCAN_SINCE_MS);
  if (QUOTA_ONLY && files.length === 0) files = await walkJsonlFiles(CODEX_ROOT, CODEX_SCAN_SINCE_MS);
  // Codex writes rate-limit snapshots in inconsistent shapes: the 5-hour and weekly
  // windows are NOT always in fixed primary/secondary slots, some records carry only
  // one window, and multiple auth contexts interleave. Classify every window by its
  // window_minutes and collect 5-hour and weekly readings independently, then lock
  // each onto the main account (most-used recent reading). Immune to slot swaps,
  // partial records, and account flip-flop.
  const fiveHourReadings = [];
  const weeklyReadings = [];

  for (const file of files) {
    await readJsonLines(file, async (row) => {
      if (row?.payload?.type !== "token_count") return;
      const timestamp = Date.parse(row.timestamp || "");
      if (!Number.isFinite(timestamp)) return;
      if (row.payload.rate_limits) {
        collectCodexWindows(row.payload.rate_limits, timestamp, fiveHourReadings, weeklyReadings);
      }
    });
  }

  const five = pickCurrentReading(fiveHourReadings);
  const weekly = pickCurrentReading(weeklyReadings);
  return {
    hour,
    week,
    latestAt: Math.max(five?.ts || 0, weekly?.ts || 0),
    official,
    rateLimits: buildCodexRateLimits(five, weekly, official),
    fiveHourReadings: fiveHourReadings.length,
    weeklyReadings: weeklyReadings.length,
    filesScanned: files.length,
  };
}

// Classify a rate-limit window by window_minutes: ~5 hours (<= 360) vs weekly
// (>= 3 days). Returns null without a usable percentage so partial/garbled records
// contribute nothing rather than corrupting a slot.
function classifyCodexWindow(window) {
  if (!window || typeof window !== "object") return null;
  const used = window.used_percent;
  if (!Number.isFinite(used)) return null;
  const wm = Number(window.window_minutes);
  if (!Number.isFinite(wm)) return null;
  if (wm <= 360) return { kind: "five", used_percent: used, resets_at: window.resets_at };
  if (wm >= 4320) return { kind: "week", used_percent: used, resets_at: window.resets_at };
  return null;
}

// Codex does not reliably keep 5h in primary and weekly in secondary, so read every
// slot and route by classification instead of position.
function collectCodexWindows(rateLimits, ts, fiveHourReadings, weeklyReadings) {
  for (const slot of [rateLimits?.primary, rateLimits?.secondary]) {
    const c = classifyCodexWindow(slot);
    if (!c) continue;
    const reading = { ts, used_percent: c.used_percent, resets_at: c.resets_at };
    (c.kind === "five" ? fiveHourReadings : weeklyReadings).push(reading);
  }
}

// Report the account's CURRENT window while resisting multi-account flip-flop. The
// local logs interleave several rate-limit streams (main account plus stale or
// auxiliary ones). Anchor on the newest reading and look only at readings written in
// the ~90s around it — the actively-used account writes every few seconds, so a
// stream that stopped writing minutes ago (a stale/previous window) falls out of
// this tight cluster. Within the cluster take the most-used, so a genuinely
// concurrent auxiliary credential's momentary 0% cannot mask the real high reading.
function pickCurrentReading(readings) {
  if (!readings.length) return null;
  const ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000;
  const CLUSTER_MS = 90 * 1000;
  const recent = readings.filter((r) => nowMs - r.ts <= ACTIVE_WINDOW_MS);
  const pool = recent.length ? recent : readings;
  const newestTs = Math.max(...pool.map((r) => r.ts));
  const cluster = pool.filter((r) => newestTs - r.ts <= CLUSTER_MS);
  cluster.sort((a, b) => b.used_percent - a.used_percent || b.ts - a.ts);
  return cluster[0];
}

function buildCodexRateLimits(five, weekly, official) {
  // When the live endpoint answered, trust it completely and do NOT fall back to the logs
  // per-row: it is authoritative about which windows even exist. A plan with no 5-hour
  // limit reports that window as absent, and filling that row from a month-old log
  // reading would resurrect a number that no longer means anything.
  if (official?.available) {
    const observedAt = official.fetchedAt ? Math.round(Date.parse(official.fetchedAt) / 1000) : null;
    const fromOfficial = (limit, windowMinutes) => {
      if (!limit || !Number.isFinite(limit.usedPercent)) return null;
      return applyWindowExpiry({
        used_percent: limit.usedPercent,
        resets_at: finiteOrNull(limit.resetsAt),
        window_minutes: windowMinutes,
        observed_at: Number.isFinite(observedAt) ? observedAt : null,
      });
    };
    const primary = fromOfficial(official.fiveHour, 300);
    const secondary = fromOfficial(official.week, 10080);
    if (primary || secondary) return { primary, secondary };
  }

  const toWindow = (reading, windowMinutes) => {
    if (!reading) return null;
    return applyWindowExpiry({
      used_percent: reading.used_percent,
      resets_at: reading.resets_at,
      window_minutes: windowMinutes,
      // When this snapshot was written, so consumers can say how old the number is
      // instead of presenting a day-old reading as the current one.
      observed_at: Number.isFinite(reading.ts) ? Math.round(reading.ts / 1000) : null,
    });
  };
  const primary = toWindow(five, 300);
  const secondary = toWindow(weekly, 10080);
  if (!primary && !secondary) return null;
  return { primary, secondary };
}

function remainingPercent(usedPercent) {
  if (!Number.isFinite(usedPercent)) return null;
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "n/a";
}

function formatReset(epochSeconds, compact = false) {
  if (!epochSeconds) return "n/a";
  const date = new Date(epochSeconds * 1000);
  if (compact) return date.toLocaleString(T.locale, { month: "2-digit", day: "2-digit" });
  const sameDay = date.toDateString() === new Date().toDateString();
  // hourCycle rather than hour12: with hour12 present ICU ignores hourCycle and
  // renders midnight as 24:00 in zh-TW.
  return date.toLocaleString(T.locale, sameDay
    ? { hour: "numeric", minute: "2-digit", hourCycle: "h23" }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function recoveryText(epochSeconds, remainingPercent, compact = false) {
  if (Number.isFinite(remainingPercent) && Math.round(remainingPercent) >= 100) return T.already100;
  if (!Number.isFinite(epochSeconds)) return T.recovery("n/a");
  return T.recovery(formatReset(epochSeconds, compact));
}

function buildText(summary) {
  const c = summary.claude;
  const x = summary.codex;
  const codexPrimaryRemaining = remainingPercent(x.rateLimits?.primary?.used_percent);
  const codexSecondaryRemaining = remainingPercent(x.rateLimits?.secondary?.used_percent);
  const claudeFiveRemaining = remainingPercent(c.official?.fiveHour?.usedPercent);
  const claudeWeekRemaining = remainingPercent(c.official?.weekAll?.usedPercent);
  const claudeScopedRemaining = remainingPercent(c.official?.weekScoped?.usedPercent);
  const scopedLabel = c.official?.weekScoped?.label || "Sonnet";
  // Codex snapshots only appear when the Codex CLI runs, so they can be hours old while
  // the desktop app shows something quite different. Label the age instead of implying
  // the number is live.
  const codexObservedAtMs = codexNewestObservedAtMs(x.rateLimits);
  const codexAge = codexObservedAtMs && nowMs - codexObservedAtMs > 15 * 60 * 1000
    ? T.dataAge(formatAge(nowMs - codexObservedAtMs))
    : "";
  // "no such window on this plan" is a different fact from "could not read it", and the
  // live endpoint can tell them apart: it reports the absent window explicitly.
  const codexNoFiveHour = x.official?.available === true && !x.official.fiveHour;
  const lines = [
    `${T.codexTitle}${codexAge}`,
    codexNoFiveHour
      ? `${T.fiveHour} ${T.noLimitOnPlan}`
      : `${T.fiveHour} ${formatPercent(codexPrimaryRemaining)} ${recoveryText(x.rateLimits?.primary?.resets_at, codexPrimaryRemaining)}`,
    `${T.oneWeek} ${formatPercent(codexSecondaryRemaining)} ${recoveryText(x.rateLimits?.secondary?.resets_at, codexSecondaryRemaining, true)}`,
    T.claudeTitle,
    `${T.fiveHour} ${formatPercent(claudeFiveRemaining)} ${recoveryText(c.official?.fiveHour?.resetsAt, claudeFiveRemaining)}`,
    `${T.oneWeek} ${formatPercent(claudeWeekRemaining)} ${recoveryText(c.official?.weekAll?.resetsAt, claudeWeekRemaining, true)}`,
    `${scopedLabel} ${formatPercent(claudeScopedRemaining)} ${recoveryText(c.official?.weekScoped?.resetsAt, claudeScopedRemaining, true)}`,
  ];
  // Without this, a blocked/unauthenticated Claude fetch is indistinguishable from
  // an idle account: every row just reads "n/a" with no hint of where to look.
  if (c.official?.available !== true && c.official?.error) {
    lines.push(T.claudeReadFailed(c.official.error));
  }
  return lines.join("\n");
}

async function main() {
  const [claude, codex] = await Promise.all([summarizeClaude(), summarizeCodex()]);
  const summary = {
    generatedAt: new Date().toISOString(),
    windows: {
      hourStart: new Date(hourStartMs).toISOString(),
      weekStart: new Date(weekStartMs).toISOString(),
    },
    claude,
    codex,
  };

  if (process.argv.includes("--text")) {
    process.stdout.write(`${buildText(summary)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
NODE

chmod 700 "$INSTALL_DIR/scripts/usage-summary.js"

# Resolve ONE absolute node binary to bake into the app. Two reasons this cannot be
# left to `env node` at runtime:
#   1. The widget is launched by launchd, which supplies a bare PATH
#      (/usr/bin:/bin:/usr/sbin:/sbin) containing no node at all — so after a reboot
#      every row reads 更新失敗.
#   2. The claude.ai usage endpoint rejects some node builds outright: node 25 gets
#      HTTP 403 where node 20 and 22 get 200 with byte-identical cookies and headers.
# So prefer a candidate that can actually complete a live Claude usage fetch, and
# prefer stable absolute paths over nvm ones (those vanish on the next node upgrade).
NODE_CANDIDATES=()
add_node_candidate() {
  local candidate="$1"
  [[ -n "$candidate" && -x "$candidate" ]] || return 0
  local existing
  for existing in ${NODE_CANDIDATES+"${NODE_CANDIDATES[@]}"}; do
    [[ "$existing" == "$candidate" ]] && return 0
  done
  NODE_CANDIDATES+=("$candidate")
}

add_node_candidate "${AGENT_USAGE_WIDGET_NODE:-}"
add_node_candidate /usr/local/bin/node
add_node_candidate /opt/homebrew/bin/node
while IFS= read -r nvm_node; do add_node_candidate "$nvm_node"; done < <(ls -t "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null || true)
add_node_candidate "$(command -v node 2>/dev/null || true)"

if [[ ${#NODE_CANDIDATES[@]} -eq 0 ]]; then
  echo "找不到可用的 node，請先安裝 Node.js 再重跑安裝。" >&2
  exit 1
fi

# Probes the real fetch path rather than guessing from version numbers, so a future
# node release that starts or stops being blocked needs no change here.
NODE_BIN=""
NODE_UNTESTED=0
for candidate in "${NODE_CANDIDATES[@]}"; do
  probe="$("$candidate" "$INSTALL_DIR/scripts/usage-summary.js" --quota-only --refresh-claude 2>/dev/null || true)"
  case "$probe" in
    *'"available": true'*) NODE_BIN="$candidate"; break ;;
    # No local Claude session to verify against (not signed in to Claude Desktop, or
    # Keychain access declined). Claude percentages are untestable either way, so any
    # working node is equally good — take it and stop probing.
    *missing_session*|*manual_refresh_required*) NODE_BIN="$candidate"; NODE_UNTESTED=1; break ;;
  esac
done

if [[ -z "$NODE_BIN" ]]; then
  # Every candidate was refused by the usage endpoint. Still install with a working
  # node so Codex percentages and the widget itself keep functioning.
  NODE_BIN="${NODE_CANDIDATES[0]}"
  NODE_UNTESTED=1
fi

# Record the choice so the skill's own scripts can reuse it instead of resolving `node`
# from PATH, where they would pick up a build the usage endpoint rejects.
printf '%s\n' "$NODE_BIN" > "$INSTALL_DIR/node-path"
chmod 600 "$INSTALL_DIR/node-path"

echo "Using node: $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null || echo unknown))"
if [[ "$NODE_UNTESTED" == "1" ]]; then
  echo "注意：安裝時未能完成一次 Claude 官方用量查詢，Claude 百分比可能顯示 n/a。"
  echo "      可執行 $INSTALL_DIR/scripts/usage-summary.js --quota-only --refresh-claude --text 看失敗原因。"
fi

cat > "$INSTALL_DIR/App/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.agentusage.widget</string>
  <key>CFBundleName</key>
  <string>AgentUsageWidget</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

# Same Swift source the packaged .app is built from: it resolves node and
# usage-summary.js at runtime, so nothing needs interpolating here.
cat > "$INSTALL_DIR/Sources/AgentUsageWidget/main.swift" <<'SWIFT'
import AppKit

struct UsageSummary: Decodable { let generatedAt: String; let claude: ClaudeSummary; let codex: CodexSummary }
struct ClaudeSummary: Decodable { let official: ClaudeOfficial? }
struct ClaudeOfficial: Decodable { let fiveHour: ClaudeLimit?; let weekAll: ClaudeLimit?; let weekScoped: ClaudeScopedLimit? }
struct ClaudeLimit: Decodable { let usedPercent: Double?; let resetsAt: Double? }
// The scoped weekly window names its own model, so the row label comes from the data
// rather than being hardcoded — it reads "Fable" or "Sonnet" depending on the account.
struct ClaudeScopedLimit: Decodable { let usedPercent: Double?; let resetsAt: Double?; let label: String? }
struct CodexSummary: Decodable { let rateLimits: RateLimits?; let official: CodexOfficial? }
// available with a nil window means the plan genuinely has no such limit — distinct from
// being unable to read it, which leaves available false.
struct CodexOfficial: Decodable { let available: Bool?; let fiveHour: CodexLimit?; let week: CodexLimit? }
struct CodexLimit: Decodable { let usedPercent: Double?; let resetsAt: Double? }
struct RateLimits: Decodable { let primary: RateLimitWindow?; let secondary: RateLimitWindow? }
struct RateLimitWindow: Decodable { let used_percent: Double?; let resets_at: Double?; let observed_at: Double? }

enum Language: String, CaseIterable {
    case auto = "auto"
    case zhHant = "zh-Hant"
    case english = "en"

    private static let preferenceKey = "language"

    static var preference: Language {
        get { Language(rawValue: UserDefaults.standard.string(forKey: preferenceKey) ?? "") ?? .auto }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: preferenceKey) }
    }

    // `auto` follows the system; the explicit cases resolve to themselves. Anything that
    // is not Chinese falls to English rather than to the project's own zh-first default,
    // because a Japanese or German system reading Chinese labels is worse than English.
    var resolved: Language {
        guard self == .auto else { return self }
        return (Locale.preferredLanguages.first ?? "en").hasPrefix("zh") ? .zhHant : .english
    }
}

// Every user-visible string in one place. Because Strings has no defaults, the compiler
// refuses a language that is missing a field — a translation cannot be left half-done.
struct Strings {
    let codexTitle: String
    let claudeTitle: String
    let remainingHeader: String
    let resetHeader: String
    let fiveHour: String
    let oneWeek: String
    // The plan has no such window at all, which is not the same as failing to read it.
    let noWindowOnPlan: String
    let updating: String
    let updateFailed: String
    let lastUpdated: (String) -> String
    let refreshTooltip: String
    let refreshNow: String
    let listSeparator: String
    let languageMenu: String
    let languageAuto: String
    let languageZhHant: String
    let languageEnglish: String
    let launchAtLogin: String
    let installSkill: String
    let installSkillDone: (String) -> String
    let installSkillFailed: String
    let openWebsite: String
    let quit: String
    // Passed through to usage-summary.js --lang so its --text output matches the widget.
    let scriptLang: String

    static let zhHant = Strings(
        codexTitle: "Codex 可用額度",
        claudeTitle: "Claude 可用額度",
        remainingHeader: "剩餘",
        resetHeader: "重置時間",
        fiveHour: "5 小時",
        oneWeek: "1 週",
        noWindowOnPlan: "無",
        updating: "更新中",
        updateFailed: "更新失敗",
        lastUpdated: { "上次 \($0)" },
        refreshTooltip: "重新抓取數據",
        refreshNow: "立即刷新",
        listSeparator: "、",
        languageMenu: "語言",
        languageAuto: "跟隨系統",
        languageZhHant: "繁體中文",
        languageEnglish: "English",
        launchAtLogin: "開機自動啟動",
        installSkill: "安裝 Skill 到 Claude Code / Codex",
        installSkillDone: { "Skill 已安裝到 \($0)" },
        installSkillFailed: "Skill 安裝失敗",
        openWebsite: "說明網站",
        quit: "結束",
        scriptLang: "zh"
    )

    static let english = Strings(
        codexTitle: "Codex quota left",
        claudeTitle: "Claude quota left",
        remainingHeader: "Remaining",
        resetHeader: "Resets",
        fiveHour: "5 hours",
        oneWeek: "1 week",
        noWindowOnPlan: "None",
        updating: "Updating",
        updateFailed: "Update failed",
        lastUpdated: { "Last \($0)" },
        refreshTooltip: "Fetch the latest numbers",
        refreshNow: "Refresh now",
        listSeparator: ", ",
        languageMenu: "Language",
        languageAuto: "Follow system",
        languageZhHant: "繁體中文",
        languageEnglish: "English",
        launchAtLogin: "Launch at login",
        installSkill: "Install skill for Claude Code / Codex",
        installSkillDone: { "Skill installed to \($0)" },
        installSkillFailed: "Skill install failed",
        openWebsite: "Help website",
        quit: "Quit",
        scriptLang: "en"
    )

    // Explicit lookup, so callers that need a language other than the active one (the layout
    // check measures both) never have to write the preference to read its strings.
    static func about(_ language: Language) -> Strings {
        language.resolved == .english ? .english : .zhHant
    }

    static var current: Strings { about(Language.preference) }
}

// One source of truth for the layout grid: every row is the same height and the same
// pitch apart, and both sections derive from the same paddings, so no gap can drift.
private enum Metrics {
    static let width: CGFloat = 340
    static let padding: CGFloat = 18
    static let topPadding: CGFloat = 14
    static let titleHeight: CGFloat = 18
    static let titleGap: CGFloat = 8
    static let sectionGap: CGFloat = 10
    static let rowHeight: CGFloat = 26
    static let rowPitch: CGFloat = 28

    // Section titles are the longest strings that vary by language ("Codex quota left" plus
    // a data-age suffix), so they get their own width instead of a literal at each use site.
    static let titleWidth: CGFloat = 160
    // Clamp for the status text, which is measured rather than fixed; past this it would
    // collide with the section title on its left.
    static let statusMaxWidth: CGFloat = 140
    static let labelWidth: CGFloat = 96
    static let percentX: CGFloat = 146
    static let percentWidth: CGFloat = 68
    static let resetX: CGFloat = 222
    static let resetWidth: CGFloat = 100

    // Column captions sit under the top title row and label both sections' columns at once.
    static let colHeaderHeight: CGFloat = 13
    static let colHeaderGap: CGFloat = 5
    static var colHeaderTop: CGFloat { topPadding + titleHeight + colHeaderGap }
    static var codexRowsTop: CGFloat { colHeaderTop + colHeaderHeight + colHeaderGap }
    static var dividerTop: CGFloat { codexRowsTop + rowPitch + rowHeight + sectionGap }
    static var claudeTitleTop: CGFloat { dividerTop + 1 + sectionGap }
    static var claudeRowsTop: CGFloat { claudeTitleTop + titleHeight + titleGap }
    static var height: CGFloat { claudeRowsTop + rowPitch * 2 + rowHeight + topPadding }

    // AppKit's origin is bottom-left; the grid above is written top-down.
    static func flip(_ top: CGFloat, _ height: CGFloat) -> CGFloat { self.height - top - height }
    static var codexTitleY: CGFloat { flip(topPadding, titleHeight) }
    static var dividerY: CGFloat { flip(dividerTop, 1) }
    static var claudeTitleY: CGFloat { flip(claudeTitleTop, titleHeight) }
    static var colHeaderY: CGFloat { flip(colHeaderTop, colHeaderHeight) }
    static func rowY(_ index: Int) -> CGFloat {
        let top = index < 2
            ? codexRowsTop + CGFloat(index) * rowPitch
            : claudeRowsTop + CGFloat(index - 2) * rowPitch
        return flip(top, rowHeight)
    }
}

// The panel never becomes active, and by default AppKit spends the first click in an
// inactive window on activation instead of delivering it. Accept it directly so a single
// click refreshes.
final class InstantButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// The widget must not intercept clicks meant for the desktop or the windows above it, so
// every point misses except the refresh control.
final class ClickThroughView: NSVisualEffectView {
    weak var clickableView: NSView?

    override func hitTest(_ point: NSPoint) -> NSView? {
        // A right-click anywhere on the widget must land, because an LSUIElement app has no
        // Dock icon and no menu bar item — this menu is the only place its settings can
        // live. Left-clicks keep falling through to whatever is behind the widget.
        if let event = NSApp.currentEvent {
            switch event.type {
            case .rightMouseDown, .rightMouseUp:
                return self
            case .leftMouseDown where event.modifierFlags.contains(.control):
                return self
            default:
                break
            }
        }
        guard let clickableView else { return nil }
        let local = convert(point, from: superview)
        // Slightly generous target: a 16pt glyph is hard to hit precisely.
        return clickableView.frame.insetBy(dx: -6, dy: -6).contains(local) ? clickableView : nil
    }

    // Popping the menu explicitly rather than relying on the view's `menu` property: the
    // panel is non-activating, so AppKit's automatic context-menu path is unreliable here.
    override func rightMouseDown(with event: NSEvent) {
        guard let menu else { return super.rightMouseDown(with: event) }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
}

// Where node and usage-summary.js live differs by distribution channel, so resolve both at
// runtime instead of baking absolute paths in at build time. That keeps ONE Swift source
// serving the packaged .app and the build-from-source install.
private enum Runtime {
    private static let bundledResources = Bundle.main.resourceURL

    static let sourceRoot: String = {
        let override = ProcessInfo.processInfo.environment["AGENT_USAGE_WIDGET_DIR"] ?? ""
        return override.isEmpty ? NSHomeDirectory() + "/.agent-usage-widget" : override
    }()

    static var scriptPath: String {
        if let url = bundledResources?.appendingPathComponent("usage-summary.js"),
           FileManager.default.isReadableFile(atPath: url.path) {
            return url.path
        }
        return sourceRoot + "/scripts/usage-summary.js"
    }

    // An absolute node is mandatory, not a nicety: launchd hands the widget a bare PATH
    // (/usr/bin:/bin:/usr/sbin:/sbin) with no node in it, and some node builds are refused
    // outright by the Claude usage endpoint — node 25 gets HTTP 403 where 20 and 22 get 200
    // with byte-identical cookies. The packaged bundle therefore carries its own known-good
    // node; the source install records the one its installer probed for.
    static var nodePath: String {
        if let url = bundledResources?.appendingPathComponent("node"),
           FileManager.default.isExecutableFile(atPath: url.path) {
            return url.path
        }
        // Read at each refresh rather than at build time, so re-running the installer to
        // pick a different node takes effect without recompiling the widget.
        if let recorded = try? String(contentsOfFile: sourceRoot + "/node-path", encoding: .utf8) {
            let trimmed = recorded.trimmingCharacters(in: .whitespacesAndNewlines)
            if FileManager.default.isExecutableFile(atPath: trimmed) { return trimmed }
        }
        return ""
    }

    // Carrying its own node is what distinguishes the installer-delivered app from the
    // build-from-source install, and the two need different start-at-login programs.
    static var isPackaged: Bool {
        guard let url = bundledResources?.appendingPathComponent("node") else { return false }
        return FileManager.default.isExecutableFile(atPath: url.path)
    }

    // The skill ships inside the app so an installer-delivered copy can set up Claude Code
    // and Codex without the user cloning anything.
    static var bundledSkill: URL? {
        guard let url = bundledResources?.appendingPathComponent("skill", isDirectory: true),
              FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    static let websiteURL = "https://github.com/rex19938291-gif/agent-usage-widget-skill"
}

// Start-at-login is a plain per-user LaunchAgent rather than SMAppService, because the
// packaged app is ad-hoc signed and SMAppService ties registration to a stable signing
// identity — it would break the moment the app is rebuilt.
private enum LoginItem {
    static let label = "com.agentusage.widget"

    static var plistURL: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    static var isEnabled: Bool { FileManager.default.fileExists(atPath: plistURL.path) }

    // The packaged app launches its own binary. The source install goes through
    // run-widget.sh, which recompiles before launching — something the packaged app must
    // never do, since it ships without a Swift toolchain requirement.
    private static var program: String? {
        if Runtime.isPackaged { return Bundle.main.executableURL?.path }
        return Runtime.sourceRoot + "/run-widget.sh"
    }

    static func enable() throws {
        guard let program else {
            throw failure("could not resolve the widget's own executable path")
        }
        let plist: [String: Any] = [
            "Label": label,
            "ProgramArguments": [program],
            "RunAtLoad": true,
            // Aqua only: there is no desktop to draw on in an ssh or daemon context.
            "LimitLoadToSessionType": "Aqua",
            "StandardOutPath": "/tmp/agent-usage-widget-launchd.out.log",
            "StandardErrorPath": "/tmp/agent-usage-widget-launchd.err.log",
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try FileManager.default.createDirectory(
            at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: plistURL)
        // bootout first: bootstrap fails outright if the label is already loaded, which is
        // exactly the case when the plist is being rewritten to a new program path.
        launchctl(["bootout", domain])
        guard launchctl(["bootstrap", "gui/\(getuid())", plistURL.path]) else {
            throw failure("launchctl refused to load \(plistURL.path)")
        }
    }

    static func disable() throws {
        launchctl(["bootout", domain])
        if isEnabled { try FileManager.default.removeItem(at: plistURL) }
    }

    private static var domain: String { "gui/\(getuid())/\(label)" }

    @discardableResult
    private static func launchctl(_ arguments: [String]) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return false
        }
        return process.terminationStatus == 0
    }

    private static func failure(_ message: String) -> NSError {
        NSError(domain: "AgentUsageWidget", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

private enum SkillInstaller {
    // Both hosts read skills from the same layout, so one bundled copy serves both.
    private static let hosts = [(directory: ".claude", name: "Claude Code"), (directory: ".codex", name: "Codex")]

    // Returns the hosts it installed into. Only hosts that are actually present get a skills
    // directory: creating ~/.codex for someone who has never installed Codex would leave
    // litter behind and imply support that isn't there.
    static func install() throws -> [String] {
        guard let source = Runtime.bundledSkill else {
            throw failure("this build carries no bundled skill")
        }
        let fileManager = FileManager.default
        let home = URL(fileURLWithPath: NSHomeDirectory())
        var installed: [String] = []

        for host in hosts {
            let hostRoot = home.appendingPathComponent(host.directory)
            guard fileManager.fileExists(atPath: hostRoot.path) else { continue }
            let destination = hostRoot.appendingPathComponent("skills/agent-usage-widget-skill")
            try fileManager.createDirectory(
                at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            // Replace wholesale: copying over an older version would leave files that the
            // new one has dropped, and the skill is small enough that this is cheap.
            if fileManager.fileExists(atPath: destination.path) {
                try fileManager.removeItem(at: destination)
            }
            try fileManager.copyItem(at: source, to: destination)
            installed.append(host.name)
        }

        guard !installed.isEmpty else {
            throw failure("neither ~/.claude nor ~/.codex exists — install Claude Code or Codex first")
        }
        return installed
    }

    private static func failure(_ message: String) -> NSError {
        NSError(domain: "AgentUsageWidget", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

final class UsageWidget: NSObject, NSApplicationDelegate {
    private var panel: NSPanel!
    private var timer: Timer?
    private var isRefreshing = false
    // Kept so a language change can re-render the numbers already on screen instead of
    // waiting for the next 60-second refresh.
    private var lastSummary: UsageSummary?

    private let titleLabel = UsageWidget.label(size: 12, weight: .semibold, color: .white.withAlphaComponent(0.70))
    private let updatedLabel = UsageWidget.label(size: 10.5, weight: .regular, color: .white.withAlphaComponent(0.44))
    private let codexFiveLabel = UsageWidget.label(size: 19, weight: .bold)
    private let codexFivePercent = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.74), monoDigits: true)
    private let codexFiveReset = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.52), monoDigits: true)
    private let codexWeekLabel = UsageWidget.label(size: 19, weight: .bold)
    private let codexWeekPercent = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.74), monoDigits: true)
    private let codexWeekReset = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.52), monoDigits: true)
    private let claudeTitle = UsageWidget.label(size: 12, weight: .semibold, color: .white.withAlphaComponent(0.70))
    private let claudeFiveLabel = UsageWidget.label(size: 19, weight: .bold)
    private let claudeFivePercent = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.74), monoDigits: true)
    private let claudeFiveReset = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.52), monoDigits: true)
    private let claudeWeekLabel = UsageWidget.label(size: 19, weight: .bold)
    private let claudeWeekPercent = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.74), monoDigits: true)
    private let claudeWeekReset = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.52), monoDigits: true)
    // Same size and weight as the other rows: this row is one more quota window, not a
    // footnote, so it shares the type scale instead of being visually demoted.
    private let claudeScopedLabel = UsageWidget.label(size: 19, weight: .bold)
    private let claudeScopedPercent = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.74), monoDigits: true)
    private let claudeScopedReset = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.52), monoDigits: true)
    private let refreshButton = InstantButton()
    // Without these the numeric columns are unlabelled: a bare "94%" could as easily read
    // as used-so-far, and the date column as when the window started.
    private let percentHeader = UsageWidget.label(size: 10.5, weight: .regular, color: .white.withAlphaComponent(0.40))
    private let resetHeader = UsageWidget.label(size: 10.5, weight: .regular, color: .white.withAlphaComponent(0.40))

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        // launchd can start the widget while a copy opened from /Applications is already
        // running; two identical panels stacked on the desktop read as a rendering bug.
        if let bundleID = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
               .contains(where: { $0 != NSRunningApplication.current }) {
            NSApp.terminate(nil)
            return
        }
        buildPanel()
        refresh(forceClaude: true)
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refresh(forceClaude: true) }
    }

    private func buildPanel() {
        // One vertical rhythm for the whole panel: every quota row is Metrics.rowPitch
        // apart and Metrics.rowHeight tall, so the gaps read as identical.
        let frame = NSRect(x: 18, y: 18, width: Metrics.width, height: Metrics.height)
        panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        // Above the Finder's desktop-icon window, not just the desktop: that window spans
        // the whole screen and, being higher, swallowed every click aimed at the widget
        // even though it is transparent. Still far below .normal, so real app windows keep
        // covering the widget as before.
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        // Mouse events must reach the refresh button, so the panel cannot ignore them
        // wholesale. ClickThroughView below re-establishes click-through everywhere
        // except the button, keeping the widget out of the way of real windows.
        panel.ignoresMouseEvents = false

        let visual = ClickThroughView(frame: NSRect(x: 0, y: 0, width: frame.width, height: frame.height))
        visual.material = .hudWindow
        visual.blendingMode = .behindWindow
        visual.state = .active
        visual.wantsLayer = true
        visual.layer?.cornerRadius = 10
        visual.layer?.masksToBounds = true
        visual.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.34).cgColor

        titleLabel.frame = NSRect(x: Metrics.padding, y: Metrics.codexTitleY, width: Metrics.titleWidth, height: Metrics.titleHeight)
        visual.addSubview(titleLabel)

        refreshButton.isBordered = false
        refreshButton.bezelStyle = .inline
        refreshButton.imagePosition = .imageOnly
        refreshButton.contentTintColor = .white.withAlphaComponent(0.55)
        refreshButton.target = self
        refreshButton.action = #selector(refreshTapped)
        visual.addSubview(refreshButton)
        visual.clickableView = refreshButton
        visual.menu = contextMenu

        updatedLabel.alignment = .right
        visual.addSubview(updatedLabel)

        // Captions for the two numeric columns, right-aligned to the same edges as the
        // values below them.
        percentHeader.alignment = .right
        percentHeader.frame = NSRect(x: Metrics.percentX, y: Metrics.colHeaderY, width: Metrics.percentWidth, height: Metrics.colHeaderHeight)
        visual.addSubview(percentHeader)
        resetHeader.alignment = .right
        resetHeader.frame = NSRect(x: Metrics.resetX, y: Metrics.colHeaderY, width: Metrics.resetWidth, height: Metrics.colHeaderHeight)
        visual.addSubview(resetHeader)

        addRow(to: visual, y: Metrics.rowY(0), label: codexFiveLabel, percent: codexFivePercent, reset: codexFiveReset)
        addRow(to: visual, y: Metrics.rowY(1), label: codexWeekLabel, percent: codexWeekPercent, reset: codexWeekReset)
        let divider = NSView(frame: NSRect(x: Metrics.padding, y: Metrics.dividerY, width: Metrics.width - Metrics.padding * 2, height: 1))
        divider.wantsLayer = true
        divider.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.045).cgColor
        visual.addSubview(divider)

        claudeTitle.frame = NSRect(x: Metrics.padding, y: Metrics.claudeTitleY, width: Metrics.titleWidth, height: Metrics.titleHeight)
        visual.addSubview(claudeTitle)
        addRow(to: visual, y: Metrics.rowY(2), label: claudeFiveLabel, percent: claudeFivePercent, reset: claudeFiveReset)
        addRow(to: visual, y: Metrics.rowY(3), label: claudeWeekLabel, percent: claudeWeekPercent, reset: claudeWeekReset)
        addRow(to: visual, y: Metrics.rowY(4), label: claudeScopedLabel, percent: claudeScopedPercent, reset: claudeScopedReset)


        claudeScopedLabel.stringValue = "Sonnet"
        for label in [codexFivePercent, codexWeekPercent, claudeFivePercent, claudeWeekPercent, claudeScopedPercent] { label.stringValue = "--%" }
        for label in [codexFiveReset, codexWeekReset, claudeFiveReset, claudeWeekReset, claudeScopedReset] { label.stringValue = "--" }
        applyLanguage()

        panel.contentView = visual
        positionTopLeft()
        panel.orderFront(nil)
        panel.orderBack(nil)
    }

    // Every language-dependent string is set from here — on launch and again on each
    // language change — so a switch cannot leave half the panel in the previous language.
    private func applyLanguage() {
        let strings = Strings.current
        refreshButton.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: strings.refreshTooltip)
        refreshButton.toolTip = strings.refreshTooltip
        percentHeader.stringValue = strings.remainingHeader
        resetHeader.stringValue = strings.resetHeader
        claudeTitle.stringValue = strings.claudeTitle
        codexFiveLabel.stringValue = strings.fiveHour
        codexWeekLabel.stringValue = strings.oneWeek
        claudeFiveLabel.stringValue = strings.fiveHour
        claudeWeekLabel.stringValue = strings.oneWeek
        // The Codex title carries a data-age suffix and the status line a timestamp, so both
        // are re-rendered from the last summary rather than reset to their initial text —
        // switching language must not look like the numbers went stale.
        if let lastSummary {
            updateUI(lastSummary)
        } else {
            titleLabel.stringValue = strings.codexTitle
            setStatus(strings.updating)
        }
    }

    private func addRow(to parent: NSView, y: CGFloat, label: NSTextField, percent: NSTextField, reset: NSTextField) {
        label.frame = NSRect(x: Metrics.padding, y: y, width: Metrics.labelWidth, height: Metrics.rowHeight)
        percent.alignment = .right
        percent.frame = NSRect(x: Metrics.percentX, y: y, width: Metrics.percentWidth, height: Metrics.rowHeight)
        reset.alignment = .right
        reset.frame = NSRect(x: Metrics.resetX, y: y, width: Metrics.resetWidth, height: Metrics.rowHeight)
        parent.addSubview(label)
        parent.addSubview(percent)
        parent.addSubview(reset)
    }

    private func positionTopLeft() {
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(x: visible.minX + 18, y: visible.maxY - size.height - 18))
    }

    @objc private func refreshTapped() {
        refresh(forceClaude: true)
    }

    // MARK: - Context menu
    //
    // With no Dock icon and no menu bar item, this menu is the app's entire settings
    // surface: language, start-at-login, skill install and quit all live here.

    private lazy var contextMenu: NSMenu = {
        let menu = NSMenu()
        menu.delegate = self
        return menu
    }()

    // Rebuilt on every open rather than once at launch, so the language of the titles and
    // the state of the start-at-login checkmark are always current — the LaunchAgent can be
    // removed from outside the app.
    fileprivate func rebuildMenu(_ menu: NSMenu) {
        let strings = Strings.current
        menu.removeAllItems()
        menu.addItem(item(strings.refreshNow, #selector(refreshTapped)))

        let languageItem = NSMenuItem(title: strings.languageMenu, action: nil, keyEquivalent: "")
        let languageSubmenu = NSMenu()
        let choices: [(Language, String)] = [
            (.auto, strings.languageAuto),
            (.zhHant, strings.languageZhHant),
            (.english, strings.languageEnglish),
        ]
        for (language, title) in choices {
            let choice = item(title, #selector(languageSelected(_:)))
            choice.representedObject = language.rawValue
            choice.state = Language.preference == language ? .on : .off
            languageSubmenu.addItem(choice)
        }
        languageItem.submenu = languageSubmenu
        menu.addItem(languageItem)

        let loginItem = item(strings.launchAtLogin, #selector(toggleLaunchAtLogin))
        loginItem.state = LoginItem.isEnabled ? .on : .off
        menu.addItem(loginItem)

        // Only offered by builds that carry the skill; the source install already put it in
        // place, so the item would be a no-op there.
        if Runtime.bundledSkill != nil {
            menu.addItem(item(strings.installSkill, #selector(installSkill)))
        }
        menu.addItem(item(strings.openWebsite, #selector(openWebsite)))
        menu.addItem(.separator())
        menu.addItem(item(strings.quit, #selector(quit)))
    }

    private func item(_ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    @objc private func languageSelected(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let language = Language(rawValue: raw) else { return }
        Language.preference = language
        applyLanguage()
    }

    @objc private func toggleLaunchAtLogin() {
        let strings = Strings.current
        do {
            if LoginItem.isEnabled {
                try LoginItem.disable()
            } else {
                try LoginItem.enable()
            }
        } catch {
            presentAlert(strings.launchAtLogin, error.localizedDescription)
        }
    }

    @objc private func installSkill() {
        let strings = Strings.current
        do {
            let hosts = try SkillInstaller.install()
            presentAlert(strings.installSkillDone(hosts.joined(separator: strings.listSeparator)), "")
        } catch {
            presentAlert(strings.installSkillFailed, error.localizedDescription)
        }
    }

    @objc private func openWebsite() {
        guard let url = URL(string: Runtime.websiteURL) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func presentAlert(_ title: String, _ message: String) {
        // The panel is non-activating, so without this the alert can open behind whatever
        // window the user was working in and look like nothing happened.
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        if !message.isEmpty { alert.informativeText = message }
        alert.runModal()
    }

    private func setStatus(_ text: String) {
        updatedLabel.stringValue = text
        layOutStatusRow()
    }

    // The timestamp is right-aligned to the panel edge and its width changes with the text
    // ("Updating" vs "Last 23:45"), so the icon is placed from the measured text width rather
    // than a fixed x — that keeps it tucked against the timestamp instead of drifting.
    private func layOutStatusRow() {
        let iconSize: CGFloat = 13
        let gap: CGFloat = 1
        let rightEdge = Metrics.width - Metrics.padding
        // sizeToFit, not attributedStringValue.size(): the latter omits the text field's own
        // insets, so the box came out narrower than the glyphs and clipped the timestamp.
        updatedLabel.sizeToFit()
        let fitted = updatedLabel.frame.size
        let textWidth = min(ceil(fitted.width) + 2, Metrics.statusMaxWidth)
        let textHeight = ceil(fitted.height)
        // Both boxes are centred on one shared centre line, so the icon and the timestamp
        // sit on the same baseline regardless of their differing heights.
        let centerY = Metrics.codexTitleY + Metrics.titleHeight / 2
        updatedLabel.frame = NSRect(x: rightEdge - textWidth, y: centerY - textHeight / 2, width: textWidth, height: textHeight)
        refreshButton.frame = NSRect(
            x: rightEdge - textWidth - gap - iconSize,
            y: centerY - iconSize / 2,
            width: iconSize,
            height: iconSize
        )
    }

    private func refresh(forceClaude: Bool = false) {
        if isRefreshing { return }
        isRefreshing = true
        setStatus(Strings.current.updating)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let process = Process()
            // Last-resort env lookup only if neither the bundle nor node-path yielded a
            // node — it works when run from a shell but not under launchd.
            let resolvedNode = Runtime.nodePath
            var arguments = [Runtime.scriptPath, "--quota-only"]
            if forceClaude { arguments.append("--refresh-claude") }
            if resolvedNode.isEmpty { arguments.insert("node", at: 0) }
            process.executableURL = URL(fileURLWithPath: resolvedNode.isEmpty ? "/usr/bin/env" : resolvedNode)
            process.arguments = arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = Pipe()
            do {
                try process.run()
                process.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                DispatchQueue.main.async {
                    self.isRefreshing = false
                    if process.terminationStatus == 0, let summary = try? JSONDecoder().decode(UsageSummary.self, from: data) {
                        self.updateUI(summary)
                    } else {
                        self.setStatus(Strings.current.updateFailed)
                    }
                }
            } catch {
                DispatchQueue.main.async { self.isRefreshing = false; self.setStatus(Strings.current.updateFailed) }
            }
        }
    }

    private func updateUI(_ summary: UsageSummary) {
        lastSummary = summary
        let strings = Strings.current
        let primary = summary.codex.rateLimits?.primary
        let secondary = summary.codex.rateLimits?.secondary
        let claude = summary.claude.official
        // The live endpoint distinguishes "this plan has no 5-hour window" from "unknown",
        // so name the absent window rather than showing --% as if the read had failed.
        let codexNoFiveHour = summary.codex.official?.available == true && summary.codex.official?.fiveHour == nil
        codexFivePercent.stringValue = codexNoFiveHour ? strings.noWindowOnPlan : formatPercent(remainingPercent(fromUsed: primary?.used_percent))
        codexWeekPercent.stringValue = formatPercent(remainingPercent(fromUsed: secondary?.used_percent))
        codexFiveReset.stringValue = codexNoFiveHour ? "—" : formatReset(primary?.resets_at, compact: false)
        codexWeekReset.stringValue = formatReset(secondary?.resets_at, compact: true)
        claudeFivePercent.stringValue = formatPercent(remainingPercent(fromUsed: claude?.fiveHour?.usedPercent))
        claudeWeekPercent.stringValue = formatPercent(remainingPercent(fromUsed: claude?.weekAll?.usedPercent))
        claudeScopedPercent.stringValue = formatPercent(remainingPercent(fromUsed: claude?.weekScoped?.usedPercent))
        claudeFiveReset.stringValue = formatReset(claude?.fiveHour?.resetsAt, compact: false)
        claudeWeekReset.stringValue = formatReset(claude?.weekAll?.resetsAt, compact: true)
        claudeScopedReset.stringValue = formatReset(claude?.weekScoped?.resetsAt, compact: true)
        // Whichever model the plan scopes its weekly window to ("Fable", "Sonnet", ...).
        if let scopedLabel = claude?.weekScoped?.label, !scopedLabel.isEmpty {
            claudeScopedLabel.stringValue = scopedLabel
        }
        // Codex snapshots come from Codex CLI runs only, so they can be hours stale while
        // the Codex app shows a different number. Say so rather than looking live.
        titleLabel.stringValue = strings.codexTitle + codexAgeSuffix(primary: primary, secondary: secondary)
        setStatus(strings.lastUpdated(formatGeneratedAt(summary.generatedAt)))
    }

    private func codexAgeSuffix(primary: RateLimitWindow?, secondary: RateLimitWindow?) -> String {
        let stamps = [primary?.observed_at, secondary?.observed_at].compactMap { $0 }
        guard let newest = stamps.max() else { return "" }
        let age = Date().timeIntervalSince1970 - newest
        if age <= 15 * 60 { return "" }
        // Kept compact so the section title never collides with the timestamp.
        if age < 3600 { return String(format: " · %.0fm", age / 60) }
        if age < 48 * 3600 { return String(format: " · %.0fh", age / 3600) }
        return String(format: " · %.0fd", age / 86400)
    }

    private func remainingPercent(fromUsed used: Double?) -> Double? {
        guard let used else { return nil }
        return min(max(100 - used, 0), 100)
    }

    private func formatPercent(_ value: Double?) -> String {
        guard let value else { return "--%" }
        return String(format: "%.0f%%", value)
    }

    private func formatReset(_ epochSeconds: Double?, compact: Bool) -> String {
        guard let epochSeconds else { return "--" }
        let date = Date(timeIntervalSince1970: epochSeconds)
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.timeZone = .current
        // Fixed-width numeric forms so every reset cell is the same visual size: MM/dd for
        // dates, 24-hour HH:mm for times (never "下午 12:..." truncated by the column).
        formatter.dateFormat = compact ? "MM/dd" : "HH:mm"
        return formatter.string(from: date)
    }

    private func formatGeneratedAt(_ isoString: String) -> String {
        let withFractionalSeconds = ISO8601DateFormatter()
        withFractionalSeconds.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let withoutFractionalSeconds = ISO8601DateFormatter()
        withoutFractionalSeconds.formatOptions = [.withInternetDateTime]
        guard let date = withFractionalSeconds.date(from: isoString) ?? withoutFractionalSeconds.date(from: isoString) else { return "--:--" }
        let output = DateFormatter()
        output.locale = Locale.current
        output.dateFormat = "HH:mm"
        return output.string(from: date)
    }

    private static func label(size: CGFloat, weight: NSFont.Weight, color: NSColor = .white, monoDigits: Bool = false) -> NSTextField {
        let label = NSTextField(labelWithString: "")
        // Monospaced digits for the numeric columns: proportional digits give "08/18" and
        // "23:59" different widths, so a right-aligned column still looks ragged on its
        // left edge. Equal-width figures make both edges line up.
        label.font = monoDigits
            ? NSFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
            : NSFont.systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.backgroundColor = .clear
        label.isBordered = false
        label.lineBreakMode = .byTruncatingTail
        return label
    }
}

extension UsageWidget: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildMenu(menu)
    }
}

// Headless equivalents of the context-menu actions. Two reasons they exist: the menu of an
// LSUIElement app cannot be driven by a script, so without these the login-item and skill
// paths could only ever be tested by hand; and they give anyone automating a setup the same
// operations the UI offers.
func runHeadless(_ command: String) -> Never {
    func fail(_ error: Error) -> Never {
        FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
        exit(1)
    }

    switch command {
    case "--enable-login-item":
        do {
            try LoginItem.enable()
            print("login item enabled: \(LoginItem.plistURL.path)")
        } catch { fail(error) }
    case "--disable-login-item":
        do {
            try LoginItem.disable()
            print("login item disabled")
        } catch { fail(error) }
    case "--install-skill":
        do {
            let hosts = try SkillInstaller.install()
            print("skill installed for: \(hosts.joined(separator: ", "))")
        } catch { fail(error) }
    case "--check-layout":
        // The panel is a fixed pixel grid, so a translation that is wider than its column is
        // silently truncated with an ellipsis rather than reflowing. This measures every
        // language-dependent string with the font it is actually drawn in.
        // Measured through Strings.about rather than by switching the stored preference. An
        // earlier version set the preference for each language and restored it in a defer,
        // which silently left the widget in English: UserDefaults writes reach cfprefsd
        // asynchronously, and exit() drops the pending restore while the last measured
        // language had already landed.
        var problems: [String] = []
        for language in [Language.zhHant, Language.english] {
            let strings = Strings.about(language)
            let title = NSFont.systemFont(ofSize: 12, weight: .semibold)
            let caption = NSFont.systemFont(ofSize: 10.5, weight: .regular)
            let row = NSFont.systemFont(ofSize: 19, weight: .bold)
            let value = NSFont.systemFont(ofSize: 19, weight: .semibold)
            let checks: [(String, String, CGFloat, NSFont)] = [
                // Worst case for the titles is the Codex one with a stale-data suffix.
                ("codexTitle", strings.codexTitle + " · 12h", Metrics.titleWidth, title),
                ("claudeTitle", strings.claudeTitle, Metrics.titleWidth, title),
                ("remainingHeader", strings.remainingHeader, Metrics.percentWidth, caption),
                ("resetHeader", strings.resetHeader, Metrics.resetWidth, caption),
                ("fiveHour", strings.fiveHour, Metrics.labelWidth, row),
                ("oneWeek", strings.oneWeek, Metrics.labelWidth, row),
                ("noWindowOnPlan", strings.noWindowOnPlan, Metrics.percentWidth, value),
                ("updating", strings.updating, Metrics.statusMaxWidth, caption),
                ("updateFailed", strings.updateFailed, Metrics.statusMaxWidth, caption),
                ("lastUpdated", strings.lastUpdated("23:59"), Metrics.statusMaxWidth, caption),
            ]
            for (name, text, limit, font) in checks {
                let width = (text as NSString).size(withAttributes: [.font: font]).width
                let status = width > limit ? "OVERFLOW" : "ok"
                print(String(format: "%-8s %-16s %6.1f / %5.0f  %@",
                             (language.rawValue as NSString).utf8String!, (name as NSString).utf8String!,
                             width, limit, status))
                if width > limit {
                    problems.append("\(language.rawValue) \(name): \(Int(width))pt in a \(Int(limit))pt column")
                }
            }
        }
        guard problems.isEmpty else {
            FileHandle.standardError.write(Data(("\n" + problems.joined(separator: "\n") + "\n").utf8))
            exit(1)
        }
        print("\nno overflow in either language")
    case "--status":
        print("version: \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown")")
        print("packaged: \(Runtime.isPackaged)")
        print("node: \(Runtime.nodePath.isEmpty ? "(falling back to PATH)" : Runtime.nodePath)")
        print("script: \(Runtime.scriptPath)")
        print("language: \(Language.preference.rawValue) -> \(Language.preference.resolved.rawValue)")
        print("login item: \(LoginItem.isEnabled ? "enabled" : "disabled")")
    default:
        print("""
        AgentUsageWidget — desktop widget showing remaining Claude and Codex quota.

        Run with no arguments to show the widget. Available commands:
          --status               print resolved paths, language and login-item state
          --enable-login-item    start the widget automatically at login
          --disable-login-item   stop starting it at login
          --install-skill        install the bundled skill for Claude Code / Codex
        """)
    }
    exit(0)
}

if let command = CommandLine.arguments.dropFirst().first(where: { $0.hasPrefix("--") }) {
    runHeadless(command)
}

let app = NSApplication.shared
let delegate = UsageWidget()
app.delegate = delegate
app.run()
SWIFT

cat > "$INSTALL_DIR/run-widget.sh" <<'RUN'
#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
unset CLAUDE_CODE_OAUTH_TOKEN

ROOT="${AGENT_USAGE_WIDGET_DIR:-$HOME/.agent-usage-widget}"
BUILD_DIR="$ROOT/build"
BIN="$BUILD_DIR/AgentUsageWidget"
APP="$BUILD_DIR/AgentUsageWidget.app"

mkdir -p "$BUILD_DIR" "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$BIN" "$ROOT/Sources/AgentUsageWidget/main.swift"
cp "$BIN" "$APP/Contents/MacOS/AgentUsageWidget"
cp "$ROOT/App/Info.plist" "$APP/Contents/Info.plist"

if command -v pgrep >/dev/null 2>&1 && pgrep -x AgentUsageWidget >/dev/null 2>&1; then
  echo "AgentUsageWidget is already running."
  exit 0
fi

if ! open -n "$APP"; then
  nohup "$APP/Contents/MacOS/AgentUsageWidget" >/tmp/agent-usage-widget.log 2>&1 &
  echo "Started AgentUsageWidget with PID $!."
fi
RUN

chmod 700 "$INSTALL_DIR/run-widget.sh"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$LAUNCH_AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$APP_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_DIR/run-widget.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>/tmp/agent-usage-widget-launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/agent-usage-widget-launchd.err.log</string>
</dict>
</plist>
PLIST

plutil -lint "$LAUNCH_AGENT"
bash -n "$INSTALL_DIR/run-widget.sh"
"$NODE_BIN" --check "$INSTALL_DIR/scripts/usage-summary.js"

if [[ "${AGENT_USAGE_WIDGET_SKIP_LAUNCH:-0}" != "1" ]]; then
  "$INSTALL_DIR/run-widget.sh"

  uid="$(id -u)"
  launchctl bootout "gui/$uid/$APP_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid" "$LAUNCH_AGENT" >/dev/null 2>&1 || true
fi

echo "Installed Agent Usage Widget at $INSTALL_DIR"
echo "LaunchAgent: $LAUNCH_AGENT"
echo "如果 macOS 提示 Claude Safe Storage，請依你的安全偏好選擇「允許」或「永遠允許」。"
