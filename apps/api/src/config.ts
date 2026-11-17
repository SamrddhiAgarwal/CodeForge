import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Resolve from the source or compiled folder, independently of the working directory.
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  MONGODB_URI: z.string().min(1),
  APP_ORIGIN: z.url().transform((value) => new URL(value).origin),
  SESSION_SECRET: z.string().min(32),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  REDIS_URL: z.url().default('redis://127.0.0.1:6379'),
  REDIS_PREFIX: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).default('codeforge'),
  GEMINI_API_KEY: z.string().trim().default(''),
  GEMINI_MODEL: z.string().trim().regex(/^[a-zA-Z0-9._-]{1,100}$/).default('gemini-3.5-flash-lite'),
});

const result = schema.safeParse(process.env);
if (!result.success) {
  // Report variable names, never their values.
  throw new Error(`Invalid environment variables: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
}
export const config = result.data;
if (config.NODE_ENV === 'production' && !config.APP_ORIGIN.startsWith('https://')) {
  throw new Error('Production APP_ORIGIN must use HTTPS.');
}
