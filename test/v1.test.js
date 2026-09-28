import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createV1Router } from '../api/v1.js';

// ---------------------------------------------------------------------------
// Mock server context — the router is designed so every server concern is
// injected, which lets us exercise the full v1 surface without booting
// server.js (no listeners, no DB, no host node).
// ---------------------------------------------------------------------------
const API_KEY = 'cvps_test_key_123';
const OTHER_KEY = 'cvps_other_key_456';

let workspaceRoot;
const db = {
  users: {
    u1: { id: 'u1', username: 'alice', api_key: API_KEY },
    u2: { id: 'u2', username: 'bob', api_key: OTHER_KEY },
  },
  vps: {},
  bots: {},
};

const calls = {
  provision: 0,
  terminate: [],
  installed: [],
  uninstalled: [],
  rotated: 0,
  botActions: [],
};
const botLogs = {
  logs: ['hello from workload'],
  status: { status: 'running', running: true, pid: 42, restarts: 0, uptime_seconds: 5 },
};
const nodeStatus = {
  reachable: true,
  role: 'cloudvps-host-node',
  uptime_s: 123,
  workloads: { running: 1, total: 1 },
  desired_workloads: 1,
};
let nodeFailure = null;

function makeCtx() {
  return {
    db,
    saveDb: () => {},
    authRequired: (req, res, next) => {
      const key = req.headers['x-api-key'] || '';
      const user = Object.values(db.users).find(u => u.api_key === key);
      if (!user) {
        return res.status(401).json({ success: false, error: 'Authentication required.' });
      }
      req.user = user;
      next();
    },
    PLANS: {
      starter: { cpu: '1.0 Core', memory: '1GB RAM', storage: '20GB NVMe' },
      performance: { cpu: '4.0 Cores', memory: '4GB RAM', storage: '80GB NVMe' },
      ultra: { cpu: '8.0 Cores', memory: '8GB RAM', storage: '160GB NVMe' },
    },
    provisionVps: (user, opts) => {
      calls.provision += 1;
      const id = `vps-test-${calls.provision}`;
      const vps = {
        id,
        user_id: user.id,
        name: opts.name || 'test-vps',
        plan: opts.plan || 'performance',
        os: opts.os || 'ubuntu',
        status: 'running',
        cpu: '4.0 Cores',
        memory: '4GB RAM',
        storage: '80GB NVMe',
        ip: '172.20.0.10',
        engine: 'native_sandbox',
        created_at: new Date().toISOString(),
      };
      db.vps[id] = vps;
      db.bots[id] = {
        status: 'stopped',
        running: false,
        pid: null,
        filename: 'bot.py',
        runtime: 'python',
        restarts: 0,
        logs: [],
      };
      fs.mkdirSync(path.join(workspaceRoot, id), { recursive: true });
      return {
        vps,
        pkgState: { auto_install: { status: opts.autoInstall ? 'queued' : 'disabled' } },
      };
    },
    setVpsPower: (vps, status) => {
      vps.status = status;
      return vps;
    },
    terminateVps: id => {
      calls.terminate.push(id);
      delete db.vps[id];
      delete db.bots[id];
    },
    getBot: id => db.bots[id] || { status: 'stopped', running: false, logs: [] },
    runBotAction: async (id, action, opts) => {
      calls.botActions.push({ id, action, opts });
      if (action === 'stop') {
        if (db.bots[id]) {
          db.bots[id].status = 'stopped';
          db.bots[id].running = false;
          db.bots[id].pid = null;
        }
        return db.bots[id];
      }
      if (nodeFailure) {
        const e = new Error(nodeFailure);
        e.code = 'NODE_UNAVAILABLE';
        throw e;
      }
      if (!db.bots[id]) {
        db.bots[id] = { logs: [] };
      }
      Object.assign(db.bots[id], { status: 'running', running: true, pid: 4321 });
      return db.bots[id];
    },
    getBotLogs: async () => botLogs,
    listFiles: id => {
      const dir = path.join(workspaceRoot, id);
      if (!fs.existsSync(dir)) {
        return [];
      }
      return fs.readdirSync(dir).map(name => ({ name, isDirectory: false, size: 1, modified: 1 }));
    },
    workspaceDir: id => path.join(workspaceRoot, id),
    initWorkspace: id => fs.mkdirSync(path.join(workspaceRoot, id), { recursive: true }),
    listPackages: id => ({
      python: [{ name: 'discord.py', version: '2.4.0', auto: true }],
      node: [],
      auto_install: { status: 'done' },
      _id: id,
    }),
    installPackages: (id, opts) => calls.installed.push({ id, ...opts }),
    uninstallPackage: (id, opts) => calls.uninstalled.push({ id, ...opts }),
    getNodeStatus: async () =>
      nodeFailure && nodeFailure !== 'NODE_UNAVAILABLE'
        ? { reachable: false, error: nodeFailure }
        : nodeStatus,
    rotateApiKey: user => {
      calls.rotated += 1;
      user.api_key = `cvps_rotated_${calls.rotated}`;
      return user.api_key;
    },
    cookieOpts: { path: '/' },
    logger: { error: () => {}, warn: () => {} },
  };
}

let server;
let base;

async function req(method, url, { key = API_KEY, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) {
    headers['x-api-key'] = key;
  }
  const res = await fetch(`${base}${url}`, {
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
  return { status: res.status, data, headers: res.headers };
}

beforeAll(async () => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudvps-v1-'));
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', createV1Router(makeCtx()));
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  if (server) {
    server.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('v1 API — auth & envelope', () => {
  it('rejects missing API key with 401', async () => {
    const res = await req('GET', '/api/v1/resources', { key: null });
    expect(res.status).toBe(401);
    expect(res.data.success).toBe(false);
  });

  it('sets X-Response-Time on responses', async () => {
    const res = await req('GET', '/api/v1/resources');
    expect(res.headers.get('x-response-time')).toMatch(/^\d+\.\d+ms$/);
  });

  it('reports node status without hanging', async () => {
    const res = await req('GET', '/api/v1/node');
    expect(res.status).toBe(200);
    expect(res.data.node.reachable).toBe(true);
  });

  it('reports an unreachable node as reachable:false', async () => {
    nodeFailure = 'Host node unreachable (ECONNREFUSED)';
    const res = await req('GET', '/api/v1/node');
    expect(res.status).toBe(200);
    expect(res.data.node.reachable).toBe(false);
    nodeFailure = null;
  });
});

describe('v1 API — resource lifecycle (create / manage / terminate)', () => {
  let resourceId;

  it('creates a resource with 201', async () => {
    const res = await req('POST', '/api/v1/resources', {
      body: { name: 'My API VPS', plan: 'ultra', auto_install: false },
    });
    expect(res.status).toBe(201);
    expect(res.data.success).toBe(true);
    expect(res.data.resource.kind).toBe('vps');
    expect(res.data.resource.plan).toBe('ultra');
    expect(res.data.auto_install.status).toBe('disabled');
    resourceId = res.data.resource.id;
    expect(calls.provision).toBe(1);
  });

  it('validates create input (unknown plan → 400)', async () => {
    const res = await req('POST', '/api/v1/resources', { body: { plan: 'quantum' } });
    expect(res.status).toBe(400);
    expect(res.data.code).toBe('VALIDATION_ERROR');
  });

  it('lists only the caller resources with workload summaries', async () => {
    const res = await req('GET', '/api/v1/resources');
    expect(res.status).toBe(200);
    expect(res.data.count).toBeGreaterThanOrEqual(1);
    const own = res.data.resources.find(r => r.id === resourceId);
    expect(own).toBeTruthy();
    expect(own.workload).toMatchObject({ running: false, status: 'stopped' });
    expect(res.data.resources.every(r => r.user_id === 'u1')).toBe(true);
  });

  it('inspects a resource with nested summaries', async () => {
    const res = await req('GET', `/api/v1/resources/${resourceId}`);
    expect(res.status).toBe(200);
    expect(res.data.packages.python_count).toBe(1);
    expect(typeof res.data.file_count).toBe('number');
    expect(res.data.bot).toBeTruthy();
    expect(res.data.bot.logs).toBeUndefined(); // heavy logs are not inlined
  });

  it('updates name/plan via PATCH', async () => {
    const res = await req('PATCH', `/api/v1/resources/${resourceId}`, {
      body: { name: 'Renamed', plan: 'starter' },
    });
    expect(res.status).toBe(200);
    expect(res.data.resource.name).toBe('Renamed');
    expect(res.data.resource.cpu).toBe('1.0 Core');
  });

  it('runs power actions', async () => {
    const stop = await req('POST', `/api/v1/resources/${resourceId}/actions`, {
      body: { action: 'stop' },
    });
    expect(stop.status).toBe(200);
    expect(stop.data.resource.status).toBe('stopped');
    const start = await req('POST', `/api/v1/resources/${resourceId}/actions`, {
      body: { action: 'start' },
    });
    expect(start.data.resource.status).toBe('running');
  });

  it('rejects an invalid action', async () => {
    const res = await req('POST', `/api/v1/resources/${resourceId}/actions`, {
      body: { action: 'explode' },
    });
    expect(res.status).toBe(400);
  });

  it('404s unknown resources and 403s foreign ones', async () => {
    expect((await req('GET', '/api/v1/resources/vps-none')).status).toBe(404);
    db.vps['vps-foreign'] = { id: 'vps-foreign', user_id: 'u2', name: 'foreign' };
    expect((await req('GET', '/api/v1/resources/vps-foreign')).status).toBe(403);
    delete db.vps['vps-foreign'];
  });

  it('terminates a resource (records gone, cleanup invoked)', async () => {
    const res = await req('DELETE', `/api/v1/resources/${resourceId}`);
    expect(res.status).toBe(200);
    expect(res.data.terminated).toBe(true);
    expect(calls.terminate).toContain(resourceId);
    expect(db.vps[resourceId]).toBeUndefined();
    expect((await req('GET', `/api/v1/resources/${resourceId}`)).status).toBe(404);
  });
});

describe('v1 API — workloads (hosted processes)', () => {
  let id;

  beforeAll(async () => {
    const res = await req('POST', '/api/v1/resources', {
      body: { name: 'wl', auto_install: false },
    });
    id = res.data.resource.id;
  });

  it('returns workload state', async () => {
    const res = await req('GET', `/api/v1/resources/${id}/bot`);
    expect(res.status).toBe(200);
    expect(res.data.workload).toMatchObject({ running: false, status: 'stopped' });
  });

  it('starts the workload on the host node', async () => {
    const res = await req('POST', `/api/v1/resources/${id}/bot/actions`, {
      body: { action: 'start', filename: 'bot.py', runtime: 'python' },
    });
    expect(res.status).toBe(200);
    expect(res.data.bot_status.running).toBe(true);
    expect(calls.botActions.at(-1)).toMatchObject({ id, action: 'start' });
  });

  it('surfaces NODE_UNAVAILABLE as 503 with the error code', async () => {
    nodeFailure = 'Host node unreachable (ECONNREFUSED) — is worker.js running?';
    const res = await req('POST', `/api/v1/resources/${id}/bot/actions`, {
      body: { action: 'restart' },
    });
    expect(res.status).toBe(503);
    expect(res.data.code).toBe('NODE_UNAVAILABLE');
    nodeFailure = null;
  });

  it('stops the workload', async () => {
    const res = await req('POST', `/api/v1/resources/${id}/bot/actions`, {
      body: { action: 'stop' },
    });
    expect(res.status).toBe(200);
    expect(res.data.bot_status.running).toBe(false);
  });

  it('returns synced logs + status', async () => {
    const res = await req('GET', `/api/v1/resources/${id}/bot/logs`);
    expect(res.status).toBe(200);
    expect(res.data.logs).toContain('hello from workload');
    expect(res.data.status.running).toBe(true);
  });
});

describe('v1 API — workspace files', () => {
  let id;

  beforeAll(async () => {
    const res = await req('POST', '/api/v1/resources', {
      body: { name: 'files', auto_install: false },
    });
    id = res.data.resource.id;
  });

  it('writes, reads and lists files', async () => {
    const write = await req('PUT', `/api/v1/resources/${id}/files/content`, {
      body: { path: 'bot.py', content: 'print("hi")' },
    });
    expect(write.status).toBe(200);
    expect(write.data.path).toBe('bot.py');

    const read = await req('GET', `/api/v1/resources/${id}/files/content?path=bot.py`);
    expect(read.status).toBe(200);
    expect(read.data.content).toBe('print("hi")');

    const list = await req('GET', `/api/v1/resources/${id}/files`);
    expect(list.status).toBe(200);
    expect(list.data.files.some(f => f.name === 'bot.py')).toBe(true);
  });

  it('creates parent directories on write', async () => {
    const res = await req('PUT', `/api/v1/resources/${id}/files/content`, {
      body: { path: 'src/deep/app.js', content: 'x' },
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(workspaceRoot, id, 'src', 'deep', 'app.js'))).toBe(true);
  });

  it('blocks path traversal on read and delete', async () => {
    const read = await req('GET', `/api/v1/resources/${id}/files/content?path=../../evil.txt`);
    expect(read.status).toBe(403);
    const del = await req('DELETE', `/api/v1/resources/${id}/files`, {
      body: { path: '../outside.txt' },
    });
    expect(del.status).toBe(403);
  });

  it('refuses to delete the workspace root', async () => {
    const del = await req('DELETE', `/api/v1/resources/${id}/files?path=.`);
    expect(del.status).toBe(403);
  });

  it('deletes files', async () => {
    const del = await req('DELETE', `/api/v1/resources/${id}/files?path=bot.py`);
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(workspaceRoot, id, 'bot.py'))).toBe(false);
  });

  it('requires a path for delete', async () => {
    const del = await req('DELETE', `/api/v1/resources/${id}/files`);
    expect(del.status).toBe(400);
  });
});

describe('v1 API — packages', () => {
  let id;

  beforeAll(async () => {
    const res = await req('POST', '/api/v1/resources', {
      body: { name: 'pkgs', auto_install: false },
    });
    id = res.data.resource.id;
  });

  it('returns the ledger', async () => {
    const res = await req('GET', `/api/v1/resources/${id}/packages`);
    expect(res.status).toBe(200);
    expect(res.data.python[0].name).toBe('discord.py');
    expect(res.data.auto_install.status).toBe('done');
  });

  it('accepts install instantly with 202', async () => {
    const res = await req('POST', `/api/v1/resources/${id}/packages/install`, {
      body: { packages: 'requests aiohttp', runtime: 'python' },
    });
    expect(res.status).toBe(202);
    expect(res.data.accepted).toBe(true);
    expect(calls.installed.at(-1)).toMatchObject({
      id,
      packages: 'requests aiohttp',
      runtime: 'python',
    });
  });

  it('rejects install without packages', async () => {
    const res = await req('POST', `/api/v1/resources/${id}/packages/install`, {
      body: { runtime: 'python' },
    });
    expect(res.status).toBe(400);
  });

  it('accepts uninstall with 202', async () => {
    const res = await req('POST', `/api/v1/resources/${id}/packages/uninstall`, {
      body: { package: 'requests' },
    });
    expect(res.status).toBe(202);
    expect(calls.uninstalled.at(-1)).toMatchObject({ id, package: 'requests', runtime: 'python' });
  });
});

describe('v1 API — API key management', () => {
  it('rotates the key and returns the new one', async () => {
    const before = db.users.u1.api_key;
    const res = await req('POST', '/api/v1/api-key/rotate');
    expect(res.status).toBe(200);
    expect(res.data.api_key).toBeTruthy();
    expect(res.data.api_key).not.toBe(before);
    // new key authenticates, old one does not
    expect((await req('GET', '/api/v1/resources', { key: res.data.api_key })).status).toBe(200);
    expect((await req('GET', '/api/v1/resources', { key: before })).status).toBe(401);
    // restore for any later tests
    db.users.u1.api_key = before;
  });
});
