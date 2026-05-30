import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url().or(z.string().regex(/^postgres(?:ql)?:\/\//, 'must be a PostgreSQL connection URL')),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().min(1).default('us-east-1'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.string().url(),
  TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  AUTH_RATE_LIMIT_MAX_FAILURES: z.coerce.number().int().min(1).max(100).default(5),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(86_400_000).default(60_000),
  AUTH_RATE_LIMIT_LOCKOUT_MS: z.coerce.number().int().min(1000).max(86_400_000).default(300_000),
  WS_CONNECTION_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(30),
  WS_CONNECTION_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(86_400_000).default(60_000),
  WS_MESSAGE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(120),
  WS_MESSAGE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(86_400_000).default(10_000),
  YJS_UPDATE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(120),
  YJS_UPDATE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(86_400_000).default(10_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type ServerConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid server configuration: ${details}`);
  }
  return parsed.data;
}
