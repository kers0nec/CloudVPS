# CloudVPS

A 24/7 VPS + Discord bot hosting platform. Users sign up (no demo accounts —
every account is one you actually registered), create VPS workspaces with a
**clean slate** (zero demo/starter files), create or upload their own files —
zip bundles **auto-extract on upload** and the archive is removed — set their
Discord token, and the 24/7 watchdog keeps the bot process alive: auto-restart
on crash and auto-resume when the server comes back up.

## Quick start (main Node.js platform)

```bash
npm install
npm start        # node server.js, listens on :3000 (override with PORT)
```

Then open <http://localhost:3000>, create a free account, deploy a VPS, and
go to the **Discord Bot (24/7)** tab to start your bot.

- 24/7 watchdog: crashed bots are respawned automatically (with crash-loop
  protection), and bots marked as running are resumed on server boot.
- **Clean-slate workspaces:** no demo or starter files are ever seeded, and
  anything you delete stays deleted. Create or upload your own files only.
- **Zip auto-extract:** uploading a `.zip` bundle extracts it straight into
  the workspace (built-in extractor, no system tools required), deletes the
  archive afterwards, and auto-detects the bot entry point.
- Live bot logs, file manager (rename/duplicate/download/delete/clear-all),
  code editor, terminal, package installer (pip/npm), GitHub clone into your
  workspace, and a Remote PC controller live in the dashboard (pink theme).

## Legacy Python backend (Docker-backed)

`app.py` is the original Docker-backed VPS control panel. Each "VPS" you
create is an actual Docker container (Ubuntu) provisioned with real CPU,
memory and disk limits. See "Requirements" and "Run (Python)" below.

## Features
- User registration / login with hashed passwords (Werkzeug `pbkdf2:sha256`).
- API-key authenticated REST API.
- Create / start / stop / delete real VPS containers.
- Live status and IP synced from the Docker daemon on every list request;
  rows whose container no longer exists are pruned automatically.
- `/api/health` reports live Docker reachability (with the backend error
  detail), and the dashboard shows a banner whenever the daemon is offline.
- Plan catalogue served by `/api/plans` — the dashboard renders it dynamically,
  so there is a single source of truth for plans.
- Single-page dashboard (`index.html`) served by the same app.

## Requirements
- Node.js 18+ (main platform) or Python 3.10+ (legacy backend).
- For the legacy Python backend: a working Docker daemon that the app can
  reach (`DOCKER_HOST`, or the default local socket). Without Docker, the API
  boots and serves the UI but returns a clear `503` (including the backend
  error detail) when a VPS operation is attempted.
- `docker-py >= 7.1.0` (pinned in `requirements.txt`); 7.0.0 is incompatible
  with modern `requests` and fails with "Not supported URL scheme http+docker".

## Install (Python)
```bash
pip install -r requirements.txt
```

## Run (Python)
```bash
python app.py          # listens on :5000 (override with PORT env var)
```
Then open <http://localhost:5000>.

## API
| Method | Path                      | Auth | Description                |
|--------|---------------------------|------|----------------------------|
| POST   | `/api/register`           | —    | Create account             |
| POST   | `/api/login`              | —    | Get API key                |
| GET    | `/api/plans`              | —    | List plans                 |
| POST   | `/api/vps`                | key  | Create (provision) a VPS   |
| GET    | `/api/vps`                | key  | List your VPS instances    |
| GET    | `/api/vps/<id>`           | key  | Get one VPS                |
| POST   | `/api/vps/<id>/start`     | key  | Start the container        |
| POST   | `/api/vps/<id>/stop`      | key  | Stop the container         |
| DELETE | `/api/vps/<id>`           | key  | Delete the container       |
| POST   | `/api/vps/<id>/bot/upload`| key  | Upload files (zip auto-extracts) |
| GET    | `/api/vps/<id>/files`     | key  | List workspace files       |
| POST   | `/api/vps/<id>/file`      | key  | Create/overwrite a file    |
| DELETE | `/api/vps/<id>/file`      | key  | Delete a file (stays deleted) |
| POST   | `/api/vps/<id>/files/clear-all` | key | Wipe the workspace   |
| POST   | `/api/vps/<id>/bot/start` | key  | Start the 24/7 bot watchdog |
| POST   | `/api/vps/<id>/bot/stop`  | key  | Stop the bot               |
| GET    | `/api/vps/<id>/bot/logs`  | key  | Live bot logs              |
| POST   | `/api/vps/<id>/github/clone` | key | Clone a repo into the workspace |
| GET    | `/api/user`               | key  | Current user + VPS count   |
| GET    | `/api/health`             | —    | Service status             |

Pass the API key as the `X-API-Key` header. Full interactive docs are served
at `/api-docs` (Swagger UI, see `openapi.yaml`).
