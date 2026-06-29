# Agent Usage Widget Skill

繁體中文 | [English](#english)

這是一個 Codex Skill，用來在 macOS 安裝一個本機桌面小工具，讓你用百分比快速查看 Claude 與 Codex 的可用額度。安裝後，也可以在 Codex 對話中呼叫 `/agent-usage-widget-skill`，直接回報目前剩餘用量百分比。

小工具會固定在桌面左上角，保持在一般應用程式視窗下方，不會永遠蓋在瀏覽器或其他工作視窗上。資料只從你的本機環境讀取，不會把 Claude cookie、token、org ID 或任何登入資訊輸出、保存或上傳。

## 功能

- 顯示 Codex 的 `5 小時` 與 `1 週` 可用額度百分比。
- 顯示 Claude 的 `5 小時`、`1 週` 與 `Sonnet` 可用額度百分比。
- 每 60 秒自動刷新一次 Claude 官方用量。
- 在對話中呼叫 `/agent-usage-widget-skill` 時，回報目前 Codex / Claude 剩餘百分比。
- 以使用者層級 LaunchAgent 設定開機自動啟動。
- 使用低干擾桌面層級視窗，讓一般 App 視窗可以覆蓋它。
- 快取只保存非敏感的百分比與時間戳。

## 安裝 Skill

把 `agent-usage-widget-skill` 資料夾複製到你的 Codex skills 目錄：

```bash
mkdir -p "$HOME/.codex/skills"
cp -R agent-usage-widget-skill "$HOME/.codex/skills/"
```

接著在 Codex 裡輸入：

```text
Use /agent-usage-widget-skill to install the macOS usage widget.
```

安裝完成後，你也可以直接輸入：

```text
/agent-usage-widget-skill
```

若目前的 Codex 執行環境能讀到同一台 Mac 的本機檔案與 Claude Keychain，它會回報目前剩餘的用量百分比。若你從手機呼叫，但實際執行環境不是這台 Mac，就無法讀取這台 Mac 的即時 Keychain/session。
```

## 隱私與安全

這個小工具只讀取本機資料。

- Codex 用量來自 `$HOME/.codex/sessions/**/*.jsonl` 裡的 rate-limit 記錄。
- Claude 百分比需要你已經登入 Claude Desktop，並允許 macOS Keychain 讀取 `Claude Safe Storage`。
- Claude cookie / token / org ID 只會在記憶體中用來查詢 Claude 官方 usage API，不會被印出、快取或寫入檔案。
- 若 macOS 跳出 Keychain 提示，選擇 `允許` 代表只允許這一次；選擇 `永遠允許` 可以避免每分鐘自動刷新時重複跳出提示。

## 系統需求

- macOS
- 可執行的 `node`
- 可執行的 `swiftc`
- Claude Desktop 已安裝並登入，才會顯示 Claude 官方百分比
- 本機有 Codex sessions，才會顯示 Codex 官方百分比

## English

Codex skill for installing a local macOS desktop widget that shows Claude and Codex quota availability as percentages. When invoked as `/agent-usage-widget-skill`, it can also report current local remaining percentages if the active Codex environment can access the same Mac home directory and Keychain.

## Install The Skill

Copy the `agent-usage-widget-skill` folder into your Codex skills directory:

```bash
mkdir -p "$HOME/.codex/skills"
cp -R agent-usage-widget-skill "$HOME/.codex/skills/"
```

Then ask Codex:

```text
Use /agent-usage-widget-skill to install the macOS usage widget.
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
