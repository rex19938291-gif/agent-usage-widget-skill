---
name: agent-usage-widget-skill
description: Install, maintain, and query a local macOS desktop widget that shows Claude and Codex quota availability. Use when a user invokes /agent-usage-widget-skill, asks for current remaining Claude/Codex usage percentages, or wants to install, update, troubleshoot, auto-start, uninstall, or package a Mac desktop usage monitor for Claude Desktop, Claude Code, Codex CLI, or Codex app usage percentages. 也適用於使用者想在 Mac 桌面查看或直接詢問 Claude / Codex 目前剩餘可用額度百分比、設定開機自動啟動、或排查 macOS Keychain 提示時。
---

# Agent Usage Widget

Use this skill to query, install, or update a local-only macOS desktop widget that shows Claude and Codex quota availability.

繁體中文重點：這個 skill 會替使用者安裝一個 macOS 桌面小工具，用百分比呈現 Claude 與 Codex 的可用額度。它只讀取本機資料；Claude 官方百分比會使用使用者既有的 Claude Desktop 登入 session，在記憶體中查詢官方 usage API，不得輸出或保存 cookie、token、org ID 或 Keychain secret。

## 使用情境

- 使用者想在桌面左上角查看 Claude / Codex 可用額度。
- 使用者在手機或電腦的 Codex 對話輸入 `/agent-usage-widget-skill`，想直接知道目前剩餘幾％。
- 使用者想用百分比而不是 token 數呈現額度。
- 使用者想設定開機自動啟動。
- 使用者遇到 `Claude Safe Storage` 的 macOS Keychain 提示，需要你解釋 `允許` / `永遠允許` 的差異。
- 使用者想更新、排查或移除這個本機小工具。

## Default Slash Behavior

When the user invokes `/agent-usage-widget-skill` without asking to install, update, or uninstall, report the current remaining usage percentages first.

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
- Claude: local Claude Desktop cookie store plus macOS Keychain entry `Claude Safe Storage`, used only in memory to query `https://claude.ai/api/organizations/<org_uuid>/usage`.
- Claude fallback: if Claude Desktop is not installed, not logged in, or Keychain access is denied, show unavailable Claude percentages without crashing.

## 顯示方式

- Codex：顯示 `5 小時` 與 `1 週` 可用額度百分比。
- Claude：顯示 `5 小時`、`1 週` 與 `Sonnet` 可用額度百分比。
- 百分比代表可用額度，不是已使用額度。
- 小工具應維持低干擾桌面層級；一般 App 視窗可以覆蓋它。
- Claude 官方用量每 60 秒強制刷新一次。

## Safety Rules

- Do not print, log, cache, or save Claude cookies, tokens, organization IDs, or Keychain secrets.
- Cache only non-sensitive usage percentages and timestamps.
- Use `$HOME` and runtime discovery. Do not hard-code a developer's username, absolute home path, LaunchAgent label, org ID, PID, or local project path.
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
