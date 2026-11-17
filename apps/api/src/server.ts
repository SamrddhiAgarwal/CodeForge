import mongoose from 'mongoose';
import { config } from './config.js';
import { createApp } from './app.js';
import { User, Project } from './models.js';
import { createServer } from 'node:http';
import { attachRealtime } from './realtime.js';
import { closeRedis } from './redis.js';

try {
  await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User.init(), Project.init()]);
  const { app, store, sessionMiddleware } = createApp();
  const server = createServer(app);
  const closeRealtime = attachRealtime(server, sessionMiddleware);
  server.listen(config.PORT, config.HOST, () => console.log(`API ready on port ${config.PORT}`));
  const shutdown = () => {
    closeRealtime();
    server.close(() => {
      Promise.all([store.close(), mongoose.disconnect(), closeRedis()]).then(() => process.exit(0)).catch(() => process.exit(1));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch {
  console.error('API startup failed. Check your environment configuration and MongoDB availability.');
  process.exit(1);
}
