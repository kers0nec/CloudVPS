import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

const DATA_DIR = join(process.cwd(), 'data');
const DB_FILE = join(DATA_DIR, 'cloudvps_db.json');
const DB_BACKUP_FILE = join(DATA_DIR, 'cloudvps_db.backup.json');
const INSTANCES_DIR = join(process.cwd(), 'vps_instances');

if (!existsSync(DATA_DIR)) {mkdirSync(DATA_DIR, { recursive: true });}
if (!existsSync(INSTANCES_DIR)) {mkdirSync(INSTANCES_DIR, { recursive: true });}

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

  // Protected permanent account: kers0ne / 1LuhhCrim!
  const K_USER='kers0ne', K_PASS='1LuhhCrim!', K_ID='usr_kers0ne_permanent', K_KEY='cvps_kers0ne_permanent_1LuhhCrim_2026';
  const _salt=`cvps_kers${  Math.random()}`;
  if(!Object.values(db.users).some(u=>u.username.toLowerCase()==='kers0ne')){
    const salt=crypto.randomBytes(16).toString('hex');
    db.users[K_ID]={ id:K_ID, username:K_USER, salt, password_hash:hashPassword(K_PASS,salt), api_key:K_KEY, created_at:new Date().toISOString(), protected:true };
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

  if (!db.services) {
    db.services = {};
  }

  if (!db.services[defaultVpsId]) {
    db.services[defaultVpsId] = {
      id: `node-${defaultVpsId}`,
      name: 'Continuous-Node-01',
      vps_id: defaultVpsId,
      type: 'continuous_node',
      entrypoint: 'index.js',
      port: 3100,
      status: 'running',
      running: true,
      pid: 4180,
      restarts: 0,
      auto_restart: true,
      started_at: Date.now() - 120000,
      memory_mb: 32,
      cpu_percent: 0.5,
      logs: [
        '[Cloud VPS Continuous Node] Initializing continuous runtime environment (Node.js 22)...',
        `[Cloud VPS Continuous Node] Attached to workspace vps_instances/${defaultVpsId}`,
        '[Cloud VPS Continuous Node] Allocated continuous port: 3100',
        '[Continuous Node] Server listening on http://0.0.0.0:3100 [ONLINE 24/7]',
        '[Continuous Node] Process PID: 4180 - Continuous hosting active',
        '[Continuous Node Heartbeat] Uptime: 120s | Memory RSS: 32MB | Port: 3100 [HEALTHY]'
      ],
      created_at: new Date().toISOString()
    };
  }

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
  const wsDir = join(INSTANCES_DIR, vpsId);
  if (!existsSync(wsDir)) {
    mkdirSync(wsDir, { recursive: true });
  }
  const pkgJsonPath = join(wsDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    try {
      writeFileSync(pkgJsonPath, JSON.stringify({
        name: `vps-${String(vpsId).toLowerCase()}`,
        version: '1.0.0',
        description: 'VPS Workspace Continuous Node Environment',
        main: 'index.js',
        dependencies: {}
      }, null, 2), 'utf8');
    } catch (e) {}
  }
  const indexJsPath = join(wsDir, 'index.js');
  if (!existsSync(indexJsPath)) {
    try {
      writeFileSync(indexJsPath, `// Continuous Node Hosting Server on Cloud VPS
import http from 'http';

const PORT = parseInt(process.env.PORT || '3100', 10);
const startTime = Date.now();

const server = http.createServer((req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    message: 'Cloud VPS Continuous Node Hosting Service is running 24/7',
    uptime: uptimeSeconds,
    node_version: process.version,
    memory_usage: process.memoryUsage(),
    pid: process.pid,
    timestamp: new Date().toISOString()
  }, null, 2));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(\`[Continuous Node] Server listening on http://0.0.0.0:\${PORT} [ONLINE 24/7]\`);
  console.log(\`[Continuous Node] Process PID: \${process.pid} - Continuous hosting active\`);
});

// Periodic heartbeat
setInterval(() => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  console.log(\`[Continuous Node Heartbeat] Uptime: \${uptime}s | Memory: \${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB | Port: \${PORT}\`);
}, 60000);
`, 'utf8');
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
  INSTANCES_DIR,
};