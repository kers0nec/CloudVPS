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

## Dashboard

- **My Vps** — create, rename, start/stop/restart and delete VPS instances.
  Cards show live package-install state ("Installing Discord packages…" →
  "Discord stack ✓").
- **Dc Bots** — file manager (upload, create, rename, delete, download),
  code editor, token field, live logs, and a **Packages** panel (installed
  package chips, manual pip/npm install, "Install Discord Stack" button) for
  your bot on a chosen VPS.
- **Account** — your details, API key, sign out.

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
