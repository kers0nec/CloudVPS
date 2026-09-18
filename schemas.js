import { z } from 'zod';

export const registerSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters').max(50),
  password: z.string().min(6, 'Password must be at least 6 characters').max(128),
});

export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export const createVpsSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  plan: z.enum(['starter', 'standard', 'performance', 'ultra']).default('performance'),
  os: z.string().default('ubuntu'),
  subdomain: z.string().max(63).optional(),
  starter: z.string().default('blank'),
  auto_install: z.boolean().default(true),
});

export const updateVpsSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  plan: z.enum(['starter', 'standard', 'performance', 'ultra']).optional(),
  os: z.string().optional(),
});

export const fileWriteSchema = z.object({
  path: z.string().min(1, 'File path required'),
  content: z.string().default(''),
});

export const folderCreateSchema = z.object({
  path: z.string().min(1, 'Folder path required'),
});

export const fileRenameSchema = z.object({
  oldPath: z.string().min(1, 'Old path required'),
  newPath: z.string().min(1, 'New path required'),
});

export const packageInstallSchema = z.object({
  packages: z.string().min(1, 'Package name required').optional(),
  package: z.string().min(1, 'Package name required').optional(),
  runtime: z.enum(['python', 'node']).default('python'),
});

export const botConfigSchema = z.object({
  filename: z.string().optional(),
  runtime: z.enum(['python', 'node', 'bash']).optional(),
  token: z.string().optional(),
  user_token: z.string().optional(),
  bot_token: z.string().optional(),
  token_type: z.enum(['bot', 'user', 'both']).default('bot'),
});

export const botTokenSchema = z.object({
  token: z.string().default(''),
  user_token: z.string().default(''),
  bot_token: z.string().default(''),
  token_type: z.enum(['bot', 'user', 'both']).default('bot'),
});

export const terminalExecSchema = z.object({
  command: z.string().default(''),
});

export const githubCloneSchema = z.object({
  repo_url: z.string().min(1, 'GitHub repository URL or name (e.g. user/repo) is required'),
  target_folder: z.string().default('root'),
  branch: z.string().optional(),
  auto_install: z.boolean().default(true),
});

export const bundleInstallSchema = z.object({
  bundle: z.enum(['discord', 'lune', 'python', 'luau-env', 'system', 'custom']),
  custom_cmd: z.string().optional(),
});

export function validate(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: err.errors.map(e => `${e.path.join('.')}: ${e.message}`),
        });
      }
      next(err);
    }
  };
}