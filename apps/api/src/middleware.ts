import type { RequestHandler, ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { Project, User } from './models.js';

declare module 'express-session' {
  interface SessionData { userId: string }
}

declare module 'express-serve-static-core' {
  interface Request { project?: InstanceType<typeof Project> }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  if (!req.session.userId) throw new HttpError(401, 'Please log in to continue.');
  if (!await User.exists({ _id: req.session.userId })) {
    await new Promise<void>((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
    throw new HttpError(401, 'Please log in again.');
  }
  next();
};

export function requireProjectRole(roles: Array<'owner' | 'editor' | 'viewer'> = ['owner', 'editor', 'viewer']): RequestHandler {
  return async (req, _res, next) => {
    const id = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid project ID.').parse(req.params.id);
    const userId = req.session.userId!;
    const project = await Project.findOne({ _id: id, $or: [{ owner: userId }, { 'members.user': userId }] });
    if (!project) throw new HttpError(404, 'Project not found.');
    const role = project.owner.toString() === userId ? 'owner' : project.members.find((member) => member.user.toString() === userId)!.role;
    if (!roles.includes(role)) throw new HttpError(403, roles.includes('editor') ? 'Only owners and editors can modify files.' : 'Only the owner can manage this project.');
    req.project = project;
    next();
  };
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: error.issues.map((issue) => issue.message).join(' ') });
  } else if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
  } else if (error?.code === 11000) {
    res.status(409).json({ error: 'An account with this email already exists.' });
  } else if (error?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body must be valid JSON.' });
  } else if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large.' });
  } else {
    // Error objects may contain credentials or submitted passwords.
    console.error('Request failed with an internal server error.');
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
