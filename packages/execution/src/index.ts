import { z } from 'zod';

export const QUEUE_NAME = 'execution';
export const OUTPUT_LIMIT = 32 * 1024;
export const languageSchema = z.enum(['javascript', 'python', 'cpp']);
export type Language = z.infer<typeof languageSchema>;
const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/);
export const executionJobSchema = z.object({
  projectId: objectId,
  userId: objectId,
  fileId: objectId,
  fileName: z.string().min(1).max(120),
  revision: z.number().int().min(0),
  language: languageSchema,
  code: z.string().max(65536).refine((code) => Buffer.byteLength(code) <= 65536),
}).strict();
export type ExecutionJob = z.infer<typeof executionJobSchema>;
export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputLimited: boolean;
  memoryLimited: boolean;
  durationMs: number;
}

export function languageForFile(name: string): Language | null {
  const extension = name.split('.').pop()?.toLowerCase();
  if (['js', 'mjs', 'cjs'].includes(extension ?? '')) return 'javascript';
  if (extension === 'py') return 'python';
  if (['cpp', 'cc', 'cxx'].includes(extension ?? '')) return 'cpp';
  return null;
}

// Return options instead of sharing a Redis client between API and worker processes.
export function redisOptions(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error('Invalid REDIS_URL.'); }
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw new Error('Use a redis:// or rediss:// URL.');
  const database = parsed.pathname.slice(1) || '0';
  if (!/^\d+$/.test(database)) throw new Error('Invalid Redis database number.');
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number(database),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
