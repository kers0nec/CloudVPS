/**
 * Client for the CloudVPS host node daemon (worker.js).
 *
 * The API server uses this to talk to the dedicated Node.js process that
 * actually hosts workloads 24/7. Every call is a localhost HTTP request with
 * a hard timeout, so API responses stay fast even when the host node is
 * unhealthy: instead of hanging, calls fail fast with NodeUnavailableError
 * (HTTP 503) and the server's reconciler retries in the background.
 */
import fs from 'fs';
import path from 'path';

export class NodeUnavailableError extends Error {
  constructor(message, cause) {
    super(message || 'Host node is unavailable');
    this.name = 'NodeUnavailableError';
    this.code = 'NODE_UNAVAILABLE';
    this.statusCode = 503;
    if (cause) {
      this.cause = cause;
    }
  }
}

export function createNodeClient({
  baseUrl,
  token,
  tokenPath,
  defaultTimeoutMs = 2500,
  logger,
} = {}) {
  const url = String(
    baseUrl ||
      process.env.NODE_WORKER_URL ||
      `http://127.0.0.1:${process.env.NODE_WORKER_PORT || 3101}`
  ).replace(/\/$/, '');

  let tokenCache = { mtimeMs: 0, value: null };

  function resolveToken() {
    if (token) {
      return token;
    }
    if (process.env.NODE_WORKER_TOKEN) {
      return process.env.NODE_WORKER_TOKEN;
    }
    if (!tokenPath) {
      return '';
    }
    try {
      const stat = fs.statSync(tokenPath);
      if (stat.mtimeMs === tokenCache.mtimeMs && tokenCache.value) {
        return tokenCache.value;
      }
      const value = fs.readFileSync(tokenPath, 'utf8').trim();
      tokenCache = { mtimeMs: stat.mtimeMs, value };
      return value;
    } catch (e) {
      return tokenCache.value || '';
    }
  }

  async function request(route, { method = 'GET', body, timeoutMs } = {}) {
    const controller = AbortSignal.timeout(timeoutMs || defaultTimeoutMs);
    let res;
    try {
      res = await fetch(`${url}${route}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${resolveToken()}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller,
      });
    } catch (err) {
      const reason =
        err && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? 'timed out'
          : (err.cause && err.cause.code) || err.code || 'connection failed';
      throw new NodeUnavailableError(
        `Host node unreachable (${reason}) — is worker.js running?`,
        err
      );
    }

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* non-JSON body */
    }

    if (res.status === 404) {
      const err = new Error((data && data.error) || 'Not found');
      err.status = 404;
      throw err;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Host node returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let statusCache = { at: 0, data: null };

  return {
    baseUrl: url,

    /** GET /status with a small cache so dashboard polling stays cheap. */
    async getStatus({ maxAgeMs = 1500, timeoutMs = 1200 } = {}) {
      const now = Date.now();
      if (statusCache.data && now - statusCache.at < maxAgeMs) {
        return { ...statusCache.data, cached: true };
      }
      const data = await request('/status', { timeoutMs });
      statusCache = { at: now, data };
      return data;
    },

    async getWorkload(id, { timeoutMs } = {}) {
      try {
        const data = await request(`/workloads/${encodeURIComponent(id)}`, { timeoutMs });
        return data.workload || null;
      } catch (err) {
        if (err.status === 404) {
          return null;
        }
        throw err;
      }
    },

    async listWorkloads({ timeoutMs } = {}) {
      const data = await request('/workloads', { timeoutMs });
      return data.workloads || [];
    },

    /** Start (or replace) a workload. Returns the workload summary incl. pid. */
    async startWorkload(spec, { timeoutMs } = {}) {
      const data = await request('/workloads', {
        method: 'POST',
        body: spec,
        timeoutMs: timeoutMs || defaultTimeoutMs,
      });
      statusCache = { at: 0, data: null };
      return data.workload;
    },

    /** Idempotent stop — an absent workload is already in the desired state. */
    async stopWorkload(id, { timeoutMs } = {}) {
      try {
        return await request(`/workloads/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          timeoutMs,
        });
      } catch (err) {
        if (err.status === 404) {
          return { ok: true, status: 'absent' };
        }
        throw err;
      }
    },

    /** Log lines after the given cursor (cursor 0 = everything in the buffer). */
    async getLogs(id, since = 0, { timeoutMs } = {}) {
      const data = await request(
        `/workloads/${encodeURIComponent(id)}/logs?since=${encodeURIComponent(since)}`,
        { timeoutMs }
      );
      return {
        lines: data.lines || [],
        cursor: data.cursor || 0,
        truncated: !!data.truncated,
        status: data.status,
      };
    },
  };
}

export function defaultTokenPath(persistDir) {
  return path.join(
    persistDir || process.env.PERSIST_DIR || process.cwd(),
    'data',
    'node-worker.token'
  );
}
