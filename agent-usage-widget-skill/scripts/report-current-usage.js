#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = process.env.HOME || "";
const forceLive = process.argv.includes("--live") || process.argv.includes("--refresh-claude");
const jsonOutput = process.argv.includes("--json");
const debugOutput = process.argv.includes("--debug");

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

function remainingPercentFromUsed(used) {
  return Number.isFinite(used) ? Math.min(Math.max(100 - used, 0), 100) : null;
}

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "無法取得";
}

function recoveryText(epochSeconds, remainingPercent) {
  if (Number.isFinite(remainingPercent) && Math.round(remainingPercent) >= 100) return "，已是 100%";
  if (!Number.isFinite(epochSeconds)) return "，回復 100%：無法取得";
  const date = new Date(epochSeconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  const formatted = date.toLocaleString("zh-TW", sameDay
    ? { hour: "numeric", minute: "2-digit", hour12: false }
    : { month: "numeric", day: "numeric" });
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
    hour12: false,
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

function formatGeneratedAt(isoString) {
  const date = new Date(isoString);
  if (!Number.isFinite(date.getTime())) return "未知";
  return date.toLocaleString("zh-TW", { hour: "numeric", minute: "2-digit", hour12: false });
}

function buildReport(summary, source) {
  const codexPrimary = summary.codex?.rateLimits?.primary;
  const codexSecondary = summary.codex?.rateLimits?.secondary;
  const claude = summary.claude?.official;
  const codexPrimaryRemaining = remainingPercentFromUsed(codexPrimary?.used_percent);
  const codexSecondaryRemaining = remainingPercentFromUsed(codexSecondary?.used_percent);
  const claudeFiveRemaining = remainingPercentFromUsed(claude?.fiveHour?.usedPercent);
  const claudeWeekRemaining = remainingPercentFromUsed(claude?.weekAll?.usedPercent);
  const claudeSonnetRemaining = remainingPercentFromUsed(claude?.weekSonnet?.usedPercent);
  const lines = [
    "目前剩餘用量",
    `查詢時間：${formatLocalDateTime(new Date())}`,
    `資料生成：${formatGeneratedAt(summary.generatedAt)}`,
    "",
    "Codex",
    `- 5 小時：${percent(codexPrimaryRemaining)}${recoveryText(codexPrimary?.resets_at, codexPrimaryRemaining)}`,
    `- 1 週：${percent(codexSecondaryRemaining)}${recoveryText(codexSecondary?.resets_at, codexSecondaryRemaining)}`,
    "",
    "Claude",
    `- 5 小時：${percent(claudeFiveRemaining)}${recoveryText(claude?.fiveHour?.resetsAt, claudeFiveRemaining)}`,
    `- 1 週：${percent(claudeWeekRemaining)}${recoveryText(claude?.weekAll?.resetsAt, claudeWeekRemaining)}`,
    `- Sonnet：${percent(claudeSonnetRemaining)}${recoveryText(claude?.weekSonnet?.resetsAt, claudeSonnetRemaining)}`,
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

  const args = [summaryScript];
  if (forceLive) args.push("--refresh-claude");
  let raw;
  try {
    raw = execFileSync("node", args, {
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
