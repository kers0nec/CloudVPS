#!/usr/bin/env node
/**
 * CloudVPS process launcher.
 *
 * Starts and supervises both halves of the platform as one unit:
 *   1. worker.js  — the host node daemon (real 24/7 workload hosting)
 *   2. server.js  — the web API + dashboard
 *
 * Either child is restarted automatically if it crashes (with exponential
 * backoff, capped), and SIGINT/SIGTERM from the platform (Render, Docker,
 * systemd) is forwarded to both for a clean shutdown. This is what `npm
 * start` and the deployment configs run, so a single command brings up the
 * full stack.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CHILDREN = [
  { name: 'host-node', script: 'worker.js' },
  { name: 'api', script: 'server.js' },
];

const MAX_BACKOFF_MS = 30000;
const RESET_AFTER_MS = 60000;

let shuttingDown = false;
const state = new Map();

function startChild(def) {
  const entry = state.get(def.name) || { restarts: 0, lastStart: 0 };
  state.set(def.name, entry);

  const child = spawn(process.execPath, [path.join(ROOT, def.script)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  entry.child = child;
  entry.lastStart = Date.now();
  console.log(`[launcher] started ${def.name} (${def.script}) pid=${child.pid}`);

  child.on('exit', (code, signal) => {
    if (entry.child === child) {
      entry.child = null;
    }
    if (shuttingDown) {
      if (Array.from(state.values()).every(s => !s.child)) {
        process.exit(0);
      }
      return;
    }
    console.error(`[launcher] ${def.name} exited (code=${code} signal=${signal}) — restarting`);
    // Reset the backoff counter when a child stayed up long enough to be
    // considered healthy, so a rare crash doesn't accumulate delay forever.
    if (Date.now() - entry.lastStart > RESET_AFTER_MS) {
      entry.restarts = 0;
    }
    const delay = Math.min(1000 * 2 ** entry.restarts, MAX_BACKOFF_MS);
    entry.restarts += 1;
    setTimeout(() => {
      if (!shuttingDown) {
        startChild(def);
      }
    }, delay).unref?.();
  });
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[launcher] ${signal} received — stopping children`);
  for (const { child } of state.values()) {
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch (e) {
        /* already gone */
      }
    }
  }
  setTimeout(() => {
    for (const { child } of state.values()) {
      if (child) {
        try {
          child.kill('SIGKILL');
        } catch (e) {
          /* gone */
        }
      }
    }
    process.exit(0);
  }, 6000).unref();
}

for (const def of CHILDREN) {
  startChild(def);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
