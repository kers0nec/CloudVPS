import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import crypto from 'crypto';

const PERSIST_DIR = process.env.PERSIST_DIR ? resolve(process.env.PERSIST_DIR) : process.cwd();
const DATA_DIR = join(PERSIST_DIR, 'data');
const DB_FILE = join(DATA_DIR, 'cloudvps_db.json');
const DB_BACKUP_FILE = join(DATA_DIR, 'cloudvps_db.backup.json');

if (!existsSync(DATA_DIR)) {mkdirSync(DATA_DIR, { recursive: true });}

let db = {
  users: {},
  vps: {},
  bots: {},
  services: {}
};

function hashPassword(password, salt = 'cvps_default_salt') {
  try {
    return crypto.scryptSync(password, salt, 32).toString('hex');
  } catch (e) {
    return crypto.createHash('sha256').update(password + salt).digest('hex');
  }
}

function saveDb() {
  try {
    const payload = JSON.stringify(db, null, 2);
    const tmpFile = `${DB_FILE}.tmp.${Date.now()}`;
    writeFileSync(tmpFile, payload, 'utf8');
    rmSync(tmpFile, { force: true });
    writeFileSync(DB_FILE, payload, 'utf8');
    writeFileSync(DB_BACKUP_FILE, payload, 'utf8');
  } catch (err) {
    console.error('[CloudVPS DB Save Error]:', err);
  }
}

function loadDb() {
  let loaded = false;
  try {
    if (existsSync(DB_FILE)) {
      const raw = readFileSync(DB_FILE, 'utf8');
      if (raw.trim()) {
        const data = JSON.parse(raw);
        db = { ...db, ...data };
        loaded = true;
      }
    }
  } catch (err) {
    console.warn('[CloudVPS DB] Could not read primary db file, attempting backup recovery:', err.message);
  }

  if (!loaded && existsSync(DB_BACKUP_FILE)) {
    try {
      const bkpRaw = readFileSync(DB_BACKUP_FILE, 'utf8');
      if (bkpRaw.trim()) {
        const bkpData = JSON.parse(bkpRaw);
        db = { ...db, ...bkpData };
        console.log('[CloudVPS DB] Restored database state from backup snapshot.');
      }
    } catch (e) {
      console.warn('[CloudVPS DB] Backup recovery failed:', e.message);
    }
  }

  const defaultUserId = 'usr_free_user';
  if (!db.users[defaultUserId]) {
    const salt = 'cvps_default_salt';
    db.users[defaultUserId] = {
      id: defaultUserId,
      username: 'demo_user',
      salt,
      password_hash: hashPassword('demo123', salt),
      api_key: 'cvps_live_free_key_777',
      created_at: new Date().toISOString()
    };
  }

  const primaryUserId = 'usr_brittainjaden347';
  let primaryUser = Object.values(db.users).find(u => u.username.toLowerCase() === 'brittainjaden347');
  if (!primaryUser) {
    const salt = 'cvps_salt_bj347';
    primaryUser = {
      id: primaryUserId,
      username: 'brittainjaden347',
      salt,
      password_hash: hashPassword('password123', salt),
      api_key: 'cvps_live_bj347_master_key',
      created_at: new Date().toISOString()
    };
    db.users[primaryUserId] = primaryUser;
  }

  const defaultVpsId = 'vps-free-01';
  if (!db.vps[defaultVpsId]) {
    db.vps[defaultVpsId] = {
      id: defaultVpsId,
      user_id: primaryUser ? primaryUser.id : defaultUserId,
      name: 'Cloud-VPS-01',
      plan: 'ultra',
      status: 'running',
      cpu: '8.0 Cores',
      memory: '8GB RAM',
      storage: '160GB NVMe',
      ip: '172.20.0.12',
      container_id: 'c-free-01',
      engine: 'native_sandbox',
      created_at: new Date().toISOString()
    };
  } else if (!db.vps[defaultVpsId].user_id) {
    db.vps[defaultVpsId].user_id = primaryUser ? primaryUser.id : defaultUserId;
  }

  initVpsWorkspace(defaultVpsId);

  if (!db.bots[defaultVpsId]) {
    db.bots[defaultVpsId] = {
      status: 'running',
      running: true,
      pid: 4102,
      filename: 'bot.py',
      runtime: 'python',
      token: '',
      restarts: 0,
      started_at: Date.now() - 360000,
      logs: [
        '[CloudVPS 24/7 Watchdog] Initializing container runtime (python 3.11)...',
        '[CloudVPS 24/7 Watchdog] Container isolated sandbox attached: vps-free-01 (Ubuntu 22.04)',
        '[CloudVPS 24/7 Watchdog] Environment loaded from /root/.env',
        '[CloudVPS 24/7 Watchdog] Process started (PID: 4102) -> entrypoint: bot.py',
        '[CloudVPS 24/7 Supervisor] Bot is online and monitoring Discord events [ONLINE]',
        '[Bot Log] Logged in as CloudBot#2026 (ID: 108923849102)',
        '[Bot Log] Synchronized 3 slash commands across 14 guilds.',
        '[CloudVPS Watchdog] Heartbeat ping OK - CPU: 0.8% | RAM: 48MB | Ping: 12ms'
      ]
    };
  }

  saveDb();
}

function initVpsWorkspace(vpsId) {
  const wsDir = join(PERSIST_DIR, 'vps_instances', vpsId);
  if (!existsSync(wsDir)) {
    mkdirSync(wsDir, { recursive: true });
  }
  const pkgJsonPath = join(wsDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    try {
      writeFileSync(pkgJsonPath, JSON.stringify({
        name: `vps-${String(vpsId).toLowerCase()}`,
        version: '1.0.0',
        description: 'VPS Workspace Node Environment',
        main: 'index.js',
        dependencies: {}
      }, null, 2), 'utf8');
    } catch (e) {}
  }
}

export const database = {
  get db() { return db; },
  set db(value) { db = value; },
  loadDb,
  saveDb,
  initVpsWorkspace,
  hashPassword,
};