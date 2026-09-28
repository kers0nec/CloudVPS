import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Boot-level regression test: boots the REAL server.js as a child process
// against an isolated PERSIST_DIR, twice.
//
// The second boot is the critical part: `loadDb()` replaces the module-level
// `db` object when the database file already exists, so anything that
// captures `db` by value at route-registration time ends up looking at a
// stale, empty database. (The first boot has no DB file yet, which is
// exactly how that bug slipped past a single-boot smoke test.)
// ---------------------------------------------------------------------------
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let persistDir;
let port;
let child = null;
let childLog = '';
let apiKey;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function startServer() {
  childLog = '';
  const child_ = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PERSIST_DIR: persistDir,
      PORT: String(port),
      AUTH_RATE_LIMIT: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = child_;
  child_.stdout.on('data', c => {
    childLog += String(c);
  });
  child_.stderr.on('data', c => {
    childLog += String(c);
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (childLog.includes(`Server listening on http://0.0.0.0:${port}`)) {
      return;
    }
    if (child_.exitCode !== null) {
      throw new Error(`server exited early:\n${childLog}`);
    }
    await sleep(100);
  }
  throw new Error(`server did not start in time:\n${childLog}`);
}

async function stopServer(signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) {
    child = null;
    return;
  }
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill(signal);
  const timeout = sleep(3500).then(() => 'timeout');
  const result = await Promise.race([exited.then(() => 'exited'), timeout]);
  if (result === 'timeout' && child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  child = null;
}

async function req(method, url, { key, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) {
    headers['x-api-key'] = key;
  }
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* non-JSON */
  }
  return { status: res.status, data };
}

beforeAll(async () => {
  persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudvps-boot-'));
  port = await freePort();

  // Boot #1: empty PERSIST_DIR — create the account + database file.
  await startServer();
  const reg = await req('POST', '/api/register', {
    body: { username: 'boottester', password: 'password123' },
  });
  expect(reg.status).toBe(200);
  apiKey = reg.data.api_key;
  await sleep(150); // let the coalesced DB write flush to disk
  await stopServer('SIGKILL'); // DB file is fully written; skip graceful wait

  // Boot #2: the DB file now exists → loadDb() reassigns `db`.
  await startServer();
}, 40000);

afterAll(async () => {
  await stopServer('SIGTERM');
  fs.rmSync(persistDir, { recursive: true, force: true });
});

describe('server boot with existing database (stale-db regression)', () => {
  it('v1 list sees persisted resources on the second boot', async () => {
    const res = await req('GET', '/api/v1/resources', { key: apiKey });
    expect(res.status).toBe(200);
    // The starter VPS provisioned during register must be visible — a
    // captured (stale) db reference would return an empty list here.
    expect(res.data.count).toBeGreaterThanOrEqual(1);
    expect(res.data.resources.some(r => r.user_id)).toBe(true);
  });

  it('v1 node status answers on a real boot', async () => {
    const res = await req('GET', '/api/v1/node', { key: apiKey });
    expect(res.status).toBe(200);
    expect(res.data.node).toBeTruthy();
    expect(typeof res.data.node.reachable).toBe('boolean');
  });

  it('full v1 resource roundtrip works against the live server', async () => {
    const create = await req('POST', '/api/v1/resources', {
      key: apiKey,
      body: { name: 'boot-roundtrip', plan: 'starter', auto_install: false },
    });
    expect(create.status).toBe(201);
    const id = create.data.resource.id;

    const detail = await req('GET', `/api/v1/resources/${id}`, { key: apiKey });
    expect(detail.status).toBe(200);
    expect(detail.data.resource.name).toBe('boot-roundtrip');

    const patch = await req('PATCH', `/api/v1/resources/${id}`, {
      key: apiKey,
      body: { name: 'boot-renamed' },
    });
    expect(patch.status).toBe(200);
    expect(patch.data.resource.name).toBe('boot-renamed');

    const write = await req('PUT', `/api/v1/resources/${id}/files/content`, {
      key: apiKey,
      body: { path: 'hello.py', content: 'print("hi")' },
    });
    expect(write.status).toBe(200);

    const del = await req('DELETE', `/api/v1/resources/${id}`, { key: apiKey });
    expect(del.status).toBe(200);
    expect(del.data.terminated).toBe(true);

    const gone = await req('GET', `/api/v1/resources/${id}`, { key: apiKey });
    expect(gone.status).toBe(404);
  });

  it('legacy dashboard endpoints still work on the second boot', async () => {
    const list = await req('GET', '/api/vps', { key: apiKey });
    expect(list.status).toBe(200);
    expect(list.data.vps.length).toBeGreaterThanOrEqual(1);

    const health = await req('GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.data.node).toBeTruthy();
  });
});
