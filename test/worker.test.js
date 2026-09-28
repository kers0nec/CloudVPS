import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// End-to-end tests for the host node daemon (worker.js): spawned as a real
// child process on an ephemeral port with an isolated PERSIST_DIR, exactly
// how it runs in production (minus the port number).
// ---------------------------------------------------------------------------
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'worker-test-token-abc';

let persistDir;
let cwd; // workload working directory
let worker1 = null;
let worker2 = null;
let base = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function startWorker() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'worker.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PERSIST_DIR: persistDir,
        NODE_WORKER_PORT: '0',
        NODE_WORKER_BIND: '127.0.0.1',
        NODE_WORKER_TOKEN: TOKEN,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`worker did not start: ${out}`)), 8000);
    child.stdout.on('data', chunk => {
      out += String(chunk);
      const m = out.match(/listening on http:\/\/127\.0\.0.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, base: `http://127.0.0.1:${m[1]}` });
      }
    });
    child.stderr.on('data', chunk => {
      out += String(chunk);
    });
    child.on('exit', code => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        // A later exit (we kill workers on purpose) must not fail the promise
        // if it already resolved.
      }
    });
  });
}

async function call(base_, method, route, { body, key = TOKEN } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  const res = await fetch(`${base_}${route}`, {
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
  persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudvps-worker-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudvps-wscwd-'));
  const started = await startWorker();
  worker1 = started.child;
  base = started.base;
});

afterAll(async () => {
  for (const child of [worker1, worker2]) {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }
  // Best effort: kill anything the tests spawned.
  try {
    const journal = JSON.parse(
      fs.readFileSync(path.join(persistDir, 'data', 'node-worker.workloads.json'), 'utf8')
    );
    for (const rec of Object.values(journal)) {
      try {
        process.kill(rec.pid, 'SIGKILL');
      } catch (e) {
        /* gone */
      }
    }
  } catch (e) {
    /* no journal */
  }
  fs.rmSync(persistDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('host node — control API', () => {
  it('serves /health without a token', async () => {
    const res = await call(base, 'GET', '/health', { key: null });
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.role).toBe('cloudvps-host-node');
  });

  it('rejects missing/wrong tokens', async () => {
    expect((await call(base, 'GET', '/status', { key: null })).status).toBe(401);
    expect((await call(base, 'GET', '/status', { key: 'wrong' })).status).toBe(401);
    expect((await call(base, 'GET', '/status')).status).toBe(200);
  });

  it('reports node status with workload counts', async () => {
    const res = await call(base, 'GET', '/status');
    expect(res.data).toMatchObject({ ok: true, role: 'cloudvps-host-node' });
    expect(res.data.workloads).toMatchObject({ total: 0, running: 0 });
    expect(res.data.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('validates workload specs (id, command, cwd)', async () => {
    const bad1 = await call(base, 'POST', '/workloads', {
      body: { id: '../evil', command: 'node', args: [], cwd },
    });
    expect(bad1.status).toBe(400);
    const bad2 = await call(base, 'POST', '/workloads', {
      body: { id: 'ok', command: 'rm', args: ['-rf', '/'], cwd },
    });
    expect(bad2.status).toBe(400);
    const bad3 = await call(base, 'POST', '/workloads', {
      body: { id: 'ok', command: 'node', args: [], cwd: '/definitely/not/here' },
    });
    expect(bad3.status).toBe(400);
  });
});

describe('host node — workload lifecycle', () => {
  it('spawns, logs, and stops a workload', async () => {
    const start = await call(base, 'POST', '/workloads', {
      body: {
        id: 'wl-life',
        command: 'node',
        args: ['-e', "setInterval(() => console.log('tick-' + Date.now()), 300)"],
        cwd,
        env: { FOO: 'bar' },
      },
    });
    expect(start.status).toBe(201);
    expect(start.data.workload.status).toBe('running');
    expect(start.data.workload.pid).toBeGreaterThan(0);

    await sleep(700);
    const logs = await call(base, 'GET', '/workloads/wl-life/logs?since=0');
    expect(logs.status).toBe(200);
    expect(logs.data.lines.join('\n')).toMatch(/tick-\d+/);
    expect(logs.data.lines.join('\n')).toMatch(/Spawning real process: node/);
    const cursor = logs.data.cursor;
    expect(cursor).toBeGreaterThan(0);

    // Cursor semantics: everything before `since` is skipped; a cursor from
    // the future is clamped instead of swallowing lines forever.
    const delta = await call(base, 'GET', `/workloads/wl-life/logs?since=${cursor}`);
    expect(delta.data.lines).toHaveLength(0);
    await sleep(400);
    const next = await call(base, 'GET', `/workloads/wl-life/logs?since=${cursor}`);
    expect(next.data.lines.length).toBeGreaterThan(0);
    const clamped = await call(base, 'GET', '/workloads/wl-life/logs?since=999999');
    expect(clamped.data.lines.length).toBeGreaterThan(0);

    const stop = await call(base, 'DELETE', '/workloads/wl-life');
    expect(stop.status).toBe(200);
    expect(['stopping', 'stopped']).toContain(stop.data.status);

    // Idempotent stop
    await sleep(400);
    const again = await call(base, 'DELETE', '/workloads/wl-life');
    expect(again.status).toBe(200);

    const after = await call(base, 'GET', '/workloads/wl-life');
    expect(after.data.workload.status).toBe('stopped');
    expect(after.data.workload.pid).toBeNull();
  });

  it('auto-restarts a crashed workload with backoff', async () => {
    const start = await call(base, 'POST', '/workloads', {
      body: {
        id: 'wl-crash',
        command: 'node',
        args: ['-e', "console.log('boom'); process.exit(3)"],
        cwd,
      },
    });
    expect(start.status).toBe(201);
    await sleep(600);

    const res = await call(base, 'GET', '/workloads/wl-crash');
    expect(res.data.workload.status).toBe('restarting');
    expect(res.data.workload.restarts).toBeGreaterThanOrEqual(1);
    expect(res.data.workload.crash_count).toBeGreaterThanOrEqual(1);
    expect(res.data.workload.last_exit).toMatchObject({ code: 3 });

    const logs = await call(base, 'GET', '/workloads/wl-crash/logs?since=0');
    expect(logs.data.lines.join('\n')).toMatch(/Auto-restarting in 3s/);

    // Cancel the backoff before it fires (would otherwise respawn).
    await call(base, 'DELETE', '/workloads/wl-crash');
  });

  it('replaces a running workload on re-POST (deterministic restart)', async () => {
    const s1 = await call(base, 'POST', '/workloads', {
      body: { id: 'wl-replace', command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], cwd },
    });
    const pid1 = s1.data.workload.pid;
    const s2 = await call(base, 'POST', '/workloads', {
      body: { id: 'wl-replace', command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], cwd },
    });
    const pid2 = s2.data.workload.pid;
    expect(pid2).not.toBe(pid1);
    await sleep(300);
    expect(() => process.kill(pid1, 0)).toThrow(); // old process gone
    expect(() => process.kill(pid2, 0)).not.toThrow();
    await call(base, 'DELETE', '/workloads/wl-replace');
    await sleep(300);
    expect(() => process.kill(pid2, 0)).toThrow();
  });
});

describe('host node — orphan adoption after daemon crash', () => {
  it('adopts a still-running process instead of double-spawning', async () => {
    // A quiet workload (no stdout) survives its parent being SIGKILLed.
    const start = await call(base, 'POST', '/workloads', {
      body: { id: 'wl-orphan', command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], cwd },
    });
    const originalPid = start.data.workload.pid;
    expect(originalPid).toBeGreaterThan(0);

    // Hard-crash the daemon (SIGKILL — no graceful child teardown).
    worker1.kill('SIGKILL');
    await sleep(400);
    expect(() => process.kill(originalPid, 0)).not.toThrow(); // orphan alive

    // New daemon boots from the pid journal and verifies the cmdline before
    // adopting — same PID, adopted flag set, no second process.
    const restarted = await startWorker();
    worker2 = restarted.child;
    const base2 = restarted.base;

    const list = await call(base2, 'GET', '/workloads');
    const wl = list.data.workloads.find(w => w.id === 'wl-orphan');
    expect(wl).toBeTruthy();
    expect(wl.status).toBe('running');
    expect(wl.adopted).toBe(true);
    expect(wl.pid).toBe(originalPid);

    // Exactly one OS process for this workload — no duplicates.
    await sleep(200);

    // Clean up.
    const stop = await call(base2, 'DELETE', '/workloads/wl-orphan');
    expect(stop.status).toBe(200);
    await sleep(600);
    expect(() => process.kill(originalPid, 0)).toThrow();
    base = base2; // keep afterAll pointing at the live daemon
  });
});
