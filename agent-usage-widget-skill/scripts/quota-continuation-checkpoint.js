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
    authorizations: [],
    notes: [],
    out: path.join(process.cwd(), "AGENT_QUOTA_CONTINUATION.md"),
    uninterrupted: false,
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
    } else if (key === "--authorization" && value) {
      args.authorizations.push(value);
      i += 1;
    } else if (key === "--source-thread" && value) {
      args.sourceThread = value;
      i += 1;
    } else if (key === "--target-thread" && value) {
      args.targetThread = value;
      i += 1;
    } else if (key === "--note" && value) {
      args.notes.push(value);
      i += 1;
    } else if (key === "--out" && value) {
      args.out = value;
      i += 1;
    } else if (key === "--uninterrupted" || key === "--continuous") {
      args.uninterrupted = true;
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
    "  --authorization <text>         Preserved task authorization note. Repeatable.",
    "  --source-thread <id>           Optional original/source thread id.",
    "  --target-thread <id>           Optional paused task thread id to resume.",
    "  --uninterrupted                Enable one-time wakeup prompt after explicit user request.",
    "  --continuous                   Alias for --uninterrupted.",
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
    "Quota recovery wakeup for an interrupted agent task in uninterrupted-development mode.",
    "",
    "Only use this prompt because the user explicitly requested uninterrupted or continuous development for this task.",
    "",
    `1. Read this checkpoint first: ${path.resolve(outPath)}`,
    `2. ${handoffLine}`,
    "3. Read the Authorization Envelope in this checkpoint and preserve approvals already granted for the same task.",
    "4. Confirm current quota with /agent-usage-widget-skill before resuming high-consumption work.",
    "5. If the relevant quota window is still under about 10%, update the checkpoint, create one new one-time wakeup for the next recovery time if the host supports it, then stop.",
    `6. If quota recovered and no new approval gate is active, continue from this next step: ${args.next}`,
    "7. If the next step appears to require approval, first check the original thread, handoff, and Authorization Envelope. Ask the user only when the action is outside the preserved scope or the host requires a tool-level approval.",
    "8. This wakeup is one-time; do not leave a recurring automation running after it fires.",
  ].join("\n");
}

function authorizationEnvelope(args) {
  const lines = [
    "This checkpoint resumes the same task, not a new task. Preserve the original task's authorization envelope from the source thread, target thread, task card, and durable handoff.",
    "",
    "Do not ask the user to re-approve actions already granted for this same task merely because the resume was delivered by a scheduler, automation, or another thread.",
  ];
  if (args.sourceThread) lines.push("", `Source thread: ${args.sourceThread}`);
  if (args.targetThread) lines.push(`Target thread: ${args.targetThread}`);
  lines.push("", "Preserved approvals:");
  if (args.authorizations.length) {
    for (const item of args.authorizations) lines.push(`- ${item}`);
  } else {
    lines.push("- Inspect the current thread, durable handoff, and task card for previously granted approvals before deciding an approval is missing.");
  }
  lines.push(
    "",
    "Still ask for explicit approval for new gates outside the preserved envelope, such as production changes, DNS/Cloudflare routes, deploys, public tunnels, credentials or token disclosure, sensitive/customer data, payment/order/invoice data, destructive commands, or new tool/package installs not already approved.",
    "",
    "Host-level sandbox, browser, filesystem, or network approval prompts are still authoritative; this checkpoint does not bypass the host's permission system."
  );
  return lines.join("\n");
}

function hostWakeupCompatibility() {
  return [
    "- Codex app: if and only if the user explicitly requested uninterrupted development and this checkpoint was created with `--uninterrupted`, use a one-time thread heartbeat. If resuming a different paused task thread, target that thread explicitly when the host supports `targetThreadId`.",
    "- Claude Code CLI: `claude --resume` or `claude --continue` can only resume Claude Code CLI sessions, and only from an explicit uninterrupted-development request plus a known session or working directory.",
    "- Claude Desktop app: this script cannot resume an existing Desktop app conversation. Use Claude Desktop's own supported wakeup, reminder, or bridge if one exists; otherwise use an external reminder and paste the Resume Prompt manually. Do not use Claude Code CLI commands or GUI automation as a public default for Desktop app conversations.",
    "- External scheduler: if no agent-host wakeup exists, use an external one-shot reminder or scheduler to notify the user to reopen Claude/Codex with the resume prompt. Do not install launchd/cron jobs without explicit user approval.",
    "- Manual fallback: open a new Claude Code or Codex session after `Resume after`, read this checkpoint, read the handoff, re-check quota, and continue from `Next Step`.",
  ].join("\n");
}

function automationGate(args) {
  if (args.uninterrupted) {
    return [
      "The user explicitly requested uninterrupted or continuous development for this task.",
      "",
      "A host scheduler may create exactly one wakeup for the `Resume after` time, using the One-Time Wakeup Automation Prompt below. The wakeup must re-check quota before doing high-consumption work and must stop after it runs.",
    ].join("\n");
  }
  return [
    "Default mode is checkpoint-only. The user has not explicitly requested uninterrupted or continuous development for this task.",
    "",
    "Do not create a scheduler, reminder, thread wakeup, cron job, LaunchAgent, GUI automation, or external runner from this checkpoint.",
    "",
    "After `Resume after`, wait for the user to reopen Claude/Codex or use an already-approved reminder. To enable a one-time wakeup in a future checkpoint, the user must explicitly request uninterrupted development and the agent must pass `--uninterrupted` or `--continuous`.",
  ].join("\n");
}

function buildMarkdown(args, usageResult, windows, resumeWindow) {
  const cwd = process.cwd();
  const gitStatus = safeReadGitStatus(cwd);
  const quotaLines = windows.map((item) => {
    const recovery = Number.isFinite(item.recoversAt) ? `; recovery-to-100% ${formatEpoch(item.recoversAt)}` : "; recovery-to-100% unknown";
    return `${item.label}: ${formatPercent(item.remaining)} remaining${recovery}`;
  });
  const wakeupSection = args.uninterrupted
    ? [
        "## One-Time Wakeup Automation Prompt",
        "",
        "The user explicitly requested uninterrupted or continuous development. If the current host supports thread wakeups, reminders, or one-time automations, schedule this prompt for the `Resume after` time. Do not create a noisy recurring automation.",
        "",
        "```text",
        buildWakeupPrompt(args, args.out),
        "```",
      ]
    : [
        "## Wakeup Automation",
        "",
        "Disabled. This checkpoint does not authorize creating a one-time wakeup because the user did not explicitly request uninterrupted or continuous development.",
      ];
  const lines = [
    "# Agent Quota Continuation Checkpoint",
    "",
    `Created: ${formatLocalDateTime(new Date())}`,
    `Task: ${args.task}`,
    `Working directory: ${cwd}`,
    `Preferred service: ${args.service}`,
    `Resume after: ${resumeWindow ? `${formatEpoch(resumeWindow.recoversAt)} (${resumeWindow.label})` : "unknown; check quota again before resuming"}`,
    `Automation mode: ${args.uninterrupted ? "uninterrupted development requested; one-time wakeup prompt enabled" : "checkpoint-only; wakeup automation disabled"}`,
    args.sourceThread ? `Source thread: ${args.sourceThread}` : null,
    args.targetThread ? `Target thread: ${args.targetThread}` : null,
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
    "## Automation Gate",
    "",
    automationGate(args),
    "",
    "## Authorization Envelope",
    "",
    authorizationEnvelope(args),
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
    ...wakeupSection,
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

  const wakeupPrompt = args.uninterrupted ? buildWakeupPrompt(args, outPath) : null;
  const result = {
    checkpoint: outPath,
    resumeAfter: resumeWindow ? formatEpoch(resumeWindow.recoversAt) : null,
    resumeWindow: resumeWindow?.label || null,
    automationEnabled: Boolean(args.uninterrupted),
    wakeupPrompt,
    usageAvailable: !usageResult.error,
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(`Wrote quota continuation checkpoint: ${outPath}`);
    if (result.resumeAfter) console.log(`Suggested resume after: ${result.resumeAfter} (${result.resumeWindow})`);
    if (!result.automationEnabled) console.log("One-time wakeup prompt disabled; pass --uninterrupted only after the user explicitly requests uninterrupted development.");
    if (!result.usageAvailable) console.log("Usage snapshot unavailable; check quota again before resuming.");
  }
}

main();
