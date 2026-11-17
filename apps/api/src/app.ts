import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { redis, executionReady } from './redis.js';
import { config } from './config.js';
import { authRouter } from './auth.js';
import { projectRouter } from './projects.js';
import { errorHandler, HttpError } from './middleware.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(helmet());
  // All mutations must originate at the configured frontend. This also protects login/logout from CSRF.
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== config.APP_ORIGIN) {
      throw new HttpError(403, 'Request origin is not allowed.');
    }
    next();
  });
  app.use(express.json({ limit: '512kb' }));
  const store = MongoStore.create({ mongoUrl: config.MONGODB_URI, collectionName: 'sessions', ttl: 7 * 24 * 60 * 60 });
  store.on('error', () => console.error('Session database operation failed.'));
  const sessionMiddleware = session({
    name: 'codeforge.sid', secret: config.SESSION_SECRET, store,
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' },
  });
  app.use(sessionMiddleware);
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/ready', async (_req, res) => {
    try {
      if (mongoose.connection.readyState !== 1 || !executionReady()) throw new Error('Dependencies unavailable');
      await Promise.all([mongoose.connection.db!.admin().ping({ timeoutMS: 1500 }), redis.ping()]);
      res.json({ status: 'ok' });
    } catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.use('/api/auth', authRouter);
  app.use('/api/projects', projectRouter);
  app.use((_req, _res, next) => next(new HttpError(404, 'Route not found.')));
  app.use(errorHandler);
  return { app, store, sessionMiddleware };
}
