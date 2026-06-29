# Agent Usage Widget Skill

Codex skill for installing a local macOS desktop widget that shows Claude and Codex quota availability.

## Install The Skill

Copy the `agent-usage-widget` folder into your Codex skills directory:

```bash
mkdir -p "$HOME/.codex/skills"
cp -R agent-usage-widget "$HOME/.codex/skills/"
```

Then ask Codex:

```text
Use $agent-usage-widget to install the macOS usage widget.
```

## Privacy

The widget reads local usage data only. Claude percentages require the existing Claude Desktop login session and macOS Keychain access to `Claude Safe Storage`. Cookies and tokens are used in memory only and are not printed, cached, or saved.

The only cache stores non-sensitive percentages and timestamps.

## Requirements

- macOS
- Node.js available as `node`
- Swift compiler available as `swiftc`
- Claude Desktop installed and logged in for Claude official percentages
- Codex local sessions for Codex official percentages
