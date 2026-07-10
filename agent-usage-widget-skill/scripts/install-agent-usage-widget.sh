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
const CACHE_DIR = path.join(INSTALL_DIR, ".cache");
const CLAUDE_USAGE_CACHE = path.join(CACHE_DIR, "claude-usage-percentages.json");
const FORCE_CLAUDE_REFRESH = process.argv.includes("--refresh-claude");

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
    walkJsonlFiles(CLAUDE_ROOT, weekStartMs),
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
    const official = {
      available: true,
      fetchedAt: new Date().toISOString(),
      fiveHour: normalizeClaudeLimit(data.five_hour),
      weekAll: normalizeClaudeLimit(data.seven_day),
      weekSonnet: normalizeClaudeLimit(pickClaudeWindow(data, "seven_day_sonnet", "sonnet")),
    };
    writeClaudeUsageCache(official);
    return { ...official, cache: "live" };
  } catch {
    const cached = readClaudeUsageCache({ maxAgeMs: Infinity });
    if (cached) return { ...cached, cache: "stale", error: "live_unavailable" };
    return { available: false, error: "unavailable" };
  }
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

function normalizeExpiredRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") return rateLimits;
  const fixWindow = (window) => {
    if (!window || typeof window !== "object") return window;
    if (isWindowExpired(window.resets_at)) return { ...window, used_percent: 0, resets_at: null };
    return window;
  };
  return { ...rateLimits, primary: fixWindow(rateLimits.primary), secondary: fixWindow(rateLimits.secondary) };
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
    return {
      available: true,
      fetchedAt: typeof cached.fetchedAt === "string" ? cached.fetchedAt : null,
      fiveHour: normalizeClaudeLimit(cached.fiveHour),
      weekAll: normalizeClaudeLimit(cached.weekAll),
      weekSonnet: normalizeClaudeLimit(cached.weekSonnet),
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
  const files = await walkJsonlFiles(CODEX_ROOT, CODEX_SCAN_SINCE_MS);
  // Local Codex logs can interleave rate-limit snapshots from more than one auth
  // context (main account plus imported/delegated/auxiliary credentials). Taking
  // the globally-latest snapshot makes the widget flip between them, so group by
  // stream and lock onto the user's real account (the most-used active stream).
  const streams = new Map();

  for (const file of files) {
    await readJsonLines(file, async (row) => {
      if (row?.payload?.type !== "token_count") return;
      const timestamp = Date.parse(row.timestamp || "");
      if (!Number.isFinite(timestamp)) return;
      if (row.payload.rate_limits) {
        const key = codexStreamKey(row.payload.rate_limits);
        const prev = streams.get(key);
        if (!prev || timestamp > prev.ts) {
          streams.set(key, { ts: timestamp, rateLimits: row.payload.rate_limits });
        }
      }
    });
  }

  const selected = selectPrimaryCodexStream(streams);
  return {
    hour,
    week,
    latestAt: selected?.ts || 0,
    rateLimits: normalizeExpiredRateLimits(selected?.rateLimits || null),
    streamsConsidered: streams.size,
    filesScanned: files.length,
  };
}

function codexStreamKey(rateLimits) {
  const p = rateLimits?.primary || {};
  const s = rateLimits?.secondary || {};
  return `${rateLimits?.plan_type || "?"}|${p.window_minutes || "?"}|${s.resets_at || "?"}`;
}

// Lock onto the user's real account: among recently-seen streams, pick the
// most-used one (the account actually being consumed); showing the most-constrained
// window is the safe choice for a quota widget. Falls back to all streams if none
// are recent.
function selectPrimaryCodexStream(streams) {
  const ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000;
  const all = [...streams.values()];
  if (!all.length) return null;
  const recent = all.filter((s) => nowMs - s.ts <= ACTIVE_WINDOW_MS);
  const pool = recent.length ? recent : all;
  const usageScore = (s) => {
    const p = s.rateLimits?.primary?.used_percent;
    const w = s.rateLimits?.secondary?.used_percent;
    return Math.max(Number.isFinite(p) ? p : 0, Number.isFinite(w) ? w : 0);
  };
  pool.sort((a, b) => usageScore(b) - usageScore(a) || b.ts - a.ts);
  return pool[0];
}

function remainingPercent(usedPercent) {
  if (!Number.isFinite(usedPercent)) return null;
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "n/a";
}

function formatReset(epochSeconds) {
  if (!epochSeconds) return "n/a";
  const date = new Date(epochSeconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString("zh-TW", sameDay
    ? { hour: "numeric", minute: "2-digit", hour12: false }
    : { month: "numeric", day: "numeric" });
}

function recoveryText(epochSeconds, remainingPercent) {
  if (Number.isFinite(remainingPercent) && Math.round(remainingPercent) >= 100) return "已是 100%";
  if (!Number.isFinite(epochSeconds)) return "回復 100%：n/a";
  return `回復 100%：${formatReset(epochSeconds)}`;
}

function buildText(summary) {
  const c = summary.claude;
  const x = summary.codex;
  const codexPrimaryRemaining = remainingPercent(x.rateLimits?.primary?.used_percent);
  const codexSecondaryRemaining = remainingPercent(x.rateLimits?.secondary?.used_percent);
  const claudeFiveRemaining = remainingPercent(c.official?.fiveHour?.usedPercent);
  const claudeWeekRemaining = remainingPercent(c.official?.weekAll?.usedPercent);
  const claudeSonnetRemaining = remainingPercent(c.official?.weekSonnet?.usedPercent);
  return [
    "Codex 可用額度",
    `5 小時 ${formatPercent(codexPrimaryRemaining)} ${recoveryText(x.rateLimits?.primary?.resets_at, codexPrimaryRemaining)}`,
    `1 週 ${formatPercent(codexSecondaryRemaining)} ${recoveryText(x.rateLimits?.secondary?.resets_at, codexSecondaryRemaining)}`,
    "Claude 可用額度",
    `5 小時 ${formatPercent(claudeFiveRemaining)} ${recoveryText(c.official?.fiveHour?.resetsAt, claudeFiveRemaining)}`,
    `1 週 ${formatPercent(claudeWeekRemaining)} ${recoveryText(c.official?.weekAll?.resetsAt, claudeWeekRemaining)}`,
    `Sonnet ${formatPercent(claudeSonnetRemaining)} ${recoveryText(c.official?.weekSonnet?.resetsAt, claudeSonnetRemaining)}`,
  ].join("\n");
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

cat > "$INSTALL_DIR/Sources/AgentUsageWidget/main.swift" <<SWIFT
import AppKit

struct UsageSummary: Decodable { let generatedAt: String; let claude: ClaudeSummary; let codex: CodexSummary }
struct ClaudeSummary: Decodable { let official: ClaudeOfficial? }
struct ClaudeOfficial: Decodable { let fiveHour: ClaudeLimit?; let weekAll: ClaudeLimit?; let weekSonnet: ClaudeLimit? }
struct ClaudeLimit: Decodable { let usedPercent: Double?; let resetsAt: Double? }
struct CodexSummary: Decodable { let rateLimits: RateLimits? }
struct RateLimits: Decodable { let primary: RateLimitWindow?; let secondary: RateLimitWindow? }
struct RateLimitWindow: Decodable { let used_percent: Double?; let resets_at: Double? }

final class UsageWidget: NSObject, NSApplicationDelegate {
    private var panel: NSPanel!
    private let scriptPath = "$INSTALL_DIR/scripts/usage-summary.js"
    private var timer: Timer?
    private var isRefreshing = false

    private let titleLabel = UsageWidget.label(size: 12, weight: .semibold, color: .white.withAlphaComponent(0.70))
    private let updatedLabel = UsageWidget.label(size: 10.5, weight: .regular, color: .white.withAlphaComponent(0.44))
    private let codexFiveLabel = UsageWidget.label(size: 19, weight: .bold)
    private let codexFivePercent = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.74))
    private let codexFiveReset = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.52))
    private let codexWeekLabel = UsageWidget.label(size: 19, weight: .bold)
    private let codexWeekPercent = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.74))
    private let codexWeekReset = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.52))
    private let claudeTitle = UsageWidget.label(size: 12, weight: .semibold, color: .white.withAlphaComponent(0.70))
    private let claudeFiveLabel = UsageWidget.label(size: 19, weight: .bold)
    private let claudeFivePercent = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.74))
    private let claudeFiveReset = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.52))
    private let claudeWeekLabel = UsageWidget.label(size: 19, weight: .bold)
    private let claudeWeekPercent = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.74))
    private let claudeWeekReset = UsageWidget.label(size: 19, weight: .semibold, color: .white.withAlphaComponent(0.52))
    private let claudeSonnetLabel = UsageWidget.label(size: 17, weight: .semibold, color: .white.withAlphaComponent(0.82))
    private let claudeSonnetPercent = UsageWidget.label(size: 17, weight: .semibold, color: .white.withAlphaComponent(0.68))
    private let claudeSonnetReset = UsageWidget.label(size: 17, weight: .semibold, color: .white.withAlphaComponent(0.48))

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildPanel()
        refresh(forceClaude: true)
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refresh(forceClaude: true) }
    }

    private func buildPanel() {
        let frame = NSRect(x: 18, y: 18, width: 340, height: 226)
        panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true

        let visual = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: frame.width, height: frame.height))
        visual.material = .hudWindow
        visual.blendingMode = .behindWindow
        visual.state = .active
        visual.wantsLayer = true
        visual.layer?.cornerRadius = 10
        visual.layer?.masksToBounds = true
        visual.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.34).cgColor

        titleLabel.stringValue = "Codex 可用額度"
        titleLabel.frame = NSRect(x: 18, y: 198, width: 132, height: 18)
        visual.addSubview(titleLabel)
        updatedLabel.alignment = .right
        updatedLabel.stringValue = "更新中"
        updatedLabel.frame = NSRect(x: 188, y: 198, width: 132, height: 18)
        visual.addSubview(updatedLabel)

        addRow(to: visual, y: 164, label: codexFiveLabel, percent: codexFivePercent, reset: codexFiveReset)
        addRow(to: visual, y: 136, label: codexWeekLabel, percent: codexWeekPercent, reset: codexWeekReset)
        let divider = NSView(frame: NSRect(x: 18, y: 124, width: 304, height: 1))
        divider.wantsLayer = true
        divider.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.045).cgColor
        visual.addSubview(divider)

        claudeTitle.stringValue = "Claude 可用額度"
        claudeTitle.frame = NSRect(x: 18, y: 98, width: 160, height: 18)
        visual.addSubview(claudeTitle)
        addRow(to: visual, y: 64, label: claudeFiveLabel, percent: claudeFivePercent, reset: claudeFiveReset)
        addRow(to: visual, y: 36, label: claudeWeekLabel, percent: claudeWeekPercent, reset: claudeWeekReset)
        addRow(to: visual, y: 12, label: claudeSonnetLabel, percent: claudeSonnetPercent, reset: claudeSonnetReset)

        codexFiveLabel.stringValue = "5 小時"
        codexWeekLabel.stringValue = "1 週"
        claudeFiveLabel.stringValue = "5 小時"
        claudeWeekLabel.stringValue = "1 週"
        claudeSonnetLabel.stringValue = "Sonnet"
        for label in [codexFivePercent, codexWeekPercent, claudeFivePercent, claudeWeekPercent, claudeSonnetPercent] { label.stringValue = "--%" }
        for label in [codexFiveReset, codexWeekReset, claudeFiveReset, claudeWeekReset, claudeSonnetReset] { label.stringValue = "--" }

        panel.contentView = visual
        positionTopLeft()
        panel.orderFront(nil)
        panel.orderBack(nil)
    }

    private func addRow(to parent: NSView, y: CGFloat, label: NSTextField, percent: NSTextField, reset: NSTextField) {
        label.frame = NSRect(x: 18, y: y, width: 88, height: 26)
        percent.alignment = .right
        percent.frame = NSRect(x: 144, y: y, width: 70, height: 26)
        reset.alignment = .right
        reset.frame = NSRect(x: 226, y: y, width: 96, height: 26)
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

    private func refresh(forceClaude: Bool = false) {
        if isRefreshing { return }
        isRefreshing = true
        updatedLabel.stringValue = "更新中"
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = forceClaude ? ["node", self.scriptPath, "--refresh-claude"] : ["node", self.scriptPath]
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
                        self.updatedLabel.stringValue = "更新失敗"
                    }
                }
            } catch {
                DispatchQueue.main.async { self.isRefreshing = false; self.updatedLabel.stringValue = "更新失敗" }
            }
        }
    }

    private func updateUI(_ summary: UsageSummary) {
        let primary = summary.codex.rateLimits?.primary
        let secondary = summary.codex.rateLimits?.secondary
        let claude = summary.claude.official
        codexFivePercent.stringValue = formatPercent(remainingPercent(fromUsed: primary?.used_percent))
        codexWeekPercent.stringValue = formatPercent(remainingPercent(fromUsed: secondary?.used_percent))
        codexFiveReset.stringValue = formatReset(primary?.resets_at, compact: false)
        codexWeekReset.stringValue = formatReset(secondary?.resets_at, compact: true)
        claudeFivePercent.stringValue = formatPercent(remainingPercent(fromUsed: claude?.fiveHour?.usedPercent))
        claudeWeekPercent.stringValue = formatPercent(remainingPercent(fromUsed: claude?.weekAll?.usedPercent))
        claudeSonnetPercent.stringValue = formatPercent(remainingPercent(fromUsed: claude?.weekSonnet?.usedPercent))
        claudeFiveReset.stringValue = formatReset(claude?.fiveHour?.resetsAt, compact: false)
        claudeWeekReset.stringValue = formatReset(claude?.weekAll?.resetsAt, compact: true)
        claudeSonnetReset.stringValue = formatReset(claude?.weekSonnet?.resetsAt, compact: true)
        updatedLabel.stringValue = "上次 " + formatGeneratedAt(summary.generatedAt)
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
        formatter.dateFormat = compact ? "MMM d" : "h:mm a"
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

    private static func label(size: CGFloat, weight: NSFont.Weight, color: NSColor = .white) -> NSTextField {
        let label = NSTextField(labelWithString: "")
        label.font = NSFont.systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.backgroundColor = .clear
        label.isBordered = false
        label.lineBreakMode = .byTruncatingTail
        return label
    }
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
node --check "$INSTALL_DIR/scripts/usage-summary.js"

if [[ "${AGENT_USAGE_WIDGET_SKIP_LAUNCH:-0}" != "1" ]]; then
  "$INSTALL_DIR/run-widget.sh"

  uid="$(id -u)"
  launchctl bootout "gui/$uid/$APP_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid" "$LAUNCH_AGENT" >/dev/null 2>&1 || true
fi

echo "Installed Agent Usage Widget at $INSTALL_DIR"
echo "LaunchAgent: $LAUNCH_AGENT"
echo "如果 macOS 提示 Claude Safe Storage，請依你的安全偏好選擇「允許」或「永遠允許」。"
