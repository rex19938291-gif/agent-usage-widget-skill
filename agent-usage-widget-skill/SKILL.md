---
name: agent-usage-widget-skill
description: Install, maintain, and query a local macOS desktop widget that shows Claude and Codex quota availability. Use in Claude Code, Codex, or compatible Agent Skills clients when a user invokes /agent-usage-widget-skill, asks for current remaining Claude/Codex usage percentages, asks when usage recovers to 100%, wants a quota-recovery continuation checkpoint after interruption, or wants to install, update, troubleshoot, auto-start, uninstall, or package a Mac desktop usage monitor. 也適用於想在 Mac 桌面查看或直接詢問 Claude / Codex 剩餘可用額度百分比、回復 100% 時間、額度用完後如何接續任務、設定開機自動啟動、或排查 macOS Keychain 提示時。
---

# Agent Usage Widget

Use this skill to query, install, or update a local-only macOS desktop widget that shows Claude and Codex quota availability.

繁體中文重點：這個 skill 會替使用者安裝一個 macOS 桌面小工具，用百分比呈現 Claude 與 Codex 的可用額度與回復 100% 時間。它只讀取本機資料；Claude 官方百分比優先使用本機既有的長效登入，在記憶體中查詢官方額度或極小請求的回應標頭；桌面版登入僅作備援。不得輸出、保存、提交 cookie、token、org ID 或 Keychain secret，也不得傳送給 Claude 官方 API 以外的第三方。

## Agent Compatibility

This skill follows the Agent Skills folder pattern: `SKILL.md` is the entrypoint, `scripts/` contains executable helpers, and `agents/openai.yaml` contains Codex/OpenAI UI metadata. It is usable from Claude Code, Codex, and other compatible agents that can read a skill folder and run local scripts with user approval.

Use `<skill-folder>` to mean the directory containing this `SKILL.md`. In Claude Code, this is the installed skill directory such as `$HOME/.claude/skills/agent-usage-widget-skill`; in Codex, it is the installed skill directory such as `$HOME/.codex/skills/agent-usage-widget-skill`.

Do not assume shell commands are pre-approved. Ask for or rely on the host's normal approval flow before running installer, Keychain, LaunchAgent, GUI-launch, or uninstall commands.

## 使用情境

- 使用者想在桌面左上角查看 Claude / Codex 可用額度。
- 使用者在手機或電腦的 Codex 對話輸入 `/agent-usage-widget-skill`，想直接知道目前剩餘幾％。
- 使用者想用百分比而不是 token 數呈現額度。
- 使用者想在額度低、額度用完、任務中斷前，建立可讓 Claude Code 或 Codex 之後接續的 checkpoint。
- 使用者想設定開機自動啟動。
- 使用者遇到 `Claude Safe Storage` 的 macOS Keychain 提示，需要你解釋 `允許` / `永遠允許` 的差異。
- 使用者想更新、排查或移除這個本機小工具。

## Default Skill Behavior

When the user invokes `/agent-usage-widget-skill` without asking to install, update, or uninstall, report the current remaining usage percentages and recovery-to-100% timing first.

Run:

```bash
node <skill-folder>/scripts/report-current-usage.js
```

Then summarize the output in Traditional Chinese. Do not expose raw JSON unless the user asks.

Important: the default slash query should not force a Claude live refresh. It should read the widget's local cache, because the desktop widget already refreshes Claude official usage every 60 seconds. This avoids false "Claude read failed" messages in mobile/background Codex sessions where macOS Keychain prompts cannot be handled.

If the command says the widget data source is unavailable, explain briefly:

- The query only works in a Codex environment that can read the same Mac user's `$HOME`.
- Claude live percentages require an existing long-lived Claude Code login available through `launchctl getenv CLAUDE_CODE_OAUTH_TOKEN`, or the Desktop cookie fallback and access to `Claude Safe Storage`.
- On a phone, the chat UI can trigger the skill, but the actual read still happens wherever Codex is executing. If that is not this Mac, it cannot see this Mac's local session.

For an explicit live refresh, only when the user asks for it, run:

```bash
node <skill-folder>/scripts/report-current-usage.js --live
```

## Quota Recovery Continuation

No skill can guarantee that an offline or rate-limited agent will automatically wake itself up later unless the host product also provides a scheduler, reminder, or automation. The safe default is checkpoint-only recovery: checkpoint the task before stopping, record the recovery time, and give the next agent a restart prompt.

Do not create a wakeup automation by default. Only enable a one-time wakeup when the user explicitly asks for uninterrupted or continuous development, for example `不間斷開發`, `不中斷續跑`, `keep working after quota recovers`, or `continuous development`. A normal quota query, normal install, or ordinary long-task checkpoint is not enough consent to schedule a wakeup.

Use checkpoint-only mode when quota is very low, quota is exhausted, a long task is likely to cross a quota window, or the user asks how to continue after quota recovery.

1. Run the normal quota report first.
2. If the active quota window is under about `10%`, stop high-consumption actions such as browser screenshot matrices, large imports/exports, package installs, or broad multi-agent work.
3. Write a local checkpoint with:

```bash
node <skill-folder>/scripts/quota-continuation-checkpoint.js \
  --service auto \
  --task "<current task name>" \
  --handoff "<path to TASK_HANDOFF.md or project handoff, if any>" \
  --next "<single concrete next step>" \
  --authorization "<approval already granted for this same task, if any>"
```

4. Tell the user the checkpoint path and the suggested `Resume after` time from the command output.
5. The default checkpoint must not include a wakeup prompt. If the user explicitly requested uninterrupted or continuous development, create the checkpoint with `--uninterrupted` or `--continuous`, then use the generated `One-Time Wakeup Automation Prompt`.
6. If the host provides thread wakeups, reminders, or one-time automations, and the checkpoint was created with `--uninterrupted`, create exactly one wakeup for the `Resume after` time. In Codex app, prefer a thread heartbeat attached to the current thread; if resuming a different paused task thread, explicitly target that task thread when the host supports it. In Claude Code or Claude Desktop, use Claude's own wakeup/reminder/scheduler feature if available. Do not hand-write raw scheduler config; use the host-provided automation/reminder tool.
7. The wakeup prompt must check quota again before continuing. If quota is still under about `10%`, it should update the checkpoint and create one new one-time wakeup for the next recovery time only if uninterrupted mode is still explicitly in scope, then stop.
8. The wakeup prompt must preserve the original task's authorization envelope. If the same task thread, task card, or handoff already records approval for the next action, do not ask the user to approve the same action again merely because this is a resumed turn. Ask only when the action is outside the preserved scope or the host requires a tool-level approval.
9. After the wakeup fires, it must end as a one-time run. Do not leave a recurring automation running unless the user explicitly asks for recurring monitoring.
10. If no host wakeup/reminder exists, ask the user to reopen Claude/Codex after the `Resume after` time and paste/use the checkpoint's resume prompt.

The default checkpoint path is `AGENT_QUOTA_CONTINUATION.md` in the current working directory. It may contain local paths and task details, so do not commit it publicly without review.

Keep this separation clear: the widget reports quota state and writes the checkpoint; the host scheduler owns waking an agent or notifying the user. Without a scheduler, the mechanism is resumable but not automatic.

Uninterrupted mode example:

```bash
node <skill-folder>/scripts/quota-continuation-checkpoint.js \
  --service auto \
  --task "<current task name>" \
  --handoff "<path to TASK_HANDOFF.md or project handoff, if any>" \
  --next "<single concrete next step>" \
  --uninterrupted
```

### Preserve The Task Authorization Envelope

Quota recovery resumes the same task. It should not silently shrink the task's approved scope.

When creating a checkpoint, include repeatable `--authorization` notes for approvals already granted in the active task, for example:

```bash
node <skill-folder>/scripts/quota-continuation-checkpoint.js \
  --service codex \
  --task "Local visual parity task" \
  --handoff "/path/to/TASK_HANDOFF.md" \
  --next "Run the already-approved narrow visual verifier" \
  --target-thread "<paused task thread id if known>" \
  --authorization "Side Browser / Browser / Chrome visual verification is already approved for this task" \
  --authorization "Work is limited to the local test site; no production deploy"
```

On resume, the agent must first read the checkpoint's `Authorization Envelope`, then the original thread or durable handoff when available. Do not re-ask for approvals that are already inside that envelope. Still stop for genuinely new gates such as production, DNS, deploys, public tunnels, credential disclosure, sensitive/customer data, payment/order/invoice data, destructive commands, or new tool/package installs that were not previously approved. Host-level permission prompts remain authoritative and cannot be bypassed by a checkpoint.

### Claude Code Notes

For Claude-focused work, prefer `--service claude` so the checkpoint's `Resume after` time prioritizes Claude quota windows:

```bash
node "$HOME/.claude/skills/agent-usage-widget-skill/scripts/quota-continuation-checkpoint.js" \
  --service claude \
  --task "<current Claude Code task name>" \
  --handoff "<path to TASK_HANDOFF.md or project handoff, if any>" \
  --next "<single concrete next step>"
```

If Claude's host does not expose a wakeup/reminder/scheduler, the checkpoint is still useful but not automatic: the user or an external scheduler must reopen Claude Code after `Resume after` and ask it to read `AGENT_QUOTA_CONTINUATION.md`. Codex app heartbeat automations can resume Codex threads, but they cannot directly post into a Claude conversation unless Claude exposes a supported bridge.

Claude Desktop app conversations are different from Claude Code CLI sessions. `claude --resume` and `claude --continue` do not resume an existing Claude Desktop app conversation. For a task started in Claude Desktop, use Claude Desktop's own supported scheduler/bridge if one exists; otherwise use a reminder/manual paste workflow from the checkpoint. Do not use GUI automation or Claude Code CLI commands as the public default for Desktop app recovery.

When a local Claude Code CLI is available, and the user explicitly requested uninterrupted or continuous development, an external one-shot scheduler may use Claude itself as the executor after quota recovers. Prefer resuming the exact session when known:

```bash
claude --resume "<session-id>" --print "Continue the interrupted task. Read <checkpoint> first, preserve its Authorization Envelope, re-check quota, then continue."
```

If the original Claude task is the most recent conversation in the same working directory, use:

```bash
cd "<original working directory>"
claude --continue --print "Continue the interrupted task. Read <checkpoint> first, preserve its Authorization Envelope, re-check quota, then continue the original task without re-asking for already-granted approvals."
```

Do not use `--dangerously-skip-permissions` for quota recovery. Host-level permission prompts remain authoritative. If neither exact session id nor working directory is known, start a new Claude Code session from the checkpoint instead of guessing the wrong conversation.

## What To Install

There are two installation channels, and **checking which one is in use comes first**.
Running the source installer on a machine that already has the packaged app produces two
parallel installs fighting over one LaunchAgent label:

```bash
[ -d /Applications/AgentUsageWidget.app ] && echo packaged || echo not-packaged
```

**Packaged** (installed from `.dmg` / `.pkg`) — the app carries its own Node and its own copy
of `usage-summary.js`. Do **not** run the source installer. Everything is available either
from the widget's right-click menu or as a command:

```bash
A=/Applications/AgentUsageWidget.app/Contents/MacOS/AgentUsageWidget
"$A" --status               # resolved node/script paths, language, login-item state
"$A" --enable-login-item    # or --disable-login-item
"$A" --install-skill        # refresh this skill from the app bundle
"$A" --check-layout         # verify no label overflows its column in either language
```

**Source** — run the bundled installer, which compiles with `swiftc` and probes for a usable
Node:

```bash
bash <skill-folder>/scripts/install-agent-usage-widget.sh
```

It writes the app to `$HOME/.agent-usage-widget` and creates a user LaunchAgent at
`$HOME/Library/LaunchAgents/com.agentusage.widget.plist`. The packaged channel uses the same
LaunchAgent label but points it at `/Applications`.

## Data Sources

Both services prefer official observations and retain bounded local fallbacks.

- Codex: `https://chatgpt.com/backend-api/codex/usage`, using the existing local login.
- Codex fallback: enumerate `rollout-*.jsonl` metadata throughout the session tree,
  retaining the five newest files modified within two days, including resumed conversations
  created on older dates. Above 5000 files, restrict metadata lookup to the last 30 calendar
  days of creation directories. Read backward to the last valid
  `token_count.rate_limits` event per file, and compare event observation times with any
  usable official observation. Label recorded observations with their time. Never scan
  the full session history contents for a quota report or mix windows across different events.
- Claude: read the existing long-lived login via `launchctl getenv CLAUDE_CODE_OAUTH_TOKEN`
  in memory only. Try `https://api.anthropic.com/api/oauth/usage`; if unavailable, send one
  minimal `claude-haiku-4-5` request (`max_tokens: 1`) to the official `/v1/messages`
  service. Read unified usage/reset headers even on non-200 responses. This minimal
  request consumes a small amount of quota and requires the user's authorization.
- The entire Claude long-lived polling cycle is capped at once per ten minutes, including
  failures. Before any network cycle, persist a unique attempt ID and in-progress state;
  commit the matching ID to the percentage cache before marking the state succeeded. Persist
  only IDs, state and attempt times in the existing cache directory; cache
  percentages/timestamps and retain the scoped model label with unknown numbers when
  that source lacks model-specific usage. No credential refresh or Keychain writes.
- Each Claude window needs a valid future reset before its percentage can be used,
  including cached header observations. Adopt a percentage only when its ID matches a
  succeeded state. Missing, broken, failed or in-progress state means unknown; even the
  previous success stays unknown throughout a new attempt, to survive failed terminal writes.
  Cache-only reads confirm replacement of the actual state file under the same short lock;
  unrelated writable files cannot prove this works. Claim write failure prevents all network
  requests and invalidates in place where possible, then falls back to clearing/removing
  the old cache. Attempt ownership prevents older completions from overwriting newer results.
  Observation timestamps allow at most five seconds of future skew (also enforced in Swift).
  Cookie observations retain their three-minute cache lifetime; their refresh cannot bypass
  the separate ten-minute limit on long-lived requests. No credential is persisted.
- Claude final fallback: the existing Desktop cookie store and `Claude Safe Storage`,
  sent only to `https://claude.ai/api/organizations/<org_uuid>/usage`.

Windows are identified by their **duration**, never by their position in the response.
Neither API keeps a fixed slot per window: on a Codex plan with no 5-hour limit,
`primary_window` is the weekly one and `secondary_window` is null.

## 顯示方式

- Codex：`5 小時` 與 `1 週`。若方案本身沒有 5 小時視窗，顯示「此方案無此限制」，不要顯示為讀取失敗。
- Claude：`5 小時`、`1 週`，以及方案綁定的單一模型週視窗。該模型名稱由 API 決定（例如 `Fable` 或 `Sonnet`），不可寫死。
- 百分比代表**可用**額度，不是已使用額度。
- 對話查詢應同時顯示查詢時間、資料生成時間，以及各窗口回復 100% 的日期與時間。Claude 的 `5 小時`、`1 週`、模型週視窗只要官方提供 `resetsAt`，右欄一律顯示 `MM/dd HH:mm`，即使百分比是 100% 也不得用「已是 100%」取代。官方沒有 active session／`resetsAt` 時才顯示無法取得，不得用「現在加五小時」或其他推算值猜測。
- 小工具本身支援繁體中文與英文（右鍵選單切換，預設跟隨系統語言）。面板是固定像素格線，
  較長的字串會被靜默截斷成 `…` 而不是換行；改動任何面板字串後要跑 `--check-layout` 確認。
- 小工具維持低干擾桌面層級；一般 App 視窗可以覆蓋它。只有右上角的重新整理圖示可點擊，其餘區域點擊穿透。
- 每 60 秒自動刷新，使用者也可點右上角圖示立即刷新。

## Safety Rules

- Do not print, log, cache, or save Claude cookies, organization IDs, Keychain secrets, or
  the Codex OAuth tokens in `$HOME/.codex/auth.json`.
- Send that login material only to the documented official usage service or authorized
  minimal messages request, never to any third party. Disable redirects on bearer requests.
- Cache only non-sensitive usage percentages and timestamps.
- Use `$HOME` and runtime discovery. Do not hard-code a developer's username, absolute home path, LaunchAgent label, org ID, PID, or local project path.
- Keep the public skill free of `allowed-tools` preapprovals or dynamic shell injection unless a maintainer deliberately reviews and accepts that broader trust model.
- When spawning child Node processes from an agent session, avoid forwarding common agent/API token environment variables.
- Treat quota checkpoints as local private handoffs. Do not put raw credentials, customer data, private screenshots, or unreviewed sensitive logs into them.
- Before publishing or committing, scan the skill for private paths, tokens, cache files, screenshots, and handoff files.

## User Prompts To Explain

If macOS asks whether `security` may access `Claude Safe Storage`, explain:

- `允許` permits this one access.
- `永遠允許` prevents repeated prompts during automatic refresh.
- The risk is local: any process running as the same macOS user that can call `/usr/bin/security` may be able to read that Keychain item.

繁體中文建議說法：

`永遠允許` 的好處是每分鐘自動刷新時不會一直跳 Keychain 提示；風險是 `/usr/bin/security` 這個本機工具之後可以讀取該 Keychain 項目。若這台 Mac 是你信任且自己使用的裝置，通常可以接受；若是共用或不完全信任的環境，就選 `允許` 或 `拒絕`。

## Verification

After install or update, run:

Packaged install:

```bash
A=/Applications/AgentUsageWidget.app
launchctl list | grep com.agentusage.widget
"$A/Contents/Resources/node" "$A/Contents/Resources/usage-summary.js" \
  --quota-only --refresh --text
```

Source install:

```bash
bash "$HOME/.agent-usage-widget/run-widget.sh"
launchctl list | grep com.agentusage.widget
"$(cat "$HOME/.agent-usage-widget/node-path")" \
  "$HOME/.agent-usage-widget/scripts/usage-summary.js" --quota-only --refresh --text
```

After a source update, also inspect the live executable path. An older checkout can leave an
`AgentUsageWidget` process running; `run-widget.sh` then sees the shared process name and exits
without starting the newly installed copy. The accepted path must start with
`$HOME/.agent-usage-widget/`:

```bash
ps -axo pid=,command= | grep '[A]gentUsageWidget.app/Contents/MacOS/AgentUsageWidget'
```

If the only live path is another checkout, stop that specific old PID, run
`$HOME/.agent-usage-widget/run-widget.sh` once, and inspect the process path again. Do not report
the update as active merely because the installer printed `Installed Agent Usage Widget`.

Never invoke a bare `node` from PATH. Use the interpreter the install recorded — `node-path`
for a source install, the bundled binary for a packaged one. The Claude endpoint rejects some
Node builds outright with HTTP 403 while accepting others with identical cookies, and the
cutoff does not follow the version numbering (measured 2026-08-13: 22.17.0–22.19.0 return
200; 22.20.0, 22.22.0, 22.23.2 and 25.x return 403). A launchd-started app also gets a PATH
with no `node` in it at all.

`--text` accepts `--lang=zh|en`; the JSON output is language-neutral.

Use `plutil -lint "$HOME/Library/LaunchAgents/com.agentusage.widget.plist"` to validate auto-start.

## Uninstall

These commands cover both channels. The last two apply only to a packaged install, whose app
is owned by root and whose `.pkg` receipt therefore needs `sudo`:

```bash
launchctl bootout "gui/$(id -u)/com.agentusage.widget" 2>/dev/null || true
pkill -x AgentUsageWidget 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.agentusage.widget.plist"
rm -rf "$HOME/.agent-usage-widget"
rm -rf "$HOME/.claude/skills/agent-usage-widget-skill" "$HOME/.codex/skills/agent-usage-widget-skill"
defaults delete com.agentusage.widget 2>/dev/null || true
# packaged install only; the .pkg one is owned by root
sudo rm -rf /Applications/AgentUsageWidget.app
sudo pkgutil --forget com.agentusage.widget.pkg 2>/dev/null || true
```

Deleting the cloned repository does **not** uninstall anything: installing copies files into
`$HOME` and, for the packaged channel, `/Applications`. The widget has no Dock icon or menu
bar item (`LSUIElement`), so it cannot be quit from the app switcher — use its right-click
menu, or `pkill -x AgentUsageWidget`.

## Freshness and failed refreshes

Never infer a full quota when a cached reset time passes. Usage in the new window is
unknown until another observation arrives. A newly generated report cannot renew an
observation. Ordinary official/cache observations expire after three minutes; Claude
long-lived observations stay usable for ten minutes to match polling. Codex recorded
observations may be up to two days old, must name the observation time, and require an
unexpired reset for each displayed window. Reject invalid times or times more than one
minute in the future. Apply the same source-specific lifetime in JavaScript and Swift.

A failed or pending Claude polling attempt cannot revive an older cached success,
including a cached 100% remaining value. Preserve the model label. Both refresh controls
and `--live` request a refresh, subject to the ten-minute cap. Never rewrite credentials,
change login or create a scheduler as part of quota recovery. Real authenticated access
must be verified separately from the offline suite.

Run the offline regression suite from the repository root with
`node --test tests/usage-freshness.test.cjs`, then compile the widget and run
`AgentUsageWidget --check-layout`. Restart only the identified installed widget process
and verify its executable path. Passing offline tests does not prove live quota access.
