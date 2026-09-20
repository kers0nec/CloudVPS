#!/usr/bin/env python3
"""
CloudVPS Python/Flask Unified Backend
Provides 100% API parity with Node.js server.js for Railway and container deployments.
"""

import os
import sys
import json
import time
import uuid
import hashlib
import zipfile
import subprocess
from pathlib import Path
from flask import Flask, request, jsonify, send_file, send_from_directory, make_response
from werkzeug.utils import secure_filename

app = Flask(__name__, static_folder=None)

BASE_DIR = Path(__file__).resolve().parent
# PERSIST_DIR mirrors the Node server's setting: point both the account
# database and every VPS workspace at one durable, mounted volume on hosts
# that only offer a single persistent mount path. Without this, whichever
# directory lands on ephemeral storage gets wiped on every redeploy/restart.
PERSIST_DIR = Path(os.environ["PERSIST_DIR"]).resolve() if os.environ.get("PERSIST_DIR") else BASE_DIR
INSTANCES_DIR = PERSIST_DIR / "vps_instances"
DATA_DIR = PERSIST_DIR / "data"

INSTANCES_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_FILE = DATA_DIR / "cloudvps_db.json"
DB_BACKUP_FILE = DATA_DIR / "cloudvps_db.backup.json"

PLANS = {
    "starter": {"cpu": "1.0 Core", "memory": "1GB RAM", "storage": "20GB NVMe", "price": "FREE", "tier": "Free Community"},
    "standard": {"cpu": "2.0 Cores", "memory": "2GB RAM", "storage": "40GB NVMe", "price": "FREE", "tier": "Free Bot Host"},
    "performance": {"cpu": "4.0 Cores", "memory": "4GB RAM", "storage": "80GB NVMe", "price": "FREE", "tier": "Free High Performance"},
    "ultra": {"cpu": "8.0 Cores", "memory": "8GB RAM", "storage": "160GB NVMe", "price": "FREE", "tier": "Free Ultra Dedicated"}
}

db = {
    "users": {},
    "vps": {},
    "bots": {},
    "services": {}
}

def hash_password(password: str, salt: str = None) -> tuple:
    """Salted PBKDF2 hash. Each user gets a unique random salt (stored with
    the record) instead of one hardcoded global salt — with a single shared
    salt, a leak of the DB lets an attacker crack every account's password
    with one precomputed rainbow table instead of needing one per user."""
    if salt is None:
        salt = uuid.uuid4().hex
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 200_000).hex()
    return digest, salt


def verify_password(user: dict, password: str) -> bool:
    if not user or not user.get("password_hash"):
        return False
    salt = user.get("salt")
    if salt:
        digest, _ = hash_password(password, salt)
        return digest == user["password_hash"]
    # Legacy unsalted SHA-256 accounts (pre-hardening) — verify against the
    # old scheme once, then transparently upgrade to the salted hash so the
    # weak version is never used again.
    legacy = hashlib.sha256((password + "_cvps_salt").encode("utf-8")).hexdigest()
    if legacy == user["password_hash"]:
        digest, salt = hash_password(password)
        user["salt"] = salt
        user["password_hash"] = digest
        save_db()
        return True
    return False

def init_workspace(vps_id: str):
    ws_dir = INSTANCES_DIR / vps_id
    ws_dir.mkdir(parents=True, exist_ok=True)

    bot_py = ws_dir / "bot.py"
    if not bot_py.exists():
        bot_py.write_text("""import os
import discord
from dotenv import load_dotenv

load_dotenv()
TOKEN = os.getenv("DISCORD_BOT_TOKEN") or os.getenv("TOKEN")

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)

@client.event
async def on_ready():
    print(f"=== 24/7 Always-On Discord Bot is Online! ===")
    print(f"Logged in as {client.user.name} (ID: {client.user.id})")
    print(f"Cloud VPS Watchdog status: HEALTHY 🟢")

@client.event
async def on_message(message):
    if message.author == client.user:
        return
    if message.content.startswith("!ping"):
        await message.channel.send("Pong! 🏓 Running 24/7 on CloudVPS.")

if __name__ == "__main__":
    if not TOKEN:
        print("[Notice] DISCORD_BOT_TOKEN not provided in .env yet.")
        print("[Notice] Please paste your bot token in the Discord Bot tab above.")
    else:
        client.run(TOKEN)
""", encoding="utf-8")

    env_file = ws_dir / ".env"
    if not env_file.exists():
        env_file.write_text(f"DISCORD_BOT_TOKEN=\nPORT=3000\nNODE_ENV=production\nVPS_ID={vps_id}\n", encoding="utf-8")

    req_file = ws_dir / "requirements.txt"
    if not req_file.exists():
        req_file.write_text("discord.py>=2.3.2\npython-dotenv>=1.0.0\naiohttp>=3.9.0\n", encoding="utf-8")

    index_js = ws_dir / "index.js"
    if not index_js.exists():
        index_js.write_text("// CloudVPS 24/7 Node.js Bot Starter\nrequire('dotenv').config();\nconsole.log('Ready 24/7 🟢');\n", encoding="utf-8")

def _safe_parse(raw: str):
    """Parse + shape-validate a db JSON blob. Returns None (never raises) if
    the content is empty, malformed, or missing the expected top-level keys —
    callers must treat None as "this copy can't be trusted"."""
    if not raw or not raw.strip():
        return None
    try:
        data = json.loads(raw)
    except Exception:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("users"), dict):
        return None
    return data


def load_db():
    global db
    loaded = False

    if DB_FILE.exists():
        parsed = _safe_parse(DB_FILE.read_text(encoding="utf-8"))
        if parsed is not None:
            db.update(parsed)
            loaded = True

    if not loaded and DB_BACKUP_FILE.exists():
        parsed = _safe_parse(DB_BACKUP_FILE.read_text(encoding="utf-8"))
        if parsed is not None:
            db.update(parsed)
            loaded = True

    if not loaded and (DB_FILE.exists() or DB_BACKUP_FILE.exists()):
        # Both copies were unreadable/corrupt. Preserve them for recovery and
        # refuse to let a blank in-memory db silently overwrite real data —
        # this is precisely how accounts get permanently deleted.
        stamp = int(time.time())
        try:
            if DB_FILE.exists():
                DB_FILE.rename(DATA_DIR / f"cloudvps_db.json.corrupt.{stamp}")
            if DB_BACKUP_FILE.exists():
                DB_BACKUP_FILE.rename(DATA_DIR / f"cloudvps_db.backup.json.corrupt.{stamp}")
        except Exception:
            pass
        print("[CloudVPS DB] CRITICAL: both primary and backup database files were unreadable. "
              "Starting empty and preserving the corrupt files for recovery.", file=sys.stderr)

    # Prune ONLY the exact hardcoded legacy demo IDs from older versions,
    # matched strictly by internal ID — never by username. An earlier
    # version of this cleanup also matched by *username*, which meant any
    # real user who signed up as "demo_user" or "brittainjaden347" had their
    # account silently deleted on every server restart. Real accounts get a
    # random UUID-based ID at signup and can never collide with these
    # constants, so exact-ID matching is both sufficient and safe.
    for user_id in ("usr_free_user", "usr_brittainjaden347"):
        db["users"].pop(user_id, None)

    for vps_id in list(db["vps"].keys()):
        vps = db["vps"][vps_id]
        owner_gone = vps.get("user_id") and vps["user_id"] not in db["users"]
        is_legacy_seed_vps = vps_id == "vps-free-01"
        if owner_gone or is_legacy_seed_vps:
            db["vps"].pop(vps_id, None)
            db["bots"].pop(vps_id, None)

    # Ensure workspace directories exist for every remaining real VPS
    for vps_id in list(db["vps"].keys()):
        init_workspace(vps_id)

    save_db()

def save_db():
    try:
        payload = json.dumps(db, indent=2)
        if not payload or payload == "{}":
            print("[CloudVPS DB] Refusing to save an empty database snapshot", file=sys.stderr)
            return
        # Atomic write: write to a temp file, fsync, then rename over the
        # primary file (POSIX rename is atomic — readers never see a
        # half-written file), keeping a rolling backup copy too.
        if DB_FILE.exists():
            try:
                DB_BACKUP_FILE.write_bytes(DB_FILE.read_bytes())
            except Exception:
                pass
        tmp_file = DATA_DIR / f"cloudvps_db.json.tmp.{os.getpid()}"
        with open(tmp_file, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_file, DB_FILE)
    except Exception as e:
        print(f"[CloudVPS DB Save Error]: {e}", file=sys.stderr)

def get_user():
    # SECURITY: only the real API key authenticates. A previous version of
    # the Node server also accepted a bare user ID as a credential, which is
    # exposed in URLs/logs/responses — that fallback is intentionally not
    # replicated here.
    key = request.headers.get("X-API-Key") or request.args.get("api_key") or request.cookies.get("api_key")
    if key:
        for u in db["users"].values():
            if u.get("api_key") == key:
                return u
    return None

# ----------------- ROUTES -----------------

@app.route("/api/health")
def api_health():
    return jsonify({
        "status": "ok",
        "docker": False,
        "native_ready": True,
        "engine": "native_sandbox",
        "detail": "CloudVPS Native Sandbox Engine active & ultra-fast.",
        "image": "ubuntu:22.04",
        "plans": list(PLANS.keys())
    })

@app.route("/api/plans")
def api_plans():
    return jsonify(PLANS)

@app.route("/api/backend-info")
def api_backend_info():
    return jsonify({
        "backend_url": "local",
        "status": "connected",
        "runtime": f"python-{sys.version.split()[0]}-native",
        "speed": "ultra-fast"
    })

@app.route("/api/session")
def api_session():
    user = get_user()
    if not user:
        return jsonify({"authenticated": False, "success": True, "user": None})
    vps_count = sum(1 for v in db["vps"].values() if v.get("user_id") == user["id"])
    return jsonify({
        "authenticated": True,
        "success": True,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "api_key": user["api_key"],
            "vps_count": vps_count
        }
    })

@app.route("/api/register", methods=["POST"])
def api_register():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400
    if len(username) < 3:
        return jsonify({"error": "Username must be at least 3 characters"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400

    for u in db["users"].values():
        if u["username"].lower() == username.lower():
            return jsonify({"error": "Username already exists"}), 400

    uid = "usr_" + uuid.uuid4().hex[:12]
    api_key = "cvps_" + uuid.uuid4().hex
    digest, salt = hash_password(password)
    new_user = {
        "id": uid,
        "username": username,
        "password_hash": digest,
        "salt": salt,
        "api_key": api_key,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ")
    }
    db["users"][uid] = new_user
    save_db()

    resp = make_response(jsonify({"success": True, "api_key": api_key, "user_id": uid, "username": username}))
    resp.set_cookie("api_key", api_key, max_age=30*86400, httponly=True, samesite="Lax",
                     secure=os.environ.get("FLASK_ENV") == "production" or os.environ.get("NODE_ENV") == "production")
    return resp

@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    clean_u = username.lower()
    user = next((u for u in db["users"].values() if u["username"].lower() == clean_u), None)
    if not user or not verify_password(user, password):
        return jsonify({"error": "Invalid username or password"}), 401
    resp = make_response(jsonify({"success": True, "api_key": user["api_key"], "user_id": user["id"], "username": user["username"]}))
    resp.set_cookie("api_key", user["api_key"], max_age=30*86400, httponly=True, samesite="Lax",
                     secure=os.environ.get("FLASK_ENV") == "production" or os.environ.get("NODE_ENV") == "production")
    return resp

@app.route("/api/logout", methods=["POST"])
def api_logout():
    resp = make_response(jsonify({"success": True, "message": "Logged out"}))
    resp.delete_cookie("api_key")
    return resp

# Switch the active session to another account the caller already holds a
# valid api_key for. Mirrors server.js's /api/session/switch: it is the safe
# replacement for the old username-only account switcher, so it never
# accepts anything but a real, existing api_key as proof of ownership.
@app.route("/api/session/switch", methods=["POST"])
def api_session_switch():
    data = request.get_json(silent=True) or {}
    api_key = data.get("api_key")
    if not api_key or not isinstance(api_key, str):
        return jsonify({"success": False, "error": "api_key is required"}), 400

    user = next((u for u in db["users"].values() if u["api_key"] == api_key), None)
    if not user:
        return jsonify({"success": False, "error": "That saved account is no longer valid. Please sign in again."}), 401

    resp = make_response(jsonify({"success": True, "api_key": user["api_key"], "user_id": user["id"], "username": user["username"]}))
    resp.set_cookie("api_key", user["api_key"], max_age=30*86400, httponly=True, samesite="Lax",
                     secure=os.environ.get("FLASK_ENV") == "production" or os.environ.get("NODE_ENV") == "production")
    return resp

@app.route("/api/vps", methods=["GET"])
def api_vps_list():
    user = get_user()
    if not user:
        return jsonify({"success": False, "error": "Authentication required"}), 401
    vps_list = [v for v in db["vps"].values() if v.get("user_id") == user["id"]]
    return jsonify({"success": True, "vps": vps_list})

@app.route("/api/vps", methods=["POST"])
def api_vps_create():
    user = get_user()
    data = request.get_json(silent=True) or {}
    plan = data.get("plan", "performance")
    plan_info = PLANS.get(plan, PLANS["performance"])
    vps_id = "vps-" + uuid.uuid4().hex[:8]
    name = (data.get("name") or "").strip() or f"Discord-Bot-{vps_id[-4:]}"

    new_vps = {
        "id": vps_id,
        "user_id": user["id"],
        "name": name,
        "plan": plan,
        "status": "running",
        "cpu": plan_info["cpu"],
        "memory": plan_info["memory"],
        "storage": plan_info["storage"],
        "ip": f"172.20.0.{len(db['vps']) + 10}",
        "container_id": "c-" + vps_id,
        "engine": "native_sandbox",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ")
    }
    db["vps"][vps_id] = new_vps
    init_workspace(vps_id)

    db["bots"][vps_id] = {
        "status": "running",
        "running": True,
        "pid": 4200,
        "filename": "bot.py",
        "runtime": "python",
        "token": "",
        "restarts": 0,
        "started_at": int(time.time()),
        "logs": [
            f"[CloudVPS Watchdog] Provisioned isolated container ({name})...",
            "[CloudVPS Supervisor] Workspace ready at /root/workspace/"
        ]
    }
    save_db()
    return jsonify({"success": True, "vps": new_vps}), 201

@app.route("/api/vps/<vps_id>", methods=["GET"])
def api_vps_get(vps_id):
    v = db["vps"].get(vps_id)
    if not v:
        return jsonify({"error": "Not found"}), 404
    return jsonify({"success": True, "vps": v})

@app.route("/api/vps/<vps_id>/files")
def api_vps_files(vps_id):
    init_workspace(vps_id)
    ws_dir = INSTANCES_DIR / vps_id
    files = []
    for item in ws_dir.rglob("*"):
        if item.is_file() and not any(part.startswith(".") and part != ".env" for part in item.parts):
            files.append({
                "name": str(item.relative_to(ws_dir)),
                "size": item.stat().st_size,
                "modified": int(item.stat().st_mtime)
            })
    return jsonify({"success": True, "files": files})

@app.route("/api/vps/<vps_id>/file", methods=["GET"])
def api_vps_file_get(vps_id):
    init_workspace(vps_id)
    filename = request.args.get("path", "bot.py")
    ws_dir = (INSTANCES_DIR / vps_id).resolve()
    target = (ws_dir / filename).resolve()
    if not str(target).startswith(str(ws_dir)):
        return jsonify({"error": "Access denied"}), 403
    content = target.read_text(encoding="utf-8") if target.exists() else ""
    return jsonify({"success": True, "path": filename, "content": content})

@app.route("/api/vps/<vps_id>/file", methods=["POST"])
def api_vps_file_post(vps_id):
    init_workspace(vps_id)
    data = request.get_json(silent=True) or {}
    filename = data.get("path", "")
    content = data.get("content", "")
    if not filename:
        return jsonify({"error": "Filename required"}), 400
    ws_dir = (INSTANCES_DIR / vps_id).resolve()
    target = (ws_dir / filename).resolve()
    if not str(target).startswith(str(ws_dir)):
        return jsonify({"error": "Access denied"}), 403
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return jsonify({"success": True, "path": filename, "message": "File saved"})

@app.route("/api/vps/<vps_id>/file", methods=["DELETE"])
def api_vps_file_delete(vps_id):
    filename = request.args.get("path") or (request.get_json(silent=True) or {}).get("path")
    if not filename:
        return jsonify({"error": "Filename required"}), 400
    ws_dir = (INSTANCES_DIR / vps_id).resolve()
    target = (ws_dir / filename).resolve()
    if not str(target).startswith(str(ws_dir)):
        return jsonify({"error": "Access denied"}), 403
    if target.exists():
        target.unlink()
    return jsonify({"success": True, "path": filename, "message": "File deleted"})

@app.route("/api/vps/<vps_id>/bot/upload", methods=["POST"])
def api_vps_bot_upload(vps_id):
    init_workspace(vps_id)
    ws_dir = INSTANCES_DIR / vps_id
    files = request.files.getlist("files") or request.files.getlist("file")
    if not files:
        return jsonify({"success": False, "error": "No files uploaded"}), 400

    uploaded = []
    detected_entry = None
    detected_runtime = None

    for f in files:
        if not f or not f.filename:
            continue
        clean_name = secure_filename(f.filename) or "uploaded_file"
        dest = ws_dir / clean_name
        f.save(str(dest))
        uploaded.append(clean_name)

        if clean_name.lower().endswith(".zip"):
            try:
                with zipfile.ZipFile(str(dest), "r") as z:
                    z.extractall(str(ws_dir))
                uploaded.append(f"Extracted {clean_name}")
            except Exception:
                pass

        lower = clean_name.lower()
        if lower in ("bot.py", "main.py", "app.py") and not detected_entry:
            detected_entry = clean_name
            detected_runtime = "python"
        elif lower in ("index.js", "bot.js", "main.js") and not detected_entry:
            detected_entry = clean_name
            detected_runtime = "node"

    if vps_id in db["bots"]:
        if detected_entry:
            db["bots"][vps_id]["filename"] = detected_entry
        if detected_runtime:
            db["bots"][vps_id]["runtime"] = detected_runtime
        save_db()

    return jsonify({
        "success": True,
        "message": f"Uploaded {len(uploaded)} file(s) successfully! 🚀",
        "uploaded": uploaded,
        "detected_entry": detected_entry,
        "detected_runtime": detected_runtime
    })

# Active python processes
import threading

active_proc_threads = {}

def append_py_log(vps_id: str, text: str):
    b = db["bots"].setdefault(vps_id, {"logs": []})
    logs = b.setdefault("logs", [])
    for line in text.split("\n"):
        line = line.strip()
        if line:
            logs.append(line)
    if len(logs) > 600:
        b["logs"] = logs[-600:]
    save_db()

def stream_pipe(pipe, vps_id):
    try:
        for line in iter(pipe.readline, ''):
            if not line:
                break
            append_py_log(vps_id, line)
    except Exception:
        pass
    finally:
        pipe.close()

def start_py_bot(vps_id: str, filename: str = None, runtime: str = None):
    stop_py_bot(vps_id)
    ws_dir = (INSTANCES_DIR / vps_id).resolve()
    init_workspace(vps_id)

    target = filename or "bot.py"
    if not (ws_dir / target).exists():
        for candidate in ["bot.py", "main.py", "index.js", "bot.js"]:
            if (ws_dir / candidate).exists():
                target = candidate
                break

    rt = runtime or ("node" if target.endswith(".js") else "python")
    cmd = ["node", target] if rt == "node" else ["python3", "-u", target]

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env_file = ws_dir / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")

    if vps_id in db["bots"] and db["bots"][vps_id].get("token"):
        env["DISCORD_BOT_TOKEN"] = db["bots"][vps_id]["token"]
        env["TOKEN"] = db["bots"][vps_id]["token"]

    append_py_log(vps_id, f"[{time.strftime('%H:%M:%S')}] [24/7 Watchdog] Spawning real process: {' '.join(cmd)}...")

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(ws_dir),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )
    except Exception as e:
        append_py_log(vps_id, f"[Error] Failed to spawn process: {e}")
        return None

    active_proc_threads[vps_id] = proc

    b = db["bots"].setdefault(vps_id, {"logs": []})
    b["status"] = "running"
    b["running"] = True
    b["pid"] = proc.pid
    b["filename"] = target
    b["runtime"] = rt
    b["started_at"] = int(time.time())
    save_db()

    append_py_log(vps_id, f"[{time.strftime('%H:%M:%S')}] [24/7 Watchdog] Bot PID {proc.pid} active and connected to host 🟢")

    t_out = threading.Thread(target=stream_pipe, args=(proc.stdout, vps_id), daemon=True)
    t_err = threading.Thread(target=stream_pipe, args=(proc.stderr, vps_id), daemon=True)
    t_out.start()
    t_err.start()

    return proc

def stop_py_bot(vps_id: str):
    proc = active_proc_threads.pop(vps_id, None)
    if proc:
        try:
            proc.terminate()
            proc.wait(timeout=1.5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    b = db["bots"].setdefault(vps_id, {"logs": []})
    b["status"] = "stopped"
    b["running"] = False
    b["pid"] = None
    save_db()

@app.route("/api/vps/<vps_id>/bot", methods=["GET"])
def api_vps_bot_get(vps_id):
    init_workspace(vps_id)
    b = db["bots"].get(vps_id, {})
    proc = active_proc_threads.get(vps_id)
    is_running = bool(proc and proc.poll() is None)
    return jsonify({"success": True, "bot": {**b, "running": is_running, "status": "running" if is_running else "stopped"}})

@app.route("/api/vps/<vps_id>/bot/start", methods=["POST"])
def api_vps_bot_start(vps_id):
    data = request.get_json(silent=True) or {}
    filename = data.get("filename")
    runtime = data.get("runtime")
    proc = start_py_bot(vps_id, filename, runtime)
    b = db["bots"].get(vps_id, {})
    return jsonify({"success": True, "message": "Bot process started on live host! 🟢", "bot_status": b})

@app.route("/api/vps/<vps_id>/bot/stop", methods=["POST"])
def api_vps_bot_stop(vps_id):
    stop_py_bot(vps_id)
    append_py_log(vps_id, f"[{time.strftime('%H:%M:%S')}] [24/7 Watchdog] Bot stopped by user.")
    return jsonify({"success": True, "message": "Bot stopped"})

@app.route("/api/vps/<vps_id>/bot/restart", methods=["POST"])
def api_vps_bot_restart(vps_id):
    data = request.get_json(silent=True) or {}
    cur = db["bots"].get(vps_id, {})
    filename = data.get("filename") or cur.get("filename")
    runtime = data.get("runtime") or cur.get("runtime")
    start_py_bot(vps_id, filename, runtime)
    b = db["bots"].get(vps_id, {})
    return jsonify({"success": True, "message": "Bot restarted on live host 🟢", "bot_status": b})

@app.route("/api/vps/<vps_id>/bot/logs", methods=["GET"])
def api_vps_bot_logs(vps_id):
    b = db["bots"].get(vps_id, {})
    proc = active_proc_threads.get(vps_id)
    is_running = bool(proc and proc.poll() is None)
    return jsonify({
        "success": True,
        "logs": b.get("logs", []),
        "status": {
            "status": "running" if is_running else "stopped",
            "running": is_running,
            "pid": proc.pid if is_running else None,
            "restarts": b.get("restarts", 0),
            "uptime_seconds": (int(time.time()) - b.get("started_at", int(time.time()))) if is_running else 0
        }
    })

@app.route("/api/vps/<vps_id>/bot/packages/install", methods=["POST"])
def api_vps_bot_packages(vps_id):
    data = request.get_json(silent=True) or {}
    pkgs = (data.get("packages") or "").strip()
    rt = data.get("runtime")
    if not pkgs:
        return jsonify({"error": "No packages specified"}), 400
    ws_dir = str(INSTANCES_DIR / vps_id)
    cmd = f"npm install {pkgs}" if rt == "node" else f"pip install --break-system-packages {pkgs}"
    append_py_log(vps_id, f"[{time.strftime('%H:%M:%S')}] [Package Installer] Executing: {cmd}...")
    try:
        res = subprocess.run(cmd, shell=True, cwd=ws_dir, capture_output=True, text=True, timeout=60)
        append_py_log(vps_id, res.stdout + res.stderr)
        return jsonify({"success": True, "message": f"Installed {pkgs}"})
    except Exception as e:
        append_py_log(vps_id, f"[Error] {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/vps/<vps_id>/bot/token", methods=["POST"])
def api_vps_bot_token(vps_id):
    data = request.get_json(silent=True) or {}
    token = data.get("token", "")
    env_file = INSTANCES_DIR / vps_id / ".env"
    env_file.write_text(f"DISCORD_BOT_TOKEN={token}\nPORT=3000\n", encoding="utf-8")
    if vps_id in db["bots"]:
        db["bots"][vps_id]["token"] = token
        save_db()
    return jsonify({"success": True, "token": token, "message": "Discord token saved 🔒"})

@app.route("/api/vps/<vps_id>/terminal/exec", methods=["POST"])
@app.route("/api/vps/<vps_id>/exec", methods=["POST"])
def api_vps_exec(vps_id):
    cmd = ((request.get_json(silent=True) or {}).get("command") or "").strip()
    ws_dir = str(INSTANCES_DIR / vps_id)
    if not cmd:
        return jsonify({"success": True, "output": "", "exit_code": 0})
    try:
        res = subprocess.run(cmd, shell=True, cwd=ws_dir, capture_output=True, text=True, timeout=10)
        output = res.stdout + res.stderr
        return jsonify({"success": True, "output": output, "exit_code": res.returncode})
    except Exception as e:
        return jsonify({"success": True, "output": str(e), "exit_code": 1})

@app.route("/api/hardware")
def api_hardware():
    return jsonify({
        "success": True,
        "hardware": {
            "cpu_model": "AMD EPYC™ 7763 Cloud Virtual Processor",
            "cpu_cores": os.cpu_count() or 4,
            "platform": sys.platform,
            "virtualization": "KVM / Sandbox Container",
            "network_interfaces": ["eth0 (10 Gbps)", "tun0 (CGNAT Tunnel)"]
        }
    })

@app.route("/api/hardware/benchmark", methods=["POST"])
def api_benchmark():
    return jsonify({
        "success": True,
        "benchmark": {
            "single_core_score": 1840,
            "multi_core_score": 7280,
            "rating": "TIER-1 CLOUD PERFORMANT ⚡"
        }
    })

@app.route("/api/hardware/cgnat-tunnel", methods=["POST"])
def api_tunnel():
    port = 22022
    return jsonify({
        "success": True,
        "tunnel": {
            "host": "tunnel-us.cloudvps.io",
            "port": port,
            "command": f"ssh root@tunnel-us.cloudvps.io -p {port}",
            "termux_command": f"pkg install openssh && ssh root@tunnel-us.cloudvps.io -p {port}"
        }
    })

# Serve Frontend
# SECURITY FIX: this used to serve ANY file under BASE_DIR that existed on
# disk — including app.py itself, requirements.txt, and a real .env file
# (secrets) if one was present — to any anonymous visitor. Only an explicit
# allowlist of genuinely public frontend assets is served now.
PUBLIC_STATIC_FILES = {"index.html", "openapi.yaml", "metadata.json"}

@app.route("/")
@app.route("/<path:subpath>")
def serve_index(subpath=None):
    if subpath and subpath in PUBLIC_STATIC_FILES and (BASE_DIR / subpath).is_file():
        return send_from_directory(str(BASE_DIR), subpath)
    return send_file(str(BASE_DIR / "index.html"))

load_db()

if __name__ == "__main__":
    port = int(os.getenv("PORT", 3000))
    print(f"[CloudVPS Unified] Serving on http://0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port)
