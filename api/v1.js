/**
 * CloudVPS versioned resource API (v1).
 *
 * A single, uniform, resource-oriented interface for the whole platform:
 * create, manage and terminate every resource type — VPS instances, the
 * hosted 24/7 workloads (bots), workspace files and package ledgers —
 * plus host-node status and API-key management.
 *
 * All routes are authenticated with the account API key (X-API-Key header,
 * `Authorization: Bearer`, `api_key` query/cookie) through the same
 * authRequired middleware the dashboard uses.
 *
 * The router is intentionally free of server internals: everything it needs
 * is injected through `ctx` (see JSDoc below), which keeps it testable in
 * isolation and keeps the legacy dashboard endpoints untouched.
 *
 * Response conventions:
 *  - JSON envelope `{ success, ... }` consistent with the rest of the API,
 *  - `X-Response-Time` header on every response (ms, one decimal),
 *  - errors: `{ success:false, error, code }` with proper HTTP status,
 *  - long-running work (package installs, workspace removal) is accepted and
 *    executed in the background so responses stay fast.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { createVpsSchema, updateVpsSchema, packageInstallSchema } from '../schemas.js';

/**
 * @typedef {object} V1Context
 * @property {object} db                          live database object ({users, vps, bots, ...})
 * @property {Function} saveDb                    coalesced persistence
 * @property {Function} authRequired              session/API-key middleware
 * @property {object} PLANS                       plan catalogue
 * @property {Function} provisionVps              (user, {name,plan,os,autoInstall}) -> {vps, pkgState}
 * @property {Function} setVpsPower               (vps, status) -> vps
 * @property {Function} terminateVps              (vpsId) -> void (cleanup continues in background)
 * @property {Function} getBot                    (vpsId) -> bot supervisor record
 * @property {Function} runBotAction              async (vpsId, action, opts) -> bot record
 * @property {Function} getBotLogs                async (vpsId) -> {logs, status}
 * @property {Function} listFiles                 (vpsId) -> [{name,isDirectory,size,modified}]
 * @property {Function} workspaceDir              (vpsId) -> absolute workspace path
 * @property {Function} initWorkspace             (vpsId) -> void
 * @property {Function} listPackages              (vpsId) -> {python, node, auto_install}
 * @property {Function} installPackages           (vpsId, {packages, runtime}) -> void (background)
 * @property {Function} uninstallPackage          (vpsId, {package, runtime}) -> void (background)
 * @property {Function} getNodeStatus             async () -> node status or {reachable:false,...}
 * @property {Function} rotateApiKey              (user) -> new api key
 * @property {object} [cookieOpts]                cookie options used when refreshing the session cookie
 * @property {object} [logger]                    optional logger
 */

const powerSchema = z.object({ action: z.enum(['start', 'stop', 'restart', 'reboot']) });

const botActionSchema = z.object({
  action: z.enum(['start', 'stop', 'restart']),
  filename: z.string().min(1).optional(),
  runtime: z.enum(['python', 'node', 'bash']).optional(),
  token: z.string().optional(),
  user_token: z.string().optional(),
  bot_token: z.string().optional(),
  token_type: z.enum(['bot', 'user', 'both']).optional(),
});

const uninstallSchema = z.object({
  package: z.string().min(1, 'Package name required'),
  runtime: z.enum(['python', 'node']).default('python'),
});

const fileDeleteSchema = z.object({ path: z.string().min(1, 'File path required') });

function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const err = new Error('Validation failed');
    err.isOperational = true;
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    err.details = result.error.errors.map(e => `${e.path.join('.') || 'body'}: ${e.message}`);
    throw err;
  }
  return result.data;
}

function appError(statusCode, message, code) {
  const err = new Error(message);
  err.isOperational = true;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

export function createV1Router(ctx) {
  const router = express.Router();

  // --- Fast-response instrumentation: per-request duration header --------
  router.use((req, res, next) => {
    const start = process.hrtime.bigint();
    const originalJson = res.json.bind(res);
    res.json = payload => {
      if (!res.headersSent) {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        res.setHeader('X-Response-Time', `${ms.toFixed(1)}ms`);
      }
      return originalJson(payload);
    };
    next();
  });

  router.use(ctx.authRequired);

  // --- Resource ownership (404 unknown, 403 foreign — same as legacy) ----
  function resourceOwner(req, res, next) {
    const vps = ctx.db.vps[req.params.id];
    if (!vps) {
      return next(appError(404, 'Resource not found', 'NOT_FOUND'));
    }
    if (vps.user_id !== req.user.id) {
      return next(appError(403, 'Access denied: you do not own this resource', 'FORBIDDEN'));
    }
    req.vps = vps;
    next();
  }

  function workloadSummary(vpsId) {
    const bot = ctx.db.bots[vpsId];
    if (!bot) {
      return { running: false, status: 'stopped', pid: null };
    }
    return {
      running: !!bot.running,
      status: bot.status || (bot.running ? 'running' : 'stopped'),
      pid: bot.pid || null,
      restarts: bot.restarts || 0,
      uptime_seconds:
        bot.running && bot.started_at ? Math.floor((Date.now() - bot.started_at) / 1000) : 0,
    };
  }

  function toResource(vps) {
    return { ...vps, kind: 'vps', workload: workloadSummary(vps.id) };
  }

  // Resolve a workspace-relative path, rejecting traversal (and root).
  function safeResolve(vpsId, relPath, { allowRoot = false } = {}) {
    ctx.initWorkspace(vpsId);
    const base = path.resolve(ctx.workspaceDir(vpsId));
    const target = path.resolve(base, String(relPath || ''));
    const inside = target === base || target.startsWith(base + path.sep);
    if (!inside || (!allowRoot && target === base)) {
      throw appError(403, 'Access denied: path traversal prevented', 'PATH_TRAVERSAL');
    }
    return { base, target, rel: path.relative(base, target) };
  }

  // =========================================================================
  // Host node
  // =========================================================================

  /** Real hosting node status (uptime, load, workloads) — 200 even if down. */
  router.get('/node', async (req, res) => {
    const node = await ctx.getNodeStatus();
    res.json({ success: true, node });
  });

  /** Rotate this account's API key. The old key stops working immediately. */
  router.post('/api-key/rotate', (req, res) => {
    const api_key = ctx.rotateApiKey(req.user);
    if (ctx.cookieOpts) {
      res.cookie('api_key', api_key, ctx.cookieOpts);
    }
    res.json({
      success: true,
      api_key,
      message: 'API key rotated — the previous key is no longer valid',
    });
  });

  // =========================================================================
  // Resources (VPS instances) — create / list / inspect / manage / terminate
  // =========================================================================

  router.get('/resources', (req, res) => {
    const resources = Object.values(ctx.db.vps)
      .filter(v => v && v.user_id === req.user.id)
      .map(toResource);
    res.json({ success: true, resources, count: resources.length });
  });

  router.post('/resources', (req, res) => {
    const body = parse(createVpsSchema, req.body || {});
    const { vps, pkgState } = ctx.provisionVps(req.user, {
      name: body.name,
      plan: body.plan,
      os: body.os,
      autoInstall: body.auto_install,
    });
    res.status(201).json({
      success: true,
      resource: toResource(vps),
      auto_install: pkgState.auto_install,
    });
  });

  router.get('/resources/:id', resourceOwner, (req, res) => {
    const vps = req.vps;
    const packages = ctx.listPackages(vps.id);
    let fileCount = 0;
    try {
      fileCount = ctx.listFiles(vps.id).length;
    } catch (e) {
      /* workspace not ready */
    }
    res.json({
      success: true,
      resource: toResource(vps),
      bot: {
        ...ctx.getBot(vps.id),
        logs: undefined,
        uptime_seconds: workloadSummary(vps.id).uptime_seconds,
      },
      packages: {
        python_count: packages.python.length,
        node_count: packages.node.length,
        auto_install: packages.auto_install,
      },
      file_count: fileCount,
    });
  });

  router.patch('/resources/:id', resourceOwner, (req, res) => {
    const body = parse(updateVpsSchema, req.body || {});
    const vps = req.vps;
    if (body.name) {
      vps.name = body.name;
    }
    if (body.plan && ctx.PLANS[body.plan]) {
      vps.plan = body.plan;
      vps.cpu = ctx.PLANS[body.plan].cpu;
      vps.memory = ctx.PLANS[body.plan].memory;
      vps.storage = ctx.PLANS[body.plan].storage;
    }
    if (body.os) {
      vps.os = body.os;
    }
    ctx.saveDb();
    res.json({ success: true, resource: toResource(vps) });
  });

  /** Power actions: start | stop | restart | reboot (VPS status control). */
  router.post('/resources/:id/actions', resourceOwner, (req, res) => {
    const { action } = parse(powerSchema, req.body || {});
    const status = action === 'stop' ? 'stopped' : 'running';
    const vps = ctx.setVpsPower(req.vps, status);
    res.json({
      success: true,
      action,
      resource: toResource(vps),
      message: `Resource ${action === 'stop' ? 'stopped' : 'started'}`,
    });
  });

  /** Terminate: remove the resource, stop its workload, scrub the workspace. */
  router.delete('/resources/:id', resourceOwner, async (req, res) => {
    const id = req.params.id;
    ctx.terminateVps(id);
    res.json({ success: true, terminated: true, resource_id: id, message: 'Resource terminated' });
  });

  // =========================================================================
  // Hosted workload (bot process) on a resource
  // =========================================================================

  router.get('/resources/:id/bot', resourceOwner, (req, res) => {
    const bot = ctx.getBot(req.params.id);
    res.json({ success: true, bot, workload: workloadSummary(req.params.id) });
  });

  router.post('/resources/:id/bot/actions', resourceOwner, async (req, res) => {
    const body = parse(botActionSchema, req.body || {});
    const bot = await ctx.runBotAction(req.params.id, body.action, body);
    res.json({
      success: true,
      action: body.action,
      bot_status: bot,
      message:
        body.action === 'stop' ? 'Workload stopped' : 'Workload is live on the host node [ONLINE]',
    });
  });

  router.get('/resources/:id/bot/logs', resourceOwner, async (req, res) => {
    const { logs, status } = await ctx.getBotLogs(req.params.id);
    res.json({ success: true, logs, status });
  });

  // =========================================================================
  // Workspace files
  // =========================================================================

  router.get('/resources/:id/files', resourceOwner, (req, res) => {
    const files = ctx.listFiles(req.params.id);
    res.json({ success: true, files, count: files.length });
  });

  router.get('/resources/:id/files/content', resourceOwner, async (req, res) => {
    const rel = req.query.path;
    if (!rel) {
      throw appError(400, 'File path required', 'VALIDATION_ERROR');
    }
    const { target } = safeResolve(req.params.id, rel);
    let stat = null;
    try {
      stat = await fs.promises.stat(target);
    } catch (e) {
      stat = null;
    }
    if (stat && stat.isDirectory()) {
      throw appError(400, 'Path is a directory, not a file', 'VALIDATION_ERROR');
    }
    if (!stat) {
      return res.json({ success: true, path: rel, content: '' });
    }
    const content = await fs.promises.readFile(target, 'utf8');
    res.json({
      success: true,
      path: rel,
      content,
      size: stat.size,
      modified: Math.floor(stat.mtimeMs / 1000),
    });
  });

  router.put('/resources/:id/files/content', resourceOwner, async (req, res) => {
    const body = parse(
      z.object({ path: z.string().min(1, 'File path required'), content: z.string().default('') }),
      req.body || {}
    );
    const { target, rel } = safeResolve(req.params.id, body.path);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, body.content, 'utf8');
    res.json({ success: true, path: rel, message: 'File saved' });
  });

  router.delete('/resources/:id/files', resourceOwner, async (req, res) => {
    const rel = req.query.path || (req.body && req.body.path);
    const body = parse(fileDeleteSchema, { path: rel });
    const { target } = safeResolve(req.params.id, body.path);
    await fs.promises.rm(target, { recursive: true, force: true });
    res.json({ success: true, path: body.path, message: 'Deleted successfully' });
  });

  // =========================================================================
  // Package ledgers
  // =========================================================================

  router.get('/resources/:id/packages', resourceOwner, (req, res) => {
    const state = ctx.listPackages(req.params.id);
    res.json({ success: true, ...state });
  });

  /** Accepted instantly — pip/npm runs in the background, progress lands in logs. */
  router.post('/resources/:id/packages/install', resourceOwner, (req, res) => {
    const body = parse(packageInstallSchema, req.body || {});
    const pkgs = (body.packages || body.package || '').trim();
    if (!pkgs) {
      throw appError(400, 'No packages specified', 'VALIDATION_ERROR');
    }
    ctx.installPackages(req.params.id, { packages: pkgs, runtime: body.runtime });
    res.status(202).json({
      success: true,
      accepted: true,
      status: 'installing',
      packages: pkgs,
      runtime: body.runtime,
      message: 'Install started in the background — see resource packages/logs for progress',
    });
  });

  router.post('/resources/:id/packages/uninstall', resourceOwner, (req, res) => {
    const body = parse(uninstallSchema, req.body || {});
    ctx.uninstallPackage(req.params.id, { package: body.package, runtime: body.runtime });
    res.status(202).json({
      success: true,
      accepted: true,
      status: 'removing',
      package: body.package,
      runtime: body.runtime,
      message: 'Uninstall started in the background',
    });
  });

  // =========================================================================
  // Errors → JSON envelope
  // =========================================================================
  router.use((err, req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: err.errors.map(e => `${e.path.join('.') || 'body'}: ${e.message}`),
      });
    }
    if (err && err.code === 'NODE_UNAVAILABLE') {
      return res.status(503).json({ success: false, error: err.message, code: 'NODE_UNAVAILABLE' });
    }
    if (err && err.isOperational) {
      return res.status(err.statusCode || 400).json({
        success: false,
        error: err.message,
        code: err.code || 'ERROR',
        details: err.details,
      });
    }
    if (ctx.logger) {
      ctx.logger.error({ err }, '[API v1] unhandled error');
    } else {
      console.error('[API v1] unhandled error:', err);
    }
    res
      .status(500)
      .json({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });

  return router;
}

export default createV1Router;
