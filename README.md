# Cloud Vps

A small VPS + Discord bot hosting platform. Sign up, create VPS instances,
upload your bot files (zip bundles auto-extract on upload), set your token,
and start the bot. A watchdog keeps running bots alive: crashed processes are
restarted, and bots that were running are resumed when the server boots.

## Dashboard

- **My Vps** — create, rename, start/stop/restart and delete VPS instances.
- **Dc Bots** — file manager (upload, create, rename, delete, download),
  code editor, token field, and live logs for your bot on a chosen VPS.
- **Account** — your details, API key, sign out.

Workspaces start empty: create or upload your own files. Zip uploads are
extracted into the workspace, the archive is removed, and the entry point is
auto-detected.

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
| POST   | `/api/vps`                  | Create a VPS `{name, plan}`          |
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

Interactive docs are served at `/api-docs` (Swagger UI, `openapi.yaml`).

## Legacy Python backend

`app.py` is the original Flask backend (Docker-backed VPS containers,
port 5000). The Node.js server above is the default.

```bash
pip install -r requirements.txt
python app.py
```
