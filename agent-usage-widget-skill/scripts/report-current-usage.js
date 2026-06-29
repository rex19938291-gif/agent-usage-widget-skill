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

function resetTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return "";
  const date = new Date(epochSeconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  const formatted = date.toLocaleString("zh-TW", sameDay
    ? { hour: "numeric", minute: "2-digit", hour12: false }
    : { month: "numeric", day: "numeric" });
  return `，重置 ${formatted}`;
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
  const lines = [
    `目前剩餘用量（上次更新 ${formatGeneratedAt(summary.generatedAt)}）`,
    "",
    "Codex",
    `- 5 小時：${percent(remainingPercentFromUsed(codexPrimary?.used_percent))}${resetTime(codexPrimary?.resets_at)}`,
    `- 1 週：${percent(remainingPercentFromUsed(codexSecondary?.used_percent))}${resetTime(codexSecondary?.resets_at)}`,
    "",
    "Claude",
    `- 5 小時：${percent(remainingPercentFromUsed(claude?.fiveHour?.usedPercent))}${resetTime(claude?.fiveHour?.resetsAt)}`,
    `- 1 週：${percent(remainingPercentFromUsed(claude?.weekAll?.usedPercent))}${resetTime(claude?.weekAll?.resetsAt)}`,
    `- Sonnet：${percent(remainingPercentFromUsed(claude?.weekSonnet?.usedPercent))}${resetTime(claude?.weekSonnet?.resetsAt)}`,
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
    raw = execFileSync("node", args, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
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
