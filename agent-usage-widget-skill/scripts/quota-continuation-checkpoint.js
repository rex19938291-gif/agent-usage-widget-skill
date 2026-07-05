#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SCRIPT_DIR = __dirname;
const REPORT_SCRIPT = path.join(SCRIPT_DIR, "report-current-usage.js");

function parseArgs(argv) {
  const args = {
    service: "auto",
    task: "Unspecified task",
    next: "Resume from the latest handoff/checkpoint.",
    notes: [],
    out: path.join(process.cwd(), "AGENT_QUOTA_CONTINUATION.md"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--help" || key === "-h") {
      args.help = true;
    } else if (key === "--service" && value) {
      args.service = value;
      i += 1;
    } else if (key === "--task" && value) {
      args.task = value;
      i += 1;
    } else if (key === "--handoff" && value) {
      args.handoff = value;
      i += 1;
    } else if (key === "--next" && value) {
      args.next = value;
      i += 1;
    } else if (key === "--note" && value) {
      args.notes.push(value);
      i += 1;
    } else if (key === "--out" && value) {
      args.out = value;
      i += 1;
    } else if (key === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${key}`);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node <skill-folder>/scripts/quota-continuation-checkpoint.js --task <text> --next <text> [options]",
    "",
    "Options:",
    "  --service auto|codex|claude   Which quota family to prioritize in the resume hint.",
    "  --handoff <path>               Durable handoff file the next agent should read.",
    "  --note <text>                  Extra checkpoint note. Repeatable.",
    "  --out <path>                   Markdown checkpoint output path.",
    "  --json                         Print machine-readable result.",
  ].join("\n");
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

function readUsageSummary() {
  try {
    const raw = execFileSync("node", [REPORT_SCRIPT, "--json"], {
      encoding: "utf8",
      env: sanitizedEnv(),
      timeout: 17000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { summary: JSON.parse(raw), error: null };
  } catch (error) {
    return { summary: null, error: error?.message || String(error) };
  }
}

function remainingFromUsed(used) {
  if (!Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, 100 - used));
}

function windowsFromSummary(summary) {
  if (!summary) return [];
  const codex = summary.codex?.rateLimits || {};
  const claude = summary.claude?.official || {};
  return [
    {
      service: "codex",
      label: "Codex 5 hour",
      remaining: remainingFromUsed(codex.primary?.used_percent),
      recoversAt: codex.primary?.resets_at,
    },
    {
      service: "codex",
      label: "Codex 1 week",
      remaining: remainingFromUsed(codex.secondary?.used_percent),
      recoversAt: codex.secondary?.resets_at,
    },
    {
      service: "claude",
      label: "Claude 5 hour",
      remaining: remainingFromUsed(claude.fiveHour?.usedPercent),
      recoversAt: claude.fiveHour?.resetsAt,
    },
    {
      service: "claude",
      label: "Claude 1 week",
      remaining: remainingFromUsed(claude.weekAll?.usedPercent),
      recoversAt: claude.weekAll?.resetsAt,
    },
    {
      service: "claude",
      label: "Claude Sonnet",
      remaining: remainingFromUsed(claude.weekSonnet?.usedPercent),
      recoversAt: claude.weekSonnet?.resetsAt,
    },
  ];
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "unknown";
}

function formatLocalDateTime(date = new Date()) {
  if (!Number.isFinite(date.getTime())) return "unknown";
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

function formatEpoch(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return "unknown";
  return formatLocalDateTime(new Date(epochSeconds * 1000));
}

function chooseResumeWindow(windows, service) {
  const candidates = windows
    .filter((item) => service === "auto" || item.service === service)
    .filter((item) => Number.isFinite(item.recoversAt))
    .filter((item) => !Number.isFinite(item.remaining) || item.remaining < 100)
    .sort((a, b) => {
      const ar = Number.isFinite(a.remaining) ? a.remaining : -1;
      const br = Number.isFinite(b.remaining) ? b.remaining : -1;
      if (ar !== br) return ar - br;
      return a.recoversAt - b.recoversAt;
    });
  return candidates[0] || null;
}

function safeReadGitStatus(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "status", "--short"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function markdownList(items) {
  if (!items.length) return "- none";
  return items.map((item) => `- ${item}`).join("\n");
}

function buildWakeupPrompt(args, outPath) {
  const handoffLine = args.handoff
    ? `Then read the durable handoff: ${args.handoff}`
    : "Then locate and read the nearest durable project handoff if one exists.";
  return [
    "Quota recovery wakeup for an interrupted agent task.",
    "",
    `1. Read this checkpoint first: ${path.resolve(outPath)}`,
    `2. ${handoffLine}`,
    "3. Confirm current quota with /agent-usage-widget-skill before resuming high-consumption work.",
    "4. If the relevant quota window is still under about 10%, update the checkpoint, create one new one-time wakeup for the next recovery time if the host supports it, then stop.",
    `5. If quota recovered and no approval gate is active, continue from this next step: ${args.next}`,
    "6. If the next step requires user approval, notify the user and stop.",
    "7. This wakeup is one-time; do not leave a recurring automation running after it fires.",
  ].join("\n");
}

function hostWakeupCompatibility() {
  return [
    "- Codex app: use a one-time thread heartbeat. If resuming a different paused task thread, target that thread explicitly when the host supports `targetThreadId`.",
    "- Claude Code / Claude Desktop: use Claude's own wakeup, reminder, or scheduler feature if the host exposes one. A Codex heartbeat cannot directly inject a follow-up into a Claude conversation.",
    "- External scheduler: if no agent-host wakeup exists, use an external one-shot reminder or scheduler to notify the user to reopen Claude/Codex with the resume prompt. Do not install launchd/cron jobs without explicit user approval.",
    "- Manual fallback: open a new Claude Code or Codex session after `Resume after`, read this checkpoint, read the handoff, re-check quota, and continue from `Next Step`.",
  ].join("\n");
}

function buildMarkdown(args, usageResult, windows, resumeWindow) {
  const cwd = process.cwd();
  const gitStatus = safeReadGitStatus(cwd);
  const quotaLines = windows.map((item) => {
    const recovery = Number.isFinite(item.recoversAt) ? `; recovery-to-100% ${formatEpoch(item.recoversAt)}` : "; recovery-to-100% unknown";
    return `${item.label}: ${formatPercent(item.remaining)} remaining${recovery}`;
  });
  const lines = [
    "# Agent Quota Continuation Checkpoint",
    "",
    `Created: ${formatLocalDateTime(new Date())}`,
    `Task: ${args.task}`,
    `Working directory: ${cwd}`,
    `Preferred service: ${args.service}`,
    `Resume after: ${resumeWindow ? `${formatEpoch(resumeWindow.recoversAt)} (${resumeWindow.label})` : "unknown; check quota again before resuming"}`,
    args.handoff ? `Handoff: ${args.handoff}` : "Handoff: not provided",
    "",
    "## Quota Snapshot",
    "",
    usageResult.error ? `Usage read error: ${usageResult.error}` : markdownList(quotaLines),
    "",
    "## Next Step",
    "",
    args.next,
    "",
    "## Notes",
    "",
    markdownList(args.notes),
    "",
    "## Local Git Status",
    "",
    gitStatus ? "```text\n" + gitStatus + "\n```" : "No git status output or not a git checkout.",
    "",
    "## Resume Prompt",
    "",
    "```text",
    `Continue this interrupted task after quota recovery. Read this checkpoint first: ${path.resolve(args.out)}`,
    args.handoff ? `Then read the durable handoff: ${args.handoff}` : "Then locate and read the nearest durable project handoff if one exists.",
    "Confirm current quota with /agent-usage-widget-skill before resuming high-consumption work.",
    `Continue from this next step: ${args.next}`,
    "Do not redo completed work unless current files or verification show it is stale.",
    "```",
    "",
    "## Optional One-Time Wakeup Automation Prompt",
    "",
    "If the current host supports thread wakeups, reminders, or one-time automations, schedule this prompt for the `Resume after` time. Do not create a noisy recurring automation.",
    "",
    "```text",
    buildWakeupPrompt(args, args.out),
    "```",
    "",
    "## Host Wakeup Compatibility",
    "",
    hostWakeupCompatibility(),
    "",
    "Do not commit this checkpoint publicly without reviewing it for local paths or project details.",
  ];
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!["auto", "codex", "claude"].includes(args.service)) {
    throw new Error("--service must be auto, codex, or claude");
  }

  const usageResult = readUsageSummary();
  const windows = windowsFromSummary(usageResult.summary);
  const resumeWindow = chooseResumeWindow(windows, args.service);
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildMarkdown({ ...args, out: outPath }, usageResult, windows, resumeWindow), { mode: 0o600 });

  const wakeupPrompt = buildWakeupPrompt(args, outPath);
  const result = {
    checkpoint: outPath,
    resumeAfter: resumeWindow ? formatEpoch(resumeWindow.recoversAt) : null,
    resumeWindow: resumeWindow?.label || null,
    wakeupPrompt,
    usageAvailable: !usageResult.error,
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(`Wrote quota continuation checkpoint: ${outPath}`);
    if (result.resumeAfter) console.log(`Suggested resume after: ${result.resumeAfter} (${result.resumeWindow})`);
    if (!result.usageAvailable) console.log("Usage snapshot unavailable; check quota again before resuming.");
  }
}

main();
