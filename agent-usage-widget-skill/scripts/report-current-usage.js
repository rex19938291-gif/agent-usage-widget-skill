#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = process.env.HOME || "";
const forceLive = process.argv.includes("--live") || process.argv.includes("--refresh-claude");
const jsonOutput = process.argv.includes("--json");
const debugOutput = process.argv.includes("--debug");

// The packaged .app keeps usage-summary.js and its own node side by side in Resources/,
// mirroring what main.swift resolves through Bundle.main.resourceURL. A .pkg lands in
// /Applications; a .dmg dragged by a non-admin can land in ~/Applications.
function packagedResourceDirs() {
  const dirs = ["/Applications"];
  if (HOME) dirs.push(path.join(HOME, "Applications"));
  return dirs.map((dir) =>
    path.join(dir, "AgentUsageWidget.app", "Contents", "Resources")
  );
}

function candidateSummaryScripts() {
  const candidates = [];
  if (process.env.AGENT_USAGE_WIDGET_SUMMARY) {
    candidates.push(process.env.AGENT_USAGE_WIDGET_SUMMARY);
  }
  if (process.env.AGENT_USAGE_WIDGET_DIR) {
    candidates.push(path.join(process.env.AGENT_USAGE_WIDGET_DIR, "scripts", "usage-summary.js"));
  }
  if (HOME) {
    candidates.push(path.join(HOME, ".agent-usage-widget", "scripts", "usage-summary.js"));
    candidates.push(path.join(HOME, "agent-usage-widget", "scripts", "usage-summary.js"));
  }
  for (const dir of packagedResourceDirs()) {
    candidates.push(path.join(dir, "usage-summary.js"));
  }
  return [...new Set(candidates)];
}

function findSummaryScript() {
  return candidateSummaryScripts().find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

// Never resolve `node` from PATH: the Claude usage endpoint rejects some builds outright
// (node 25 gets HTTP 403 where node 20/22 get 200), so reuse the interpreter the installer
// verified. Falls back to the one running this script, which is at least known to exist.
function resolveNodeBinary(summaryScript) {
  const candidates = [process.env.AGENT_USAGE_WIDGET_NODE];
  if (summaryScript) {
    const recorded = path.join(path.dirname(path.dirname(summaryScript)), "node-path");
    try {
      candidates.push(fs.readFileSync(recorded, "utf8").trim());
    } catch {}
    // Packaged channel: the vetted node sits next to the summary script in Resources/ and
    // there is no node-path file. Without this, a packaged install would fall through to
    // process.execPath — which may well be a build the Claude endpoint answers with 403.
    candidates.push(path.join(path.dirname(summaryScript), "node"));
  }
  candidates.push(process.execPath);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return "node";
}

function remainingPercentFromUsed(used) {
  return Number.isFinite(used) ? Math.min(Math.max(100 - used, 0), 100) : null;
}

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "無法取得";
}

function recoveryText(epochSeconds, remainingPercent, preferReset = false) {
  if (preferReset) {
    if (!Number.isFinite(epochSeconds)) return "，回復 100%：無法取得";
    return `，回復 100%：${formatLocalDateTime(new Date(epochSeconds * 1000))}`;
  }
  if (Number.isFinite(remainingPercent) && Math.round(remainingPercent) >= 100) return "，已是 100%";
  if (!Number.isFinite(epochSeconds)) return "，回復 100%：無法取得";
  const date = new Date(epochSeconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  const formatted = date.toLocaleString("zh-TW", sameDay
    ? { hour: "numeric", minute: "2-digit", hourCycle: "h23" }
    : { month: "2-digit", day: "2-digit" });
  return `，回復 100%：${formatted}`;
}

function formatLocalDateTime(date = new Date()) {
  if (!Number.isFinite(date.getTime())) return "未知";
  const parts = new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    // hourCycle rather than hour12: with hour12 present ICU ignores hourCycle and
    // renders midnight as 24:00 in zh-TW.
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

function formatGeneratedAt(isoString) {
  const date = new Date(isoString);
  if (!Number.isFinite(date.getTime())) return "未知";
  return date.toLocaleString("zh-TW", { hour: "numeric", minute: "2-digit", hourCycle: "h23" });
}

// Codex rate-limit snapshots are written only while the Codex CLI runs — the desktop app
// keeps its own in memory — so a reading can be hours old and disagree with the app.
// State the age rather than passing a stale number off as current.
function codexAgeNote(...windows) {
  const stamps = windows.map((w) => w?.observed_at).filter((v) => Number.isFinite(v));
  if (!stamps.length) return "";
  const ageMs = Date.now() - Math.max(...stamps) * 1000;
  if (ageMs <= 15 * 60 * 1000) return "";
  const minutes = Math.round(ageMs / 60000);
  if (minutes < 60) return `（${minutes} 分鐘前資料）`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `（${hours} 小時前資料）`;
  return `（${Math.round(hours / 24)} 天前資料）`;
}

function buildReport(summary, source) {
  const codexPrimary = summary.codex?.rateLimits?.primary;
  const codexSecondary = summary.codex?.rateLimits?.secondary;
  const claude = summary.claude?.official;
  const codexPrimaryRemaining = remainingPercentFromUsed(codexPrimary?.used_percent);
  const codexSecondaryRemaining = remainingPercentFromUsed(codexSecondary?.used_percent);
  const claudeFiveRemaining = remainingPercentFromUsed(claude?.fiveHour?.usedPercent);
  const claudeWeekRemaining = remainingPercentFromUsed(claude?.weekAll?.usedPercent);
  // The weekly per-model window is whatever the plan scopes it to (Fable, Sonnet, ...),
  // so both the value and its label come from the data. weekSonnet is the older shape.
  const claudeScoped = claude?.weekScoped || claude?.weekSonnet;
  const claudeScopedRemaining = remainingPercentFromUsed(claudeScoped?.usedPercent);
  const claudeScopedLabel = claude?.weekScoped?.label || "Sonnet";
  const lines = [
    "目前剩餘用量",
    `查詢時間：${formatLocalDateTime(new Date())}`,
    `資料生成：${formatGeneratedAt(summary.generatedAt)}`,
    "",
    `Codex${codexAgeNote(codexPrimary, codexSecondary)}`,
    // "no such window on this plan" is a different fact from "could not read it"; the live
    // endpoint reports the absent window explicitly, so don't blur them into 無法取得.
    summary.codex?.official?.available === true && !summary.codex.official.fiveHour
      ? "- 5 小時：此方案無此限制"
      : `- 5 小時：${percent(codexPrimaryRemaining)}${recoveryText(codexPrimary?.resets_at, codexPrimaryRemaining, true)}`,
    `- 1 週：${percent(codexSecondaryRemaining)}${recoveryText(codexSecondary?.resets_at, codexSecondaryRemaining)}`,
    "",
    "Claude",
    `- 5 小時：${percent(claudeFiveRemaining)}${recoveryText(claude?.fiveHour?.resetsAt, claudeFiveRemaining, true)}`,
    `- 1 週：${percent(claudeWeekRemaining)}${recoveryText(claude?.weekAll?.resetsAt, claudeWeekRemaining, true)}`,
    `- ${claudeScopedLabel}：${percent(claudeScopedRemaining)}${recoveryText(claudeScoped?.resetsAt, claudeScopedRemaining, true)}`,
  ];
  if (forceLive && summary.claude?.official?.cache === "stale") {
    lines.push("", "Claude 即時刷新暫時失敗，已改用小工具最近一次快取資料。");
  }
  if (debugOutput) {
    lines.push("", `來源：${source}`);
    if (!forceLive) lines.push("模式：讀取小工具快取，不強制刷新 Claude Keychain/API。");
  }
  return lines.join("\n");
}

function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GITHUB_PAT_TOKEN",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
  ]) {
    delete env[key];
  }
  return env;
}

function main() {
  const summaryScript = findSummaryScript();
  if (!summaryScript) {
    console.log([
      "尚未找到 Agent Usage Widget 的本機用量資料來源。",
      "",
      "請先在這台 Mac 安裝小工具，或確認 Codex 執行環境可以讀取同一個 macOS 使用者的 $HOME。",
      "手機上的對話可以呼叫 skill，但如果實際執行環境不是這台 Mac，就無法讀到這台 Mac 的 Claude Keychain/session。",
    ].join("\n"));
    process.exit(2);
  }

  // A quota query should read only quota/cache data. Scanning the full Claude and Codex
  // conversation histories can exceed this wrapper's timeout and is unnecessary here.
  const args = [summaryScript, "--quota-only"];
  if (forceLive) args.push("--refresh");
  let raw;
  try {
    raw = execFileSync(resolveNodeBinary(summaryScript), args, {
      encoding: "utf8",
      env: sanitizedEnv(),
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    console.log(`讀取目前用量失敗：${error?.message || String(error)}`);
    process.exit(1);
  }
  const summary = JSON.parse(raw);
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${buildReport(summary, summaryScript)}\n`);
}

main();
