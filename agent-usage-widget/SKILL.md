---
name: agent-usage-widget
description: Install and maintain a local macOS desktop widget that shows Claude and Codex quota availability. Use when a user asks to install, update, troubleshoot, auto-start, uninstall, or package a Mac desktop usage monitor for Claude Desktop, Claude Code, Codex CLI, or Codex app usage percentages.
---

# Agent Usage Widget

Use this skill to install or update a local-only macOS desktop widget that shows Claude and Codex quota availability.

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

## Verification

After install or update, run:

```bash
bash "$HOME/.agent-usage-widget/run-widget.sh"
launchctl list | grep com.agentusage.widget
node "$HOME/.agent-usage-widget/scripts/usage-summary.js" --text
```

Use `plutil -lint "$HOME/Library/LaunchAgents/com.agentusage.widget.plist"` to validate auto-start.
