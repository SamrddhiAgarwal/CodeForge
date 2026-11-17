import { Worker } from 'bullmq';
import { QUEUE_NAME, executionJobSchema, redisOptions } from '@codeforge/execution';
import { cleanupStaleContainers, runCode } from './runner.js';
import { writeFileSync, unlinkSync } from 'node:fs';

// Intentionally do not load the API's .env or database/session credentials.
const prefix = process.env.REDIS_PREFIX ?? 'codeforge';
if (!/^[a-zA-Z0-9_-]{1,40}$/.test(prefix)) throw new Error('Invalid REDIS_PREFIX.');
const connection = { ...redisOptions(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'), maxRetriesPerRequest: null };

try {
  // Run exactly one worker for this prefix. Recover containers left by an interrupted worker.
  await cleanupStaleContainers(prefix);
  const worker = new Worker(QUEUE_NAME, async (job) => {
    const data = executionJobSchema.parse(job.data);
    return runCode(data, prefix);
  }, { connection, prefix, concurrency: 1, maxStalledCount: 1 });
  worker.on('error', () => console.error('Worker connection failed; reconnecting to Redis.'));
  worker.on('failed', () => console.error('Execution job failed. Check Docker and the runner images.'));
  await worker.waitUntilReady();
  console.log('Execution worker ready (concurrency: 1).');
  // Optional container heartbeat. A stale file fails the production health check.
  const healthFile = process.env.WORKER_HEALTH_FILE;
  const heartbeat = async () => {
    if (!healthFile) return;
    try {
      const client = await worker.client;
      if (client.status === 'ready' && worker.isRunning()) writeFileSync(healthFile, 'ready');
    } catch { /* A failed heartbeat is detected by the container health check. */ }
  };
  await heartbeat();
  const timer = setInterval(() => void heartbeat(), 10_000);
  timer.unref();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    if (healthFile) { try { unlinkSync(healthFile); } catch { /* Already absent. */ } }
    // Finish the bounded current run and its cleanup before leaving.
    await worker.close();
    process.exit(0);
  };
  const stop = () => void shutdown().catch(() => { console.error('Worker shutdown failed. Restart it to recover stale containers.'); process.exit(1); });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch {
  console.error('Worker startup failed. Check Redis, Docker access, and runner images.');
  process.exit(1);
}
