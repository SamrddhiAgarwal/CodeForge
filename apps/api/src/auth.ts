import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { User } from './models.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { HttpError, requireAuth } from './middleware.js';
import { config } from './config.js';
import { projectEvents } from './projectEvents.js';

export const authRouter = Router();
export const emailSchema = z.email('Enter a valid email address.').max(254).transform((value) => value.toLowerCase());
const credentials = z.object({
  email: z.string().trim().pipe(emailSchema),
  password: z.string().min(12, 'Use a password with at least 12 characters.').max(128, 'Password must be at most 128 characters.'),
});
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20,
  standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
});

async function startSession(req: Request, userId: string) {
  await new Promise<void>((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.userId = userId;
  await new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

authRouter.post('/register', authLimit, async (req, res) => {
  const input = credentials.extend({ name: z.string().trim().min(1, 'Enter your name.').max(60) }).strict().parse(req.body);
  const user = await User.create({ name: input.name, email: input.email, passwordHash: await hashPassword(input.password) });
  await startSession(req, user.id);
  res.status(201).json({ user: { id: user.id, name: user.name, email: user.email } });
});

// A fixed dummy hash makes unknown-account login attempts perform the same expensive derivation.
const dummyHash = await hashPassword('unused account password');
authRouter.post('/login', authLimit, async (req, res) => {
  const input = credentials.strict().parse(req.body);
  const user = await User.findOne({ email: input.email }).select('+passwordHash');
  const valid = await verifyPassword(input.password, user?.passwordHash ?? dummyHash);
  if (!user || !valid) throw new HttpError(401, 'Incorrect email or password.');
  await startSession(req, user.id);
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) throw new HttpError(401, 'Please log in again.');
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});

authRouter.post('/logout', async (req, res) => {
  const sessionId = req.sessionID;
  await new Promise<void>((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
  projectEvents.emit('session-ended', sessionId);
  res.clearCookie('codeforge.sid', { httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production', path: '/' });
  res.status(204).end();
});
