---
name: agent-usage-widget-skill
description: Install, maintain, and query a local macOS desktop widget that shows Claude and Codex quota availability. Use in Claude Code, Codex, or compatible Agent Skills clients when a user invokes /agent-usage-widget-skill, asks for current remaining Claude/Codex usage percentages, asks when usage recovers to 100%, wants a quota-recovery continuation checkpoint after interruption, or wants to install, update, troubleshoot, auto-start, uninstall, or package a Mac desktop usage monitor. 也適用於想在 Mac 桌面查看或直接詢問 Claude / Codex 剩餘可用額度百分比、回復 100% 時間、額度用完後如何接續任務、設定開機自動啟動、或排查 macOS Keychain 提示時。
---

# Agent Usage Widget

Use this skill to query, install, or update a local-only macOS desktop widget that shows Claude and Codex quota availability.

繁體中文重點：這個 skill 會替使用者安裝一個 macOS 桌面小工具，用百分比呈現 Claude 與 Codex 的可用額度與回復 100% 時間。它只讀取本機資料；Claude 官方百分比會使用使用者既有的 Claude Desktop 登入 session，在記憶體中查詢官方 usage API。不得輸出、保存、提交 cookie、token、org ID 或 Keychain secret，也不得傳送給 Claude 官方 API 以外的第三方。

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
- Claude live percentages also require Claude Desktop to be logged in and Keychain access to `Claude Safe Storage`.
- On a phone, the chat UI can trigger the skill, but the actual read still happens wherever Codex is executing. If that is not this Mac, it cannot see this Mac's local session.

For an explicit live refresh, only when the user asks for it, run:

```bash
node <skill-folder>/scripts/report-current-usage.js --live
```

## Quota Recovery Continuation

No skill can guarantee that an offline or rate-limited agent will automatically wake itself up later unless the host product also provides a scheduler, reminder, or automation. The reliable default is to make interruption recoverable: checkpoint the task before stopping, record the recovery time, and give the next agent a restart prompt.

Use this mode when quota is very low, quota is exhausted, a long task is likely to cross a quota window, or the user asks how to continue after quota recovery.

1. Run the normal quota report first.
2. If the active quota window is under about `10%`, stop high-consumption actions such as browser screenshot matrices, large imports/exports, package installs, or broad multi-agent work.
3. Write a local checkpoint with:

```bash
node <skill-folder>/scripts/quota-continuation-checkpoint.js \
  --service auto \
  --task "<current task name>" \
  --handoff "<path to TASK_HANDOFF.md or project handoff, if any>" \
  --next "<single concrete next step>"
```

4. Tell the user the checkpoint path and the suggested `Resume after` time from the command output.
5. If the host provides thread wakeups, reminders, or one-time automations, create a one-time wakeup for the `Resume after` time using the `Optional One-Time Wakeup Automation Prompt` written into the checkpoint. In Codex app, prefer a thread heartbeat automation attached to the current thread; if resuming a different paused task thread, explicitly target that task thread when the host supports it. In Claude Code or Claude Desktop, use Claude's own wakeup/reminder/scheduler feature if available. Do not hand-write raw scheduler config; use the host-provided automation/reminder tool.
6. The wakeup prompt must check quota again before continuing. If quota is still under about `10%`, it should update the checkpoint and create one new one-time wakeup for the next recovery time, then stop.
7. The wakeup prompt must not bypass approval gates. If the recorded next step requires user approval, sensitive data, production access, browser/Chrome permission, or credentials, it should notify the user and stop.
8. After the wakeup fires, it must end as a one-time run. Do not leave a recurring automation running unless the user explicitly asks for recurring monitoring.
9. If no host wakeup/reminder exists, ask the user to reopen Claude/Codex after the `Resume after` time and paste/use the checkpoint's resume prompt.

The default checkpoint path is `AGENT_QUOTA_CONTINUATION.md` in the current working directory. It may contain local paths and task details, so do not commit it publicly without review.

Keep this separation clear: the widget reports quota state and writes the checkpoint; the host scheduler owns waking an agent or notifying the user. Without a scheduler, the mechanism is resumable but not automatic.

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

## What To Install

Run the bundled installer:

```bash
bash <skill-folder>/scripts/install-agent-usage-widget.sh
```

The installer writes the app to:

```text
$HOME/.agent-usage-widget
```

It creates a user LaunchAgent at:

```text
$HOME/Library/LaunchAgents/com.agentusage.widget.plist
```

## Data Sources

- Codex: local `$HOME/.codex/sessions/**/*.jsonl` rate-limit records.
- Claude: local Claude Desktop cookie store plus macOS Keychain entry `Claude Safe Storage`, used only in memory to query the official `https://claude.ai/api/organizations/<org_uuid>/usage` endpoint.
- Claude fallback: if Claude Desktop is not installed, not logged in, or Keychain access is denied, show unavailable Claude percentages without crashing.

## 顯示方式

- Codex：顯示 `5 小時` 與 `1 週` 可用額度百分比。
- Claude：顯示 `5 小時`、`1 週` 與 `Sonnet` 可用額度百分比。
- 百分比代表可用額度，不是已使用額度。
- 對話查詢應同時顯示查詢時間、資料生成時間，以及各窗口回復 100% 的時間；如果已是 100%，直接標示已是 100%。
- 小工具應維持低干擾桌面層級；一般 App 視窗可以覆蓋它。
- Claude 官方用量每 60 秒強制刷新一次。

## Safety Rules

- Do not print, log, cache, or save Claude cookies, tokens, organization IDs, or Keychain secrets.
- Use Claude cookies, tokens, and organization IDs only for the official Claude usage API request; never send them to third-party services.
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

```bash
bash "$HOME/.agent-usage-widget/run-widget.sh"
launchctl list | grep com.agentusage.widget
node "$HOME/.agent-usage-widget/scripts/usage-summary.js" --text
```

Use `plutil -lint "$HOME/Library/LaunchAgents/com.agentusage.widget.plist"` to validate auto-start.
