# Cloud Vps

A small VPS + Discord bot hosting platform. Sign up, create VPS instances,
upload your bot files (zip bundles auto-extract on upload), set your token,
and start the bot. Every VPS is saved to the persistent database — including
its installed package ledger — and Discord packages are installed
automatically: new VPS instances get the full Discord stack (discord.py,
python-dotenv, aiohttp, requests, psutil, colorama via pip and discord.js,
dotenv via npm) installed in the background as soon as they are created.
Interrupted installs self-heal on boot, and a watchdog keeps running bots
alive: crashed processes are restarted, and bots that were running are
resumed when the server boots.

## Reliability & security hardening

A pass over the whole codebase found and fixed the root causes behind
random sign-outs and "deleted" accounts, plus several serious security
holes:

- **Full source/secret exposure (critical):** the static file server used
  to serve *any* file in the project directory — `server.js`, `database.js`,
  `package.json`, `.env` (JWT/session secrets), the account database, and
  every VPS workspace including saved Discord bot tokens — to anonymous
  visitors with a plain `GET` request. Now only an explicit allowlist of
  public frontend assets is served.
- **Account takeover via `/api/users/switch` (critical):** this endpoint let
  anyone log in as *any* account just by knowing its username, no password
  required, and a companion endpoint published the full username list to
  pair with it. Both are removed; they weren't used by the dashboard.
- **Auth bypass via bare user ID:** the API also accepted a plain user ID
  (which appears in URLs/logs/responses) as a login credential. Only the
  real API key is accepted now.
- **Accounts deleted on every restart:** a boot-time cleanup step matched
  "legacy demo accounts" by *username* (e.g. `demo_user`,
  `brittainjaden347`) instead of by fixed internal ID — any real user who
  happened to pick one of those usernames had their account silently wiped
  on every server restart. Matching is now strictly by the original
  hardcoded legacy ID.
- **No persistent storage in production:** the default Render deployment
  ran the legacy Python backend with no disk configured at all, so every
  redeploy/restart started from a completely empty filesystem. Deployment
  now uses the Node server with a mounted persistent disk (`PERSIST_DIR`)
  for both the account database and VPS workspaces.
- **Unsafe/blocking database writes:** saves are now atomic (write-temp +
  fsync + rename) with rolling backups and corruption detection, so a crash
  or bad write can never silently wipe or corrupt the database — and writes
  are coalesced instead of happening synchronously on every log line, which
  used to stall the whole server (and every user's session) under load.
- **Blocking `execSync` calls on hot paths:** GitHub clone/install and the
  in-browser terminal used to run git/npm/pip synchronously, freezing
  Node's single event loop — and therefore every other user's request — for
  up to a minute at a time. These are now async.
- **Shell injection in GitHub clone:** the repo URL/branch were interpolated
  into a shell string; a crafted value could run arbitrary commands on the
  host. Fixed by using argument arrays instead of a shell string.
- **Bot crash-loop breaker was broken:** a script that fails instantly,
  forever, used to auto-restart every 3 seconds with no limit, able to
  starve the whole host. Restart backoff now escalates and a real breaker
  trips after repeated rapid failures — clearing automatically the next
  time you press Start/Restart.
- **CORS + cookies:** fixed an invalid `origin: '*'` + `credentials: true`
  combination (browsers silently reject it), made session cookies
  `httpOnly` + `secure` in production, and added `trust proxy` so IP-based
  rate limiting works correctly behind a reverse proxy instead of treating
  every visitor as the same client.
- **Bot/abuse protection:** login and registration now have a dedicated
  strict rate limit (protects against credential-stuffing/mass-signup bots)
  that never affects normal signed-in traffic, which doesn't hit those
  routes more than a couple of times.
- Added process-wide crash guards (`uncaughtException` /
  `unhandledRejection`) so one bad request can no longer take the whole
  server — and every active session — down with it.

## Dashboard

- **My Vps** — create, rename, start/stop/restart and delete VPS instances.
  Cards show live package-install state ("Installing Discord packages…" →
  "Discord stack ✓").
- **Dc Bots** — file manager (upload, create, rename, delete, download),
  code editor, token field, live logs, and a **Packages** panel (installed
  package chips, manual pip/npm install, "Install Discord Stack" button) for
  your bot on a chosen VPS.
- **Account** — your details, API key, saved-accounts switcher (see below),
  sign out (this account or all of them).

### Switching between accounts

The sidebar user pill and the Account tab both offer a **saved accounts**
menu: any account you've successfully signed into (or registered) on this
browser is remembered locally and can be switched to instantly, without
re-entering a password. "Add another account" opens the sign-in/sign-up
modal without dropping your currently saved accounts, so you can keep
several accounts (e.g. one per bot project) side by side and hop between
them from the sidebar.

This intentionally replaces the old `/api/users/switch` endpoint, which let
anyone log in as *any* account just by supplying its username — a full
account-takeover hole. The new switcher (`POST /api/session/switch`) only
ever accepts a real `api_key`, and only ever offers accounts this specific
browser has already authenticated as; a saved entry is added exclusively
right after a genuine, server-confirmed login or registration. Guessing or
knowing someone else's username can never switch a session into their
account.

Workspaces start with no demo files: create or upload your own files. Zip
uploads are extracted into the workspace, the archive is removed, and the
entry point is auto-detected. Uploaded `requirements.txt` / `package.json`
dependencies are installed automatically, and missing python requirements
are re-installed before a bot starts.

## Package persistence ("saves our VPS")

- Every VPS keeps a **package ledger** in `data/cloudvps_db.json`
  (`vps.packages.python` / `vps.packages.node` + `auto_install` state),
  written atomically with a backup copy on every change.
- Installs, uninstalls and the automatic Discord stack all update the
  ledger, so package state survives server restarts.
- On boot, any VPS whose auto-install never completed (pending / running /
  failed) is re-installed automatically — no user action needed.

## Quick start

```bash
npm install
npm start        # node server.js, listens on :3000 (override with PORT)
```

Open <http://localhost:3000>, create an account (a starter VPS is provisioned
automatically), then go to **Dc Bots** and upload your bot.

Other scripts: `npm run dev` (watch mode), `npm test` (unit tests),
`npm run lint`, `npm run format`.

### Deploying with persistent storage

On any host with an ephemeral filesystem (Render, Fly, most container
platforms), set `PERSIST_DIR` to a mounted persistent volume so **both** the
account database and every VPS workspace survive redeploys/restarts —
without this, accounts and bot files are wiped every time the app restarts:

```bash
PERSIST_DIR=/var/data   # data/ and vps_instances/ both live under here
```

`render.yaml` in this repo is already configured with a persistent disk
mounted at `/var/data` for exactly this reason.

## API

Auth: pass your API key as the `X-API-Key` header (or `Authorization: Bearer`).
Get a key by registering or logging in.

| Method | Path                        | Description                          |
|--------|-----------------------------|--------------------------------------|
| GET    | `/api/health`               | Service status                       |
| GET    | `/api/session`              | Current session (cookie or key)      |
| POST   | `/api/register`             | Create account, returns API key      |
| POST   | `/api/login`                | Log in, returns API key              |
| POST   | `/api/logout`               | End session                          |
| POST   | `/api/session/switch`       | Switch session to another account `{api_key}` — requires that account's real API key, never just a username |
| GET    | `/api/plans`                | Plan catalogue                       |
| GET    | `/api/hardware`             | Host hardware info                   |
| GET    | `/api/vps`                  | List your VPS instances              |
| POST   | `/api/vps`                  | Create a VPS `{name, plan, auto_install?}` — Discord stack auto-installs unless `auto_install:false` |
| POST   | `/api/vps/<id>/rename`      | Rename `{name}`                      |
| POST   | `/api/vps/<id>/start`       | Start                                |
| POST   | `/api/vps/<id>/stop`        | Stop                                 |
| POST   | `/api/vps/<id>/restart`     | Restart                              |
| DELETE | `/api/vps/<id>`             | Delete                               |
| GET    | `/api/vps/<id>/files`       | List workspace files                 |
| GET    | `/api/vps/<id>/file?path=`  | Read a file                          |
| POST   | `/api/vps/<id>/file`        | Create/overwrite `{path, content}`   |
| POST   | `/api/vps/<id>/folder`      | Create folder `{path}`               |
| POST   | `/api/vps/<id>/file/rename` | Rename `{oldPath, newPath}`          |
| GET    | `/api/vps/<id>/file/download?path=` | Download a file              |
| DELETE | `/api/vps/<id>/file?path=`  | Delete file or folder                |
| POST   | `/api/vps/<id>/bot/upload`  | Upload files (multipart `files`); zips auto-extract |
| GET    | `/api/vps/<id>/bot`         | Bot state (script, runtime, token, status) |
| POST   | `/api/vps/<id>/bot/start`   | Start bot `{filename, runtime, token?}` |
| POST   | `/api/vps/<id>/bot/stop`    | Stop bot                             |
| POST   | `/api/vps/<id>/bot/restart` | Restart bot                          |
| GET    | `/api/vps/<id>/bot/logs`    | Live logs + status                   |
| POST   | `/api/vps/<id>/bot/logs/clear` | Clear logs                        |
| POST   | `/api/vps/<id>/bot/token`   | Store token                          |
| GET    | `/api/vps/<id>/packages/list` | Persisted package ledger (python + node) + auto-install state |
| POST   | `/api/vps/<id>/packages/install` | Install `{packages, runtime}` (pip/npm), saved to the ledger |
| POST   | `/api/vps/<id>/packages/uninstall` | Uninstall `{package, runtime}` |
| POST   | `/api/vps/<id>/packages/auto-install` | (Re)run the Discord-stack installer `{force?}` |
| POST   | `/api/vps/<id>/packages/install-bundle` | Bundle install `{bundle}` (`discord`, `python`, `lune`, …) |
| GET    | `/api/vps/<id>/packages/status` | Runtimes, tools and Discord-stack state |

Interactive docs are served at `/api-docs` (Swagger UI, `openapi.yaml`).

## Legacy Python backend

`app.py` is the original Flask backend (Docker-backed VPS containers,
port 5000). The Node.js server above is the default.

```bash
pip install -r requirements.txt
python app.py
```
