#!/usr/bin/env node
/**
 * CloudVPS host node daemon ("the real node").
 *
 * A dedicated Node.js process, separate from the web API, that actually
 * hosts and supervises every workload (bot processes) 24/7:
 *
 *  - spawns workloads as real OS processes in each VPS workspace,
 *  - auto-restarts crashed workloads with escalating backoff,
 *  - trips a crash-loop breaker so a fast-failing script can never starve
 *    the host,
 *  - keeps a per-workload log ring buffer the API can tail cheaply,
 *  - adopts orphaned workload processes after a daemon restart (pid
 *    journal + /proc cmdline verification) so nothing is ever double-spawned,
 *  - exposes a tiny localhost control API consumed by server.js via
 *    node-client.js.
 *
 * It binds to 127.0.0.1 by default and requires a bearer token shared with
 * the API server through <PERSIST_DIR>/data/node-worker.token (or the
 * NODE_WORKER_TOKEN env var).
 *
 * Control API (all except /health require the token):
 *   GET    /health                     liveness probe
 *   GET    /status                     node + workload summary
 *   GET    /workloads                  list workloads
 *   POST   /workloads                  start (or replace) a workload
 *   GET    /workloads/:id              one workload (404 when absent)
 *   DELETE /workloads/:id              graceful stop (idempotent)
 *   GET    /workloads/:id/logs?since=N log lines after cursor N
 */
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKER_VERSION = '1.0.0';
const PERSIST_DIR = process.env.PERSIST_DIR ? path.resolve(process.env.PERSIST_DIR) : process.cwd();
const DATA_DIR = path.join(PERSIST_DIR, 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'node-worker.token');
const PID_JOURNAL = path.join(DATA_DIR, 'node-worker.workloads.json');

const HOST = process.env.NODE_WORKER_BIND || '127.0.0.1';
const PORT = parseInt(process.env.NODE_WORKER_PORT || '3101', 10);

// Only these binaries may be launched as workloads — the control API is
// authenticated, but a second layer of allow-listing keeps a compromised or
// buggy client from turning the host node into a general command runner.
const ALLOWED_COMMANDS = new Set(['python3', 'python', 'node', 'bash', 'sh']);
const MAX_LOG_LINES = 2000;
const KILL_GRACE_MS = 1500;
const QUICK_EXIT_MS = 8000; // lifetime below this counts toward the crash loop
const CRASH_LOOP_LIMIT = 8; // rapid failures before the breaker trips
const MAX_BACKOFF_MS = 30000;
const ORPHAN_POLL_MS = 10000;

// ---------------------------------------------------------------------------
// Shared secret (API <-> host node)
// ---------------------------------------------------------------------------
function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    /* best effort */
  }
}

export function resolveToken({ createIfMissing = true } = {}) {
  if (process.env.NODE_WORKER_TOKEN) {
    return process.env.NODE_WORKER_TOKEN;
  }
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t) {
        return t;
      }
    }
    if (!createIfMissing) {
      return null;
    }
    ensureDataDir();
    const t = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_FILE, `${t}\n`, { mode: 0o600 });
    return t;
  } catch (e) {
    return null;
  }
}

function tokenMatches(provided, expected) {
  if (!expected || !provided) {
    return false;
  }
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Log ring buffer
// ---------------------------------------------------------------------------
function newBuffer() {
  return { lines: [], firstSeq: 0, logSeq: 0, partialOut: '', partialErr: '' };
}

function pushLine(wl, text) {
  const line = String(text).replace(/\s+$/, '');
  if (!line) {
    return;
  }
  wl.buffer.lines.push(line);
  wl.buffer.logSeq += 1;
  if (wl.buffer.lines.length > MAX_LOG_LINES) {
    wl.buffer.lines.splice(0, wl.buffer.lines.length - MAX_LOG_LINES);
    wl.buffer.firstSeq = wl.buffer.logSeq - wl.buffer.lines.length;
  }
}

function stamp(msg) {
  return `[${new Date().toLocaleTimeString()}] ${msg}`;
}

function flushPartial(wl, which) {
  const key = which === 'stderr' ? 'partialErr' : 'partialOut';
  const rest = wl.buffer[key];
  wl.buffer[key] = '';
  if (rest && rest.trim()) {
    pushLine(wl, rest);
  }
}

// ---------------------------------------------------------------------------
// Workload registry
// ---------------------------------------------------------------------------
const workloads = new Map(); // id -> workload record

function summarize(wl) {
  return {
    id: wl.id,
    status: wl.status,
    pid:
      wl.status === 'running' || wl.status === 'restarting' || wl.status === 'stopping'
        ? wl.pid
        : null,
    command: wl.spec.command,
    args: wl.spec.args,
    cwd: wl.spec.cwd,
    started_at: wl.startedAt,
    restarts: wl.restarts,
    adopted: !!wl.adopted,
    crash_count: wl.crash ? wl.crash.count : 0,
    log_cursor: wl.buffer.logSeq,
    last_exit: wl.lastExit || null,
  };
}

function journalWrite() {
  try {
    const data = {};
    for (const wl of workloads.values()) {
      if (
        wl.pid &&
        (wl.status === 'running' || wl.status === 'restarting' || wl.status === 'stopping')
      ) {
        data[wl.id] = {
          pid: wl.pid,
          command: wl.spec.command,
          args: wl.spec.args,
          cwd: wl.spec.cwd,
          startedAt: wl.startedAt,
        };
      }
    }
    fs.writeFileSync(PID_JOURNAL, JSON.stringify(data), 'utf8');
  } catch (e) {
    /* best effort */
  }
}

function journalRemove(id) {
  try {
    if (!fs.existsSync(PID_JOURNAL)) {
      return;
    }
    const data = JSON.parse(fs.readFileSync(PID_JOURNAL, 'utf8'));
    if (data[id]) {
      delete data[id];
      fs.writeFileSync(PID_JOURNAL, JSON.stringify(data), 'utf8');
    }
  } catch (e) {
    /* best effort */
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Verify /proc/<pid>/cmdline still matches the recorded command+args so a
 * recycled PID can never be adopted (or killed) by mistake. */
function cmdlineMatches(pid, spec) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
    const parts = raw.toString('utf8').split('\0').filter(Boolean);
    if (parts.length === 0) {
      return false;
    }
    const base = p => path.basename(p);
    if (base(parts[0]) !== base(spec.command) && parts[0] !== spec.command) {
      return false;
    }
    for (let i = 0; i < spec.args.length; i++) {
      if (parts[i + 1] !== spec.args[i]) {
        return false;
      }
    }
    return true;
  } catch (e) {
    return false; // cannot verify -> never adopt
  }
}

// ---------------------------------------------------------------------------
// Spawn / stop / supervise
// ---------------------------------------------------------------------------
function spawnWorkload(wl) {
  {
    const env = { ...process.env, ...wl.spec.env };
    let child;
    try {
      child = spawn(wl.spec.command, wl.spec.args, {
        cwd: wl.spec.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      handleExit(wl, { code: -1, signal: null, spawnError: err });
      return Promise.resolve(null);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      wl.buffer.partialOut += chunk;
      const parts = wl.buffer.partialOut.split('\n');
      wl.buffer.partialOut = parts.pop();
      parts.forEach(p => pushLine(wl, p));
    });
    child.stderr.on('data', chunk => {
      wl.buffer.partialErr += chunk;
      const parts = wl.buffer.partialErr.split('\n');
      wl.buffer.partialErr = parts.pop();
      parts.forEach(p => pushLine(wl, p));
    });

    child.on('error', err => {
      pushLine(wl, stamp(`[Process Error] ${err.message}`));
    });

    child.on('close', (code, signal) => {
      // A replaced record's late close must never touch the new workload.
      if (workloads.get(wl.id) !== wl) {
        return;
      }
      handleExit(wl, { code, signal });
    });

    wl.child = child;
    wl.pid = child.pid;
    wl.adopted = false;
    wl.status = 'running';
    wl.startedAt = Date.now();
    journalWrite();
    return Promise.resolve(child);
  }
}

function startWorkload(spec) {
  // Replace any existing record (fresh crash state + fresh log buffer),
  // killing the previous process hard so a (re)start is deterministic.
  const existing = workloads.get(spec.id);
  if (existing) {
    killRecord(existing, 'SIGKILL');
  }

  const wl = {
    id: spec.id,
    spec: { command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env || {} },
    child: null,
    pid: null,
    adopted: false,
    status: 'restarting',
    startedAt: null,
    restarts: 0,
    crash: { count: 0, windowStart: Date.now() },
    restartTimer: null,
    killTimer: null,
    buffer: newBuffer(),
    lastExit: null,
  };
  workloads.set(spec.id, wl);

  pushLine(
    wl,
    stamp(`[24/7 Watchdog] Spawning real process: ${wl.spec.command} ${wl.spec.args.join(' ')}...`)
  );
  return spawnWorkload(wl).then(child => {
    if (workloads.get(wl.id) !== wl) {
      return summarize(wl);
    }
    if (child && child.pid) {
      pushLine(
        wl,
        stamp(`[24/7 Watchdog] Bot PID ${child.pid} active and connected to host node [ONLINE]`)
      );
    }
    return summarize(wl);
  });
}

function killRecord(wl, signal = 'SIGTERM') {
  if (wl.restartTimer) {
    clearTimeout(wl.restartTimer);
    wl.restartTimer = null;
  }
  if (wl.adopted && wl.pid) {
    try {
      process.kill(wl.pid, signal);
    } catch (e) {
      /* already gone */
    }
    return;
  }
  if (wl.child) {
    if (wl.status !== 'stopping' && signal !== 'SIGKILL') {
      wl.status = 'stopping';
    }
    try {
      wl.child.kill(signal);
    } catch (e) {
      /* already gone */
    }
  }
}

function stopWorkload(id) {
  const wl = workloads.get(id);
  if (!wl) {
    return { ok: true, status: 'absent' };
  }

  wl.status = 'stopping';
  wl.stopping = true;
  killRecord(wl, 'SIGTERM');

  const finish = () => {
    if (workloads.get(id) === wl) {
      wl.status = 'stopped';
      wl.pid = null;
      wl.child = null;
      wl.adopted = false;
      pushLine(wl, stamp(`[24/7 Watchdog] Workload stopped.`));
      journalRemove(id);
    }
  };

  if (wl.adopted || !wl.child) {
    // No close event will arrive for an adopted (or already-dead) process:
    // report stopped right away, but keep watching the PID so a workload that
    // ignores SIGTERM still gets SIGKILLed after the grace period.
    const adoptedPid = wl.pid;
    finish();
    if (adoptedPid) {
      const forceKill = setTimeout(() => {
        if (pidAlive(adoptedPid)) {
          try {
            process.kill(adoptedPid, 'SIGKILL');
          } catch (e) {
            /* gone */
          }
        }
      }, KILL_GRACE_MS);
      if (forceKill.unref) {
        forceKill.unref();
      }
    }
    return { ok: true, status: 'stopped' };
  }

  wl.killTimer = setTimeout(() => {
    if (wl.status === 'stopping' && wl.child && wl.child.exitCode === null && !wl.child.killed) {
      try {
        wl.child.kill('SIGKILL');
      } catch (e) {
        /* gone */
      }
    }
  }, KILL_GRACE_MS);
  if (wl.killTimer.unref) {
    wl.killTimer.unref();
  }
  return { ok: true, status: 'stopping' };
}

function handleExit(wl, { code, signal, spawnError = null }) {
  flushPartial(wl, 'stdout');
  flushPartial(wl, 'stderr');

  const wasStopping = wl.stopping || wl.status === 'stopping';
  const lifetime = wl.startedAt ? Date.now() - wl.startedAt : 0;
  wl.lastExit = {
    code,
    signal,
    at: Date.now(),
    spawn_error: spawnError ? spawnError.message : null,
  };

  if (wasStopping) {
    wl.status = 'stopped';
    wl.pid = null;
    wl.child = null;
    journalRemove(wl.id);
    pushLine(
      wl,
      stamp(
        `[Process Exit] Process terminated with exit code ${code} (signal: ${signal || 'none'})`
      )
    );
    return;
  }

  pushLine(
    wl,
    stamp(`[Process Exit] Process terminated with exit code ${code} (signal: ${signal || 'none'})`)
  );

  // Crash-loop breaker: measured at exit time. Rapid, repeated failures
  // (bad syntax, missing token...) must stop instead of hammering the host.
  if (lifetime < QUICK_EXIT_MS) {
    wl.crash.count += 1;
  } else {
    wl.crash.count = 0;
  }

  if (wl.crash.count >= CRASH_LOOP_LIMIT) {
    wl.status = 'error';
    wl.pid = null;
    wl.child = null;
    journalRemove(wl.id);
    pushLine(
      wl,
      stamp(
        `[24/7 Watchdog] Process keeps crashing (${wl.crash.count} times in a row) — stopping auto-restart to protect the host. Fix the error, then start the workload again.`
      )
    );
    return;
  }

  const delay = Math.min(wl.crash.count * 3000, MAX_BACKOFF_MS);
  wl.status = 'restarting';
  wl.pid = null;
  wl.restarts += 1;
  pushLine(
    wl,
    stamp(
      `[24/7 Watchdog] Auto-restarting in ${Math.round(delay / 1000)}s (Restart #${wl.restarts})...`
    )
  );
  wl.restartTimer = setTimeout(() => {
    wl.restartTimer = null;
    if (workloads.get(wl.id) !== wl || wl.stopping) {
      return;
    }
    spawnWorkload(wl);
  }, delay);
  if (wl.restartTimer.unref) {
    wl.restartTimer.unref();
  }
}

// Adopt orphaned workload processes left behind by a daemon crash/restart so
// the reconciler in server.js never double-spawns a live process.
function adoptOrphans() {
  let journal = {};
  try {
    if (fs.existsSync(PID_JOURNAL)) {
      journal = JSON.parse(fs.readFileSync(PID_JOURNAL, 'utf8'));
    }
  } catch (e) {
    return;
  }

  for (const [id, rec] of Object.entries(journal)) {
    if (workloads.has(id)) {
      continue;
    }
    if (!rec || !rec.pid || rec.pid === process.pid) {
      continue;
    }
    if (!pidAlive(rec.pid) || !cmdlineMatches(rec.pid, rec)) {
      journalRemove(id);
      continue;
    }
    const wl = {
      id,
      spec: { command: rec.command, args: rec.args || [], cwd: rec.cwd, env: {} },
      child: null,
      pid: rec.pid,
      adopted: true,
      status: 'running',
      startedAt: rec.startedAt || null,
      restarts: 0,
      crash: { count: 0, windowStart: Date.now() },
      restartTimer: null,
      killTimer: null,
      buffer: newBuffer(),
      lastExit: null,
    };
    workloads.set(id, wl);
    pushLine(
      wl,
      stamp(
        `[24/7 Watchdog] Re-adopted still-running process PID ${rec.pid} after host-node restart [ONLINE]`
      )
    );
  }
}

// Periodic liveness check for adopted processes (no child handle => no
// 'close' event): when one dies, fall through the normal restart logic.
setInterval(() => {
  for (const wl of workloads.values()) {
    if (!wl.adopted || !wl.pid) {
      continue;
    }
    if (wl.status === 'stopping' || wl.status === 'stopped') {
      continue;
    }
    if (!pidAlive(wl.pid) || !cmdlineMatches(wl.pid, wl.spec)) {
      wl.pid = null;
      wl.adopted = false;
      handleExit(wl, { code: null, signal: null });
    }
  }
}, ORPHAN_POLL_MS).unref();

// ---------------------------------------------------------------------------
// HTTP control API
// ---------------------------------------------------------------------------
export function createWorkerApp({ token } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  const expectedToken = token !== undefined ? token : resolveToken();

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      role: 'cloudvps-host-node',
      version: WORKER_VERSION,
      uptime_s: Math.floor(process.uptime()),
    });
  });

  app.use((req, res, next) => {
    if (req.path === '/health') {
      return next();
    }
    const header = req.headers.authorization || '';
    const provided = header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : req.headers['x-node-token'] || '';
    if (!tokenMatches(provided, expectedToken)) {
      return res.status(401).json({ ok: false, error: 'Invalid host-node token' });
    }
    next();
  });

  app.use((req, res, next) => {
    res.on('finish', () => {
      if (process.env.NODE_WORKER_DEBUG === '1') {
        console.log(`[host-node] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
      }
    });
    next();
  });

  app.get('/status', (req, res) => {
    const all = Array.from(workloads.values());
    const counts = {
      total: all.length,
      running: 0,
      restarting: 0,
      stopping: 0,
      stopped: 0,
      error: 0,
    };
    for (const wl of all) {
      if (counts[wl.status] !== undefined) {
        counts[wl.status] += 1;
      }
    }
    const mem = process.memoryUsage();
    res.json({
      ok: true,
      role: 'cloudvps-host-node',
      version: WORKER_VERSION,
      hostname: os.hostname(),
      pid: process.pid,
      platform: `${os.type()} ${os.release()}`,
      arch: process.arch,
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      uptime_s: Math.floor(process.uptime()),
      load_avg: Number(os.loadavg()[0].toFixed(2)),
      memory: {
        rss_mb: Math.round(mem.rss / 1048576),
        heap_mb: Math.round(mem.heapUsed / 1048576),
      },
      workloads: counts,
      checked_at: new Date().toISOString(),
    });
  });

  app.get('/workloads', (req, res) => {
    res.json({ ok: true, workloads: Array.from(workloads.values()).map(summarize) });
  });

  app.post('/workloads', (req, res, next) => {
    const { id, command, args, cwd, env } = req.body || {};
    if (!id || typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid workload id' });
    }
    if (!ALLOWED_COMMANDS.has(command)) {
      return res.status(400).json({
        ok: false,
        error: `Command not allowed (use one of: ${[...ALLOWED_COMMANDS].join(', ')})`,
      });
    }
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) {
      return res.status(400).json({ ok: false, error: 'args must be an array of strings' });
    }
    if (!cwd || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      return res.status(400).json({ ok: false, error: 'cwd must be an absolute path' });
    }
    try {
      if (!fs.statSync(cwd).isDirectory()) {
        return res.status(400).json({ ok: false, error: 'cwd is not a directory' });
      }
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'cwd does not exist' });
    }
    if (
      env !== undefined &&
      (typeof env !== 'object' ||
        env === null ||
        Object.values(env).some(v => typeof v !== 'string'))
    ) {
      return res.status(400).json({ ok: false, error: 'env must be an object of string values' });
    }

    startWorkload({ id, command, args, cwd, env })
      .then(summary => res.status(201).json({ ok: true, workload: summary }))
      .catch(next);
  });

  app.get('/workloads/:id', (req, res) => {
    const wl = workloads.get(req.params.id);
    if (!wl) {
      return res.status(404).json({ ok: false, error: 'Workload not found' });
    }
    res.json({ ok: true, workload: summarize(wl) });
  });

  app.delete('/workloads/:id', (req, res) => {
    const result = stopWorkload(req.params.id);
    res.json(result);
  });

  app.get('/workloads/:id/logs', (req, res) => {
    const wl = workloads.get(req.params.id);
    if (!wl) {
      return res.status(404).json({ ok: false, error: 'Workload not found' });
    }
    let since = parseInt(req.query.since || '0', 10);
    if (!Number.isFinite(since) || since < 0) {
      since = 0;
    }
    // A cursor from a previous buffer generation (daemon restart / restart of
    // the workload itself) would silently swallow new lines — clamp it.
    if (since > wl.buffer.logSeq) {
      since = wl.buffer.firstSeq;
    }
    const startIdx = Math.max(0, since - wl.buffer.firstSeq);
    const truncated = wl.buffer.firstSeq > since;
    res.json({
      ok: true,
      lines: wl.buffer.lines.slice(startIdx),
      cursor: wl.buffer.logSeq,
      oldest: wl.buffer.firstSeq,
      truncated,
      status: wl.status,
    });
  });

  app.use((err, req, res, _next) => {
    console.error('[host-node] request error:', err);
    res.status(500).json({ ok: false, error: 'Host node internal error' });
  });

  return app;
}

export function startWorker({ host = HOST, port = PORT } = {}) {
  ensureDataDir();
  resolveToken(); // make sure the shared token file exists before the API boots
  adoptOrphans();

  const app = createWorkerApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const actual = server.address().port;
      console.log(
        `[CloudVPS Host Node] listening on http://${host}:${actual} (pid ${process.pid}, version ${WORKER_VERSION})`
      );
      resolve({ server, port: actual });
    });
    server.on('error', reject);
  });
}

function shutdown(signal) {
  console.log(`[CloudVPS Host Node] ${signal} received — stopping ${workloads.size} workload(s)`);
  for (const wl of workloads.values()) {
    wl.stopping = true;
    killRecord(wl, 'SIGTERM');
  }
  setTimeout(() => {
    for (const wl of workloads.values()) {
      killRecord(wl, 'SIGKILL');
    }
    process.exit(0);
  }, KILL_GRACE_MS).unref();
  // Don't wait forever: children die with the daemon if needed (and are
  // re-adopted from the pid journal when the daemon comes back).
  const t = setTimeout(() => process.exit(0), 4000);
  t.unref();
  // Exit promptly once nothing is running.
  const poll = setInterval(() => {
    const alive = Array.from(workloads.values()).some(wl => wl.child && wl.child.exitCode === null);
    if (!alive) {
      clearInterval(poll);
      process.exit(0);
    }
  }, 100);
  poll.unref();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  startWorker().catch(err => {
    console.error('[CloudVPS Host Node] failed to start:', err.message);
    process.exit(1);
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
