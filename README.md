# Agent Usage Widget Skill

繁體中文 | [English](#english)

這是一個 Agent Skills 格式的本機 skill，可安裝到 Claude Code 或 Codex。它會在 macOS 安裝一個本機桌面小工具，讓你用百分比快速查看 Claude 與 Codex 的可用額度。安裝後，也可以在支援 skills 的對話中呼叫 `/agent-usage-widget-skill`，直接回報目前剩餘用量百分比。

小工具會固定在桌面左上角，保持在一般應用程式視窗下方，不會永遠蓋在瀏覽器或其他工作視窗上。資料只從你的本機環境讀取；Claude cookie、token、org ID 不會被輸出、寫入 repo、寫入快取或傳送給第三方，只會在記憶體中用於呼叫 Claude 官方 usage API。

## 功能

- 顯示 Codex 的 `5 小時` 與 `1 週` 可用額度百分比。
- 顯示 Claude 的 `5 小時`、`1 週` 與 `Sonnet` 可用額度百分比。
- 每 60 秒自動刷新一次 Claude 官方用量。
- 在對話中呼叫 `/agent-usage-widget-skill` 時，回報目前 Codex / Claude 剩餘百分比。
- 以使用者層級 LaunchAgent 設定開機自動啟動。
- 使用低干擾桌面層級視窗，讓一般 App 視窗可以覆蓋它。
- 快取只保存非敏感的百分比與時間戳。

## 公開使用安全摘要

- 這個 repo 不包含個人帳號資料、Claude org ID、cookie、token、API key、本機快取、截圖或硬編碼的使用者家目錄。
- 沒有遙測、第三方分析、遠端後台或自動上傳流程。
- 安裝後會在本機建立 `$HOME/.agent-usage-widget` 與使用者層級 LaunchAgent。
- Claude 百分比需要讀取 Claude Desktop 的本機 cookie store 與 macOS Keychain；讀到的登入材料只用於呼叫 Claude 官方 usage API，不寫入磁碟。
- 這不是 Anthropic、OpenAI 或 GitHub 官方工具。請先審閱 `agent-usage-widget-skill/scripts/` 裡的腳本，再執行安裝。

## 安裝到 Claude Code

從這個 repo root 執行：

```bash
mkdir -p "$HOME/.claude/skills"
cp -R agent-usage-widget-skill "$HOME/.claude/skills/"
```

接著在 Claude Code 裡輸入：

```text
/agent-usage-widget-skill
```

若你要從 GitHub 直接安裝，可先 clone 再複製 skill 子資料夾：

```bash
git clone https://github.com/rex19938291-gif/agent-usage-widget-skill.git /tmp/agent-usage-widget-skill-repo
mkdir -p "$HOME/.claude/skills"
cp -R /tmp/agent-usage-widget-skill-repo/agent-usage-widget-skill "$HOME/.claude/skills/"
```

## 安裝到 Codex

把 `agent-usage-widget-skill` 資料夾複製到你的 Codex skills 目錄：

```bash
mkdir -p "$HOME/.codex/skills"
cp -R agent-usage-widget-skill "$HOME/.codex/skills/"
```

接著在 Codex 裡輸入：

```text
Use /agent-usage-widget-skill to install the macOS usage widget.
```

若你要從 GitHub 直接安裝：

```bash
git clone https://github.com/rex19938291-gif/agent-usage-widget-skill.git /tmp/agent-usage-widget-skill-repo
mkdir -p "$HOME/.codex/skills"
cp -R /tmp/agent-usage-widget-skill-repo/agent-usage-widget-skill "$HOME/.codex/skills/"
```

安裝完成後，你也可以直接輸入：

```text
/agent-usage-widget-skill
```

若目前的 Claude Code 或 Codex 執行環境能讀到同一台 Mac 的本機檔案，它會回報目前剩餘的用量百分比與回復 100% 的時間。預設查詢會讀取小工具最近一次快取資料，不會強制觸發 Claude Keychain/API 即時刷新；桌面小工具本身會每 60 秒更新 Claude 官方用量。若你從手機呼叫，但實際執行環境不是這台 Mac，就無法讀取這台 Mac 的本機資料。

## 隱私與安全

這個小工具只讀取本機資料。

- Codex 用量來自 `$HOME/.codex/sessions/**/*.jsonl` 裡的 rate-limit 記錄。
- Claude 百分比需要你已經登入 Claude Desktop，並允許 macOS Keychain 讀取 `Claude Safe Storage`。
- Claude cookie / token / org ID 只會在記憶體中用來查詢 Claude 官方 usage API；不會被印出、快取、寫入檔案或傳送給第三方。
- skill 沒有預先授權廣泛 shell 工具；Claude Code 或 Codex 應依照本機權限設定，在執行安裝、Keychain、`launchctl` 或 GUI 啟動動作前要求使用者確認。
- 若 macOS 跳出 Keychain 提示，選擇 `允許` 代表只允許這一次；選擇 `永遠允許` 可以避免每分鐘自動刷新時重複跳出提示。

## 系統需求

- macOS
- 可執行的 `node`
- 可執行的 `swiftc`
- Claude Desktop 已安裝並登入，才會顯示 Claude 官方百分比
- 本機有 Codex sessions，才會顯示 Codex 官方百分比

## English

Agent Skills-compatible skill for Claude Code and Codex. It installs a local macOS desktop widget that shows Claude and Codex quota availability as percentages. When invoked as `/agent-usage-widget-skill`, it can also report current local remaining percentages and recovery-to-100% times if the active agent environment can access the same Mac home directory and Keychain.

## Public Safety Summary

- This repository does not contain personal account data, Claude org IDs, cookies, tokens, API keys, local caches, screenshots, or hardcoded user home directories.
- No telemetry, third-party analytics, remote backend, or automatic upload flow is included.
- Installing creates `$HOME/.agent-usage-widget` and a user-level LaunchAgent on the local Mac.
- Claude percentages require reading the local Claude Desktop cookie store and macOS Keychain. The login material is used only for Claude's official usage API request and is not written to disk.
- This is not an official Anthropic, OpenAI, or GitHub tool. Review the scripts in `agent-usage-widget-skill/scripts/` before installing.

## Install For Claude Code

From this repo root:

```bash
mkdir -p "$HOME/.claude/skills"
cp -R agent-usage-widget-skill "$HOME/.claude/skills/"
```

Then invoke:

```text
/agent-usage-widget-skill
```

## Install For Codex

Copy the `agent-usage-widget-skill` folder into your Codex skills directory:

```bash
mkdir -p "$HOME/.codex/skills"
cp -R agent-usage-widget-skill "$HOME/.codex/skills/"
```

Then ask Codex:

```text
Use /agent-usage-widget-skill to install the macOS usage widget.
```

Direct GitHub install:

```bash
git clone https://github.com/rex19938291-gif/agent-usage-widget-skill.git /tmp/agent-usage-widget-skill-repo
mkdir -p "$HOME/.codex/skills"
cp -R /tmp/agent-usage-widget-skill-repo/agent-usage-widget-skill "$HOME/.codex/skills/"
```

## Privacy

The widget reads local usage data only. Claude percentages require the existing Claude Desktop login session and macOS Keychain access to `Claude Safe Storage`. Cookies, tokens, and organization IDs are used in memory only for the Claude official usage API request; they are not printed, cached, saved, committed, or sent to third parties.

The only cache stores non-sensitive percentages and timestamps.

## Requirements

- macOS
- Node.js available as `node`
- Swift compiler available as `swiftc`
- Claude Desktop installed and logged in for Claude official percentages
- Codex local sessions for Codex official percentages
