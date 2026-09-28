import { describe, it, expect, beforeEach } from 'vitest';
import { database } from '../database.js';
import { nodeStartSchema, resourceCreateSchema, apiKeyCreateSchema } from '../schemas.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

describe('Continuous Node & Resource API Validation', () => {
  beforeEach(() => {
    database.loadDb();
  });

  describe('Database Services & Workspace Initialization', () => {
    it('should initialize db.services with default continuous node for vps-free-01', () => {
      expect(database.db.services).toBeDefined();
      expect(database.db.services['vps-free-01']).toBeDefined();
      const node = database.db.services['vps-free-01'];
      expect(node.type).toBe('continuous_node');
      expect(node.entrypoint).toBe('index.js');
      expect(node.port).toBeGreaterThanOrEqual(1024);
      expect(node.auto_restart).toBe(true);
    });

    it('should scaffold index.js for continuous node hosting in workspace directory', () => {
      database.initVpsWorkspace('vps-free-01');
      const wsDir = join(database.INSTANCES_DIR, 'vps-free-01');
      const indexPath = join(wsDir, 'index.js');
      expect(existsSync(indexPath)).toBe(true);
      const content = readFileSync(indexPath, 'utf8');
      expect(content).toContain('Continuous Node Hosting Server');
      expect(content).toContain('http.createServer');
      expect(content).toContain('ONLINE 24/7');
    });
  });

  describe('Zod Schemas for API Resource Management', () => {
    it('should validate nodeStartSchema with defaults', () => {
      const parsed = nodeStartSchema.parse({});
      expect(parsed.entrypoint).toBe('index.js');
      expect(parsed.env).toEqual({});
    });

    it('should validate nodeStartSchema with custom port and env', () => {
      const parsed = nodeStartSchema.parse({
        entrypoint: 'server.mjs',
        port: 4500,
        env: { CUSTOM_VAR: 'hello' }
      });
      expect(parsed.entrypoint).toBe('server.mjs');
      expect(parsed.port).toBe(4500);
      expect(parsed.env.CUSTOM_VAR).toBe('hello');
    });

    it('should validate resourceCreateSchema for node and vps', () => {
      const nodeResource = resourceCreateSchema.parse({
        type: 'node',
        name: 'My API Host',
        vps_id: 'vps-free-01',
        port: 3200
      });
      expect(nodeResource.type).toBe('node');
      expect(nodeResource.name).toBe('My API Host');

      const vpsResource = resourceCreateSchema.parse({
        type: 'vps',
        name: 'New Node Sandbox',
        plan: 'performance'
      });
      expect(vpsResource.type).toBe('vps');
      expect(vpsResource.plan).toBe('performance');
    });

    it('should reject invalid resource types', () => {
      expect(() => {
        resourceCreateSchema.parse({ type: 'invalid_type' });
      }).toThrow();
    });

    it('should validate apiKeyCreateSchema', () => {
      const parsed = apiKeyCreateSchema.parse({ label: 'Production Bot Key' });
      expect(parsed.label).toBe('Production Bot Key');
    });
  });
});
