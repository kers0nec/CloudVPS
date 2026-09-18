import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerSchema, loginSchema, createVpsSchema, bundleInstallSchema, validate } from '../schemas.js';
import { AppError, ValidationError, AuthenticationError, AuthorizationError, NotFoundError, ConflictError, errorHandler, asyncHandler } from '../errors.js';

describe('Validation Schemas', () => {
  describe('registerSchema', () => {
    it('should validate correct registration data', () => {
      const data = { username: 'testuser', password: 'password123' };
      const result = registerSchema.parse(data);
      expect(result.username).toBe('testuser');
      expect(result.password).toBe('password123');
    });

    it('should reject username too short', () => {
      const data = { username: 'ab', password: 'password123' };
      expect(() => registerSchema.parse(data)).toThrow();
    });

    it('should reject password too short', () => {
      const data = { username: 'testuser', password: '123' };
      expect(() => registerSchema.parse(data)).toThrow();
    });

    it('should reject missing fields', () => {
      expect(() => registerSchema.parse({})).toThrow();
    });
  });

  describe('loginSchema', () => {
    it('should validate correct login data', () => {
      const data = { username: 'testuser', password: 'password123' };
      const result = loginSchema.parse(data);
      expect(result.username).toBe('testuser');
    });

    it('should reject missing fields', () => {
      expect(() => loginSchema.parse({})).toThrow();
    });
  });

  describe('createVpsSchema', () => {
    it('should validate correct VPS creation data', () => {
      const data = { name: 'My VPS', plan: 'performance', os: 'ubuntu', starter: 'blank' };
      const result = createVpsSchema.parse(data);
      expect(result.name).toBe('My VPS');
      expect(result.plan).toBe('performance');
    });

    it('should use defaults when optional fields missing', () => {
      const data = {};
      const result = createVpsSchema.parse(data);
      expect(result.plan).toBe('performance');
      expect(result.os).toBe('ubuntu');
      expect(result.starter).toBe('blank');
    });

    it('should default auto_install to true so the Discord stack installs automatically', () => {
      const result = createVpsSchema.parse({});
      expect(result.auto_install).toBe(true);
    });

    it('should allow opting out of the automatic Discord package install', () => {
      const result = createVpsSchema.parse({ auto_install: false });
      expect(result.auto_install).toBe(false);
    });

    it('should reject invalid plan', () => {
      const data = { plan: 'invalid' };
      expect(() => createVpsSchema.parse(data)).toThrow();
    });
  });

  describe('bundleInstallSchema', () => {
    it('should accept the discord bundle', () => {
      const result = bundleInstallSchema.parse({ bundle: 'discord' });
      expect(result.bundle).toBe('discord');
    });

    it('should accept existing bundles', () => {
      for (const bundle of ['lune', 'python', 'luau-env', 'system']) {
        expect(bundleInstallSchema.parse({ bundle }).bundle).toBe(bundle);
      }
    });

    it('should reject unknown bundles', () => {
      expect(() => bundleInstallSchema.parse({ bundle: 'minecraft' })).toThrow();
    });
  });
});

describe('Validation Middleware', () => {
  let mockReq, mockRes, mockNext;

  beforeEach(() => {
    mockReq = { body: {} };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };
    mockNext = vi.fn();
  });

  it('should call next() for valid data', () => {
    const middleware = validate(registerSchema);
    mockReq.body = { username: 'testuser', password: 'password123' };
    middleware(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('should return 400 for invalid data', () => {
    const middleware = validate(registerSchema);
    mockReq.body = { username: 'ab', password: '123' };
    middleware(mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Validation failed'
      })
    );
    expect(mockNext).not.toHaveBeenCalled();
  });
});

describe('Error Classes', () => {
  it('should create AppError with correct properties', () => {
    const error = new AppError('Test error', 400, 'TEST_CODE', { detail: 'info' });
    expect(error.message).toBe('Test error');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('TEST_CODE');
    expect(error.details).toEqual({ detail: 'info' });
    expect(error.isOperational).toBe(true);
  });

  it('should create ValidationError with status 400', () => {
    const error = new ValidationError('Invalid input', { field: 'username' });
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('should create AuthenticationError with status 401', () => {
    const error = new AuthenticationError();
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe('AUTHENTICATION_ERROR');
  });

  it('should create AuthorizationError with status 403', () => {
    const error = new AuthorizationError();
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe('AUTHORIZATION_ERROR');
  });

  it('should create NotFoundError with status 404', () => {
    const error = new NotFoundError();
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('should create ConflictError with status 409', () => {
    const error = new ConflictError();
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('CONFLICT');
  });
});

describe('Error Handler', () => {
  let mockReq, mockRes, mockNext;

  beforeEach(() => {
    mockReq = { method: 'GET', url: '/test' };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };
    mockNext = vi.fn();
  });

  it('should handle operational errors', () => {
    const error = new AppError('Test error', 400, 'TEST_CODE');
    errorHandler(error, mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Test error',
        code: 'TEST_CODE'
      })
    );
  });

  it('should handle non-operational errors with 500', () => {
    const error = new Error('Unexpected error');
    errorHandler(error, mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
      })
    );
  });
});

describe('asyncHandler', () => {
  it('should catch rejected promises', async () => {
    const { asyncHandler } = await import('../errors.js');
    const mockReq = {};
    const mockRes = {};
    const mockNext = vi.fn();

    const failingFn = asyncHandler(async () => {
      throw new Error('Async error');
    });

    await failingFn(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
  });
});