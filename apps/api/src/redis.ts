import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { QUEUE_NAME, redisOptions, type ExecutionJob, type ExecutionResult } from '@codeforge/execution';
import { config } from './config.js';

const connection = { ...redisOptions(config.REDIS_URL), maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1500, commandTimeout: 2000 };
export const redis = new Redis(connection);
export const executionQueue = new Queue<ExecutionJob, ExecutionResult>(QUEUE_NAME, {
  connection, prefix: config.REDIS_PREFIX,
  defaultJobOptions: { attempts: 1, removeOnComplete: { age: 3600, count: 100 }, removeOnFail: { age: 3600, count: 100 } },
});
// Cache failures fall back to MongoDB; execution routes return a clear 503.
redis.on('error', () => {});
executionQueue.on('error', () => {});
let queueInitialized = false;
void executionQueue.waitUntilReady().then(() => { queueInitialized = true; }).catch(() => {});

export function executionReady() {
  // BullMQ may wait indefinitely for its very first Redis connection. HTTP requests must fail fast.
  return queueInitialized && redis.status === 'ready';
}

export async function closeRedis() {
  redis.disconnect();
  await executionQueue.close();
}
