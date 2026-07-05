# Agent Usage Widget Skill

繁體中文 | [English](#english)

這是一個 Agent Skills 格式的本機 skill，可安裝到 Claude Code 或 Codex。它會在 macOS 安裝一個本機桌面小工具，讓你用百分比快速查看 Claude 與 Codex 的可用額度。安裝後，也可以在支援 skills 的對話中呼叫 `/agent-usage-widget-skill`，直接回報目前剩餘用量百分比。

小工具會固定在桌面左上角，保持在一般應用程式視窗下方，不會永遠蓋在瀏覽器或其他工作視窗上。資料只從你的本機環境讀取；Claude cookie、token、org ID 不會被輸出、寫入 repo、寫入快取或傳送給第三方，只會在記憶體中用於呼叫 Claude 官方 usage API。

## 功能

- 顯示 Codex 的 `5 小時` 與 `1 週` 可用額度百分比。
- 顯示 Claude 的 `5 小時`、`1 週` 與 `Sonnet` 可用額度百分比。
- 每 60 秒自動刷新一次 Claude 官方用量。
- 在對話中呼叫 `/agent-usage-widget-skill` 時，回報目前 Codex / Claude 剩餘百分比。
- 在額度低或任務可能中斷時，產生本機任務恢復 checkpoint，等額度回復後讓 Claude Code / Codex 接續。
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

## 額度用完後如何接續任務

這個 skill 不能單靠自己保證 agent 在離線或被 rate limit 時自動醒來；那需要 Claude Code、Codex 或其他外部排程器本身提供喚醒能力。這個 skill 預設提供的是較可靠的 checkpoint-only 恢復機制：在額度低或中斷前寫出本機 checkpoint，記錄回復時間、handoff 路徑、下一步，以及手動恢復 prompt。

公開版預設不會建立喚醒排程。只有使用者明確下達 `不間斷開發`、`不中斷續跑`、`continuous development`、或「額度恢復後繼續自動執行」這類指令時，agent 才可以使用 `--uninterrupted` / `--continuous` 產生一次性喚醒 prompt，並交給 host scheduler 建立一次性排程。

如果目前環境支援 thread wakeup / reminder / one-time automation，且 checkpoint 是在明確不間斷開發要求下用 `--uninterrupted` 建立，agent 才應同步建立一個只執行一次的排程，在 `Resume after` 時間喚醒同一個任務。這個排程醒來後要先重新查額度；如果額度仍低於約 `10%`，就更新 checkpoint，並且只有在不間斷模式仍明確適用時才建立下一個一次性排程，然後停止。若額度已恢復且沒有使用者 approval gate，才繼續 checkpoint 裡記錄的下一步。排程執行後應結束，不要留下常駐循環。

Codex app 可用 thread heartbeat 叫醒指定 Codex thread；如果要恢復另一條暫停中的 Codex 任務，必須把 wakeup 指到那條 thread。Claude Code / Claude Desktop 則必須使用 Claude host 自己提供的 wakeup / reminder / scheduler；Codex 的 heartbeat 不能直接把 follow-up prompt 塞回 Claude 對話。如果 Claude host 沒有喚醒排程，就只能用外部一次性提醒或手動在 `Resume after` 後重新打開 Claude Code，讀 checkpoint 接續。

Claude Desktop app 對話和 Claude Code CLI session 不同。`claude --resume` / `claude --continue` 只適用 Claude Code CLI，不能恢復 Claude Desktop app 既有對話。若任務是在 Claude Desktop app 裡啟動，除非 Claude Desktop 本身提供可呼叫的 scheduler/bridge，否則公開版只採提醒/手動貼上 checkpoint prompt，不用 GUI 自動化或 CLI 命令假裝恢復 Desktop app 對話。

若本機有 Claude Code CLI，且使用者明確要求不間斷開發，也可以讓外部一次性排程在恢復時間呼叫 Claude 自己接續。知道 exact session id 時優先使用：

```bash
claude --resume "<session-id>" --print "Continue the interrupted task. Read /path/to/CLAUDE_QUOTA_CONTINUATION.md first, preserve its Authorization Envelope, re-check quota, then continue."
```

若原任務是同一工作目錄中最近的 Claude 對話，可使用：

```bash
cd "/path/to/original/workdir"
claude --continue --print "Continue the interrupted task. Read /path/to/CLAUDE_QUOTA_CONTINUATION.md first, preserve its Authorization Envelope, re-check quota, then continue the original task without re-asking for already-granted approvals."
```

不要為了恢復額度任務使用 `--dangerously-skip-permissions`。host 本身跳出的權限要求仍然必須遵守。

在長任務中，agent 應在額度很低時執行：

```bash
node "$HOME/.claude/skills/agent-usage-widget-skill/scripts/quota-continuation-checkpoint.js" \
  --service claude \
  --task "目前任務名稱" \
  --handoff "/path/to/TASK_HANDOFF.md" \
  --next "額度恢復後第一個要做的具體步驟"
```

如果使用者明確要求不間斷開發，才加上 `--uninterrupted`：

```bash
node "$HOME/.claude/skills/agent-usage-widget-skill/scripts/quota-continuation-checkpoint.js" \
  --service claude \
  --task "目前任務名稱" \
  --handoff "/path/to/TASK_HANDOFF.md" \
  --next "額度恢復後第一個要做的具體步驟" \
  --uninterrupted
```

如果安裝在 Codex，路徑通常是：

```bash
node "$HOME/.codex/skills/agent-usage-widget-skill/scripts/quota-continuation-checkpoint.js" \
  --service auto \
  --task "目前任務名稱" \
  --handoff "/path/to/TASK_HANDOFF.md" \
  --next "額度恢復後第一個要做的具體步驟"
```

預設會在目前工作目錄建立 `AGENT_QUOTA_CONTINUATION.md`，且不授權建立任何喚醒排程。等額度回復後，開新 Claude Code 或 Codex 對話，請 agent 先讀這個 checkpoint，再讀 handoff，確認 `/agent-usage-widget-skill` 顯示額度已恢復，然後從 checkpoint 裡的下一步接續。

### 保留原任務授權

恢復額度後是在接續同一個任務，不是開一個全新任務。建立 checkpoint 時，可以用 `--authorization` 把原任務已授權的範圍寫進去：

```bash
node "$HOME/.codex/skills/agent-usage-widget-skill/scripts/quota-continuation-checkpoint.js" \
  --service codex \
  --task "目前任務名稱" \
  --handoff "/path/to/TASK_HANDOFF.md" \
  --next "額度恢復後第一個要做的具體步驟" \
  --authorization "這個任務已批准使用 Browser/Chrome 做本機視覺驗證" \
  --authorization "範圍限本機測試站，不碰正式站"
```

恢復時，agent 應先讀 checkpoint 的 `Authorization Envelope` 和原本任務 handoff。已在同一任務中授權過的本機驗證、檢查、或工具使用，不應只因為是排程喚醒就再次要求使用者批准。仍需要重新確認的是超出原範圍的新 gate，例如正式站、DNS、deploy、公開 tunnel、憑證、敏感客戶資料、付款/訂單/發票、破壞性命令，或原本沒有批准的新工具/套件安裝。系統或 host 本身跳出的權限要求仍必須遵守，checkpoint 不能繞過它。

checkpoint 可能包含本機路徑與任務細節，預設已加入 `.gitignore`，不要未審閱就公開提交。

## 隱私與安全

這個小工具只讀取本機資料。

- Codex 用量來自 `$HOME/.codex/sessions/**/*.jsonl` 裡的 rate-limit 記錄。
- Claude 百分比需要你已經登入 Claude Desktop，並允許 macOS Keychain 讀取 `Claude Safe Storage`。
- Claude cookie / token / org ID 只會在記憶體中用來查詢 Claude 官方 usage API；不會被印出、快取、寫入檔案或傳送給第三方。
- quota continuation checkpoint 是本機私有交接檔；不要放入憑證、客戶資料、未審閱的敏感 log 或私密截圖。
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

## Continue After Quota Exhaustion

This skill cannot guarantee that an offline or rate-limited agent will wake itself up later by itself. That requires the host product or an external scheduler. By default, it provides checkpoint-only recovery: before stopping, write the current task, handoff path, quota recovery time, next step, and a manual resume prompt into a local checkpoint.

The public default must not create a wakeup schedule. Only when the user explicitly asks for uninterrupted or continuous development, such as `不間斷開發`, `不中斷續跑`, `continuous development`, or "keep working after quota recovers", may the agent pass `--uninterrupted` / `--continuous` and use the generated one-time wakeup prompt with the host scheduler.

If the host supports thread wakeups, reminders, or one-time automations, and the checkpoint was created from an explicit uninterrupted-development request, the agent may create one one-shot wakeup for the checkpoint's `Resume after` time. When it fires, it should check quota first. If the relevant quota window is still under about `10%`, it should update the checkpoint, create the next one-time wakeup only while uninterrupted mode remains explicitly in scope, and stop. If quota has recovered and no approval gate is active, it should continue from the recorded next step. The wakeup should end after it runs; do not leave a recurring automation running unless the user explicitly asks for recurring monitoring.

Codex app can use thread heartbeats to wake a specific Codex thread. If the paused task is in another Codex thread, the wakeup must explicitly target that thread. Claude Code / Claude Desktop must use Claude's own wakeup, reminder, or scheduler if one is available; a Codex heartbeat cannot directly post into a Claude conversation. If Claude has no host wakeup, use an external one-shot reminder or manually reopen Claude Code after `Resume after` and continue from the checkpoint.

Claude Desktop app conversations are different from Claude Code CLI sessions. `claude --resume` and `claude --continue` apply to Claude Code CLI only; they do not resume an existing Claude Desktop app conversation. For tasks started in Claude Desktop, use Claude Desktop's own supported scheduler or bridge if available. Otherwise, use a reminder/manual paste workflow from the checkpoint; do not use GUI automation or Claude Code CLI commands as the public default for Desktop app recovery.

If the local Claude Code CLI is available, and the user explicitly requested uninterrupted development, an external one-shot scheduler can invoke Claude itself after recovery. Prefer the exact session id when known:

```bash
claude --resume "<session-id>" --print "Continue the interrupted task. Read /path/to/CLAUDE_QUOTA_CONTINUATION.md first, preserve its Authorization Envelope, re-check quota, then continue."
```

If the original task is the most recent Claude conversation in the same working directory:

```bash
cd "/path/to/original/workdir"
claude --continue --print "Continue the interrupted task. Read /path/to/CLAUDE_QUOTA_CONTINUATION.md first, preserve its Authorization Envelope, re-check quota, then continue the original task without re-asking for already-granted approvals."
```

Do not use `--dangerously-skip-permissions` for quota recovery. Host-level permission prompts remain authoritative.

Claude Code example:

```bash
node "$HOME/.claude/skills/agent-usage-widget-skill/scripts/quota-continuation-checkpoint.js" \
  --service claude \
  --task "Current task name" \
  --handoff "/path/to/TASK_HANDOFF.md" \
  --next "First concrete step after quota recovery"
```

Only add `--uninterrupted` when the user explicitly asked for uninterrupted or continuous development:

```bash
node "$HOME/.claude/skills/agent-usage-widget-skill/scripts/quota-continuation-checkpoint.js" \
  --service claude \
  --task "Current task name" \
  --handoff "/path/to/TASK_HANDOFF.md" \
  --next "First concrete step after quota recovery" \
  --uninterrupted
```

Codex example:

```bash
node "$HOME/.codex/skills/agent-usage-widget-skill/scripts/quota-continuation-checkpoint.js" \
  --service auto \
  --task "Current task name" \
  --handoff "/path/to/TASK_HANDOFF.md" \
  --next "First concrete step after quota recovery"
```

The default output is `AGENT_QUOTA_CONTINUATION.md` in the current working directory, and it does not authorize creating any wakeup schedule. After quota recovers, start a new Claude Code or Codex session, ask it to read that checkpoint and the durable handoff, confirm quota with `/agent-usage-widget-skill`, then continue from the recorded next step.

### Preserve Existing Task Authorization

Quota recovery resumes the same task; it should not turn already-approved work into a brand-new approval request. When creating a checkpoint, add repeatable `--authorization` notes for approvals already granted in the active task:

```bash
node "$HOME/.codex/skills/agent-usage-widget-skill/scripts/quota-continuation-checkpoint.js" \
  --service codex \
  --task "Current task name" \
  --handoff "/path/to/TASK_HANDOFF.md" \
  --next "First concrete step after quota recovery" \
  --authorization "Browser/Chrome local visual verification is already approved for this task" \
  --authorization "Scope is limited to the local test site; no production deploy"
```

On resume, the agent should read the checkpoint's `Authorization Envelope` and the original task handoff before asking for approval. Do not re-ask for the same local verification, inspection, or tool use that was already approved for the same task merely because a scheduler woke the agent. Still ask for new gates outside the preserved envelope, such as production changes, DNS, deploys, public tunnels, credential disclosure, sensitive/customer data, payment/order/invoice data, destructive commands, or new tool/package installs that were not already approved. Host-level permission prompts remain authoritative and cannot be bypassed by a checkpoint.

Checkpoints may contain local paths and task details. They are ignored by this repo's `.gitignore`; review before sharing or committing them anywhere else.

## Privacy

The widget reads local usage data only. Claude percentages require the existing Claude Desktop login session and macOS Keychain access to `Claude Safe Storage`. Cookies, tokens, and organization IDs are used in memory only for the Claude official usage API request; they are not printed, cached, saved, committed, or sent to third parties.

The only cache stores non-sensitive percentages and timestamps.

Quota continuation checkpoints are local private handoff files. Do not include credentials, customer data, sensitive logs, or private screenshots in them.

## Requirements

- macOS
- Node.js available as `node`
- Swift compiler available as `swiftc`
- Claude Desktop installed and logged in for Claude official percentages
- Codex local sessions for Codex official percentages
