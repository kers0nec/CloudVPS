# Cloud Agent

**Cloud Agent** is an autonomous AI software engineer & cloud platform (Devin-style, free forever) with a dark aurora glassmorphic interface. It lands directly into a chat workspace with real platform execution primitives: isolated VM sandboxes, live terminal streaming, embedded interactive IDE, live browser control, parallel Managed Devins (subagents), 24/7 Discord bot hosting with watchdog supervisor, typed Roblox Luau script generation, and deep multi-layer code deobfuscation.

**Everything is saved forever** — accounts, VPS instances, files, tokens, packages, and sessions are never pruned, survive crashes via rolling atomic database snapshots, and login sessions are persisted for 100 years.

---

## Architecture & Interaction Design

### 1. Entry Page
- **Zero-Friction Entry**: No landing page or marketing wall. You land straight into the chat input. Type a task, hit send, and an isolated session immediately begins.
- Instant anonymous or guest provisioning with 100-year cookie persistence; seamless sign-in with password for named accounts.

### 2. Session Page (Main Screen)
- **Mode Toggle (Always Visible)**:
  - `Ask` — Read-only research, architecture planning, and step breakdowns without modifying disk or running destructive commands.
  - `Agent` — Full autonomous execution: writes code, runs commands, installs packages, and tests.
  - Sits at the top bar and right next to the chat prompt. Takes effect next message.
- **Pinned Bottom Input Box**:
  - `@ Mentions`: Triggered by typing `@` or clicking the mention button (`@Repos`, `@Files`, `@Macros`, `@Playbooks`, `@Skills`, `@Secrets`, `@Sessions`).
  - `Add to Chat`: Highlight any transcript text, press `Cmd/Ctrl + L` to quote it directly into the input.
  - `Editable Queued Messages`: While the agent is running, typed messages queue in a tray where you can edit or cancel them before execution.
  - `Subagent Indicator`: Displays background Managed Devins active with direct link to inspect.
- **Chat Thread**:
  - Responses render inline:
    - **Plans**: Interactive checklist with live status badges.
    - **Code Diffs**: Unified diff viewer with addition/deletion highlights and "Open in IDE" button.
    - **Shell Outputs**: Terminal cards with command, stdout/stderr, and exit code.
    - **Browser Previews**: Live web app preview with URL bar.
  - `Duplicate Session`: Branch off from any response footer to explore an alternative path without losing the original.

### 3. Embedded Tools (PC Panels / Mobile Bottom Sheet)
- **Shell**: Live terminal streaming commands run by Devin, plus an interactive command prompt where you can run your own commands (`ls -la`, `git`, `python3`) on the VPS.
- **IDE**: Embedded code editor (VS Code style). Workspace file tree explorer, tabbed editor, inline syntax highlighting, interactive code editing, "Save File" button, and "✨ Deobfuscate" button.
- **Browser**: Live browser simulator. Watch Devin test web apps, inspect DOM, or take over for CAPTCHAs, MFA, and forms.
- **Progress Tab**: Unified timeline view of all shell commands, file edits, browser events, plan steps, and subagent actions.
- **Subagent Panel**: Managed Devins coordinator view. Shows child Devins running in isolated VMs with elapsed time, tool calls, and ACU compute meter. Coordinator can message children, sleep/resume, or terminate them.

### 4. Agent Command Center
- Toggle with `Cmd/Ctrl + K` or the top bar button.
- **Kanban Board**: Grouped by status (`Working`, `Blocked`, `Ready for Review`). Local and cloud agents side-by-side.
- **Spaces**: Group sessions, PRs, files, and context for one task into a single view. Context shared across sessions via `devin.spaces.shareContext`.
- **Sessions Sidebar**: Filter, sort, and double-click to rename sessions inline.
- **Playbooks**: Reusable autonomous blueprints for recurring dev tasks. Turn any session into a playbook in one click.
- **Knowledge Base**: Deduplicated codebase facts, conventions, and architectural secrets.
- **Automated Schedules**: Scheduled Devin tasks running on cron triggers.

---

## Core Agent Capabilities

1. **24/7 Discord Bot Watchdog**:
   - Write bots in Python (`discord.py`) or Node.js (`discord.js v14`).
   - Supervisor watchdog automatically restarts crashed bots and resumes running bots upon container boot.
2. **Roblox Luau Script Studio**:
   - Generates modern typed Luau (`--!strict`) scripts: welcome ScreenGui, shop GUI, leaderstats leaderboard, day/night lighting cycle, teleport pad, and part spawners.
3. **Deep Multi-Layer Deobfuscation**:
   - Decodes `\xNN` and `\uNNNN` escape sequences.
   - Decodes `String.fromCharCode` and Luau `string.char` chains.
   - Unpacks base64 eval / atob packers.
   - Demangles `_0x` obfuscated variable identifiers.
   - Unpacks Python `exec(base64.b64decode())` payloads.
4. **Real Shell & Package Management**:
   - Runs bash/terminal commands inside the isolated VPS container.
   - Installs pip and npm packages with auto-recorded package ledgers.
5. **GitHub Integration**:
   - Clones public repositories into the workspace.
   - `kers0ne/1LuhhCrim` is pinned permanently in the repository ledger.

---

## Privacy & Security

The old public user listing and passwordless account switcher have been permanently deleted.
- Only your password or private API key can access your account.
- Nobody can automatically log into another user's account.
- Login cookies are configured for 100 years (`COOKIE_MAX_AGE_MS = 100 * 365.25 * 24 * 3600 * 1000`).
- Atomic database writes with rolling backups (`data/backups/`) protect data from corruption or crashes.

---

## API Reference

Auth: pass your API key as the `X-API-Key` header (or `Authorization: Bearer`).

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health & sandbox engine status |
| GET | `/api/session` | Get current session from cookie or key |
| POST | `/api/register` | Register new account (100-year session) |
| POST | `/api/login` | Login with password |
| POST | `/api/logout` | End session |
| POST | `/api/agent/quick-start` | Instant guest account + isolated VPS VM |
| POST | `/api/agent/run` | Execute task (`{instruction, mode: 'agent'|'ask', session_id}`) |
| GET | `/api/agent/sessions` | List user sessions |
| POST | `/api/agent/sessions` | Create or update session |
| POST | `/api/agent/sessions/:id/rename` | Rename session |
| POST | `/api/agent/sessions/:id/duplicate` | Branch / duplicate session |
| DELETE | `/api/agent/sessions/:id` | Delete session |
| GET | `/api/agent/spaces` | List Spaces |
| POST | `/api/agent/spaces` | Create or update Space |
| GET | `/api/agent/subagents` | List Managed Devins (subagents) |
| POST | `/api/agent/subagents/spawn` | Spawn child Devin in isolated VM |
| POST | `/api/agent/subagents/:id/control` | Control child (`sleep`, `wake`, `terminate`) |
| POST | `/api/agent/subagents/:id/message` | Message child Devin |
| GET | `/api/agent/playbooks` | List autonomous playbooks |
| POST | `/api/agent/playbooks` | Create / export playbook |
| GET | `/api/agent/knowledge` | List knowledge entries |
| POST | `/api/agent/knowledge` | Add knowledge entry |
| GET | `/api/agent/schedules` | List automated schedules |
| POST | `/api/agent/schedules` | Add schedule |
| POST | `/api/agent/analyze-outcome` | Analyze session telemetry & ACU efficiency |
| POST | `/api/vps/:id/deobfuscate` | Deobfuscate file (`{path}`) |
| GET | `/api/vps/:id/files` | List workspace files |
| GET | `/api/vps/:id/file?path=` | Read workspace file |
| POST | `/api/vps/:id/file` | Create or overwrite file |
| POST | `/api/vps/:id/terminal/exec` | Interactive terminal execution |
| GET | `/api/repos/saved` | Saved repositories (`kers0ne/1LuhhCrim` pinned) |

Interactive API documentation is served at `/api-docs` (Swagger UI).
