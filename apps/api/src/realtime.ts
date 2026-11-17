import type { Server as HttpServer } from 'node:http';
import type { Request, RequestHandler } from 'express';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import * as Y from 'yjs';
import { config } from './config.js';
import { Project, User } from './models.js';
import { HttpError } from './middleware.js';
import { documentOperation } from './documents.js';
import { projectEvents } from './projectEvents.js';

const idSchema = z.string().regex(/^[a-fA-F0-9]{24}$/);
const colors = ['#df9a57', '#72b9e8', '#c694e8', '#75c99a', '#eb8585', '#c8be69'];
const colorFor = (id: string) => colors[parseInt(id.slice(-6), 16) % colors.length];

export function attachRealtime(server: HttpServer, sessionMiddleware: RequestHandler) {
  const io = new Server(server, {
    maxHttpBufferSize: 512 * 1024,
    cors: { origin: config.APP_ORIGIN, credentials: true },
    allowRequest: (req, done) => done(null, req.headers.origin === config.APP_ORIGIN),
  });
  io.engine.use(sessionMiddleware);

  function revoke(socket: Socket, message = 'Session expired or project access removed.') {
    socket.emit('access-lost', { error: message });
    socket.disconnect(true);
  }

  async function authorize(socket: Socket) {
    const req = socket.request as Request;
    await new Promise<void>((resolve, reject) => req.session.reload((error) => error ? reject(new HttpError(401, 'Please sign in again.')) : resolve()));
    const user = await User.findById(req.session.userId);
    const project = await Project.findById(socket.data.projectId);
    const role = user && (project?.owner.toString() === user.id ? 'owner' : project?.members.find((member) => member.user.toString() === user.id)?.role);
    if (!user || !project || !role) throw new HttpError(403, 'Project access denied.');
    socket.data.user = { id: user.id, name: user.name, role, color: colorFor(user.id) };
    return { user, project, role };
  }

  io.use(async (socket, next) => {
    try {
      socket.data.projectId = idSchema.parse(socket.handshake.auth.projectId);
      socket.data.files = new Set<string>();
      await authorize(socket);
      next();
    } catch { next(new Error('Sign in with an account that belongs to this project.')); }
  });

  async function members(projectId: string) {
    const sockets = [...io.sockets.sockets.values()].filter((socket) => socket.data.projectId === projectId);
    const allowed: Socket[] = [];
    await Promise.all(sockets.map(async (socket) => {
      try { await authorize(socket); if (socket.connected) allowed.push(socket); }
      catch { revoke(socket); }
    }));
    return allowed.filter((socket) => socket.connected);
  }

  async function presence(projectId: string) {
    const sockets = await members(projectId);
    const users = sockets.map((socket) => ({ socketId: socket.id, ...socket.data.user, fileId: socket.data.cursor?.fileId ?? null, cursor: socket.data.cursor ?? null }));
    for (const socket of sockets) socket.emit('presence', users);
  }

  async function changed(projectId: string) {
    for (const socket of await members(projectId)) {
      socket.emit('project-changed', { role: socket.data.user.role });
    }
    await presence(projectId);
  }

  async function documentChanged(projectId: string, fileId: string, state: string, revision: number) {
    for (const socket of await members(projectId)) {
      if (socket.data.files.has(fileId)) socket.emit('document', { fileId, state, revision });
    }
  }

  const onChanged = (projectId: string) => { void changed(projectId).catch(() => {}); };
  const onDocument = (projectId: string, fileId: string, state: string, revision: number) => { void documentChanged(projectId, fileId, state, revision).catch(() => {}); };
  const onSessionEnded = (sessionId: string) => {
    for (const socket of io.sockets.sockets.values()) {
      if ((socket.request as Request).sessionID === sessionId) revoke(socket, 'You signed out.');
    }
  };
  projectEvents.on('changed', onChanged);
  projectEvents.on('document', onDocument);
  projectEvents.on('session-ended', onSessionEnded);

  io.on('connection', (socket) => {
    const projectId = socket.data.projectId as string;
    let pending = 0;
    let windowStart = Date.now();
    let messages = 0;
    let lastChat = 0;

    function handle(name: string, operation: (payload: unknown) => Promise<unknown>) {
      socket.on(name, async (payload, acknowledge) => {
        const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
        if (Date.now() - windowStart > 1000) { messages = 0; windowStart = Date.now(); }
        if (++messages > 60 || pending >= 10) { reply({ ok: false, error: 'Too many messages. Try again shortly.' }); return; }
        pending++;
        try {
          await authorize(socket);
          if (!socket.connected) return;
          const result = await operation(payload);
          reply({ ok: true, ...result as object });
        } catch (error) {
          reply({ ok: false, error: error instanceof HttpError ? error.message : error instanceof z.ZodError ? 'Invalid message.' : 'Could not process message. Please retry.' });
          if (error instanceof HttpError && [401, 403].includes(error.status)) {
            // A viewer write is rejected without removing their legitimate read/chat connection.
            try { await authorize(socket); } catch { revoke(socket); }
          }
        } finally { pending--; }
      });
    }

    handle('project:sync', async () => {
      const project = await Project.findById(projectId).select('+chat');
      await presence(projectId);
      return { user: socket.data.user, messages: project?.chat ?? [] };
    });

    handle('document:join', async (payload) => {
      const { fileId } = z.object({ fileId: idSchema }).strict().parse(payload);
      socket.data.files.add(fileId);
      try { return await documentOperation(projectId, fileId, socket.data.user.id); }
      catch (error) { socket.data.files.delete(fileId); throw error; }
    });

    handle('document:update', async (payload) => {
      const { fileId, update } = z.object({ fileId: idSchema, update: z.string().max(350000) }).strict().parse(payload);
      if (!socket.data.files.has(fileId)) throw new HttpError(400, 'Open the file before editing.');
      return documentOperation(projectId, fileId, socket.data.user.id, { update });
    });

    handle('document:leave', async (payload) => {
      const { fileId } = z.object({ fileId: idSchema }).strict().parse(payload);
      socket.data.files.delete(fileId);
      if (socket.data.cursor?.fileId === fileId) { socket.data.cursor = null; await presence(projectId); }
      return {};
    });

    handle('cursor', async (payload) => {
      const input = z.object({ fileId: idSchema, anchor: z.string().max(2048), head: z.string().max(2048) }).nullable().parse(payload);
      if (input) {
        if (!socket.data.files.has(input.fileId)) throw new HttpError(400, 'Open the file before sharing a cursor.');
        const exists = await Project.exists({ _id: projectId, files: { $elemMatch: { _id: input.fileId, kind: 'file' } } });
        if (!exists) throw new HttpError(404, 'File no longer exists.');
        try {
          Y.decodeRelativePosition(Buffer.from(input.anchor, 'base64'));
          Y.decodeRelativePosition(Buffer.from(input.head, 'base64'));
        } catch { throw new HttpError(400, 'Invalid cursor.'); }
      }
      socket.data.cursor = input;
      await presence(projectId);
      return {};
    });

    handle('chat:send', async (payload) => {
      const input = z.object({ messageId: z.uuid(), text: z.string().trim().min(1).max(2000) }).strict().parse(payload);
      if (Date.now() - lastChat < 500) throw new HttpError(429, 'Please wait before sending another message.');
      lastChat = Date.now();
      const message = { ...input, userId: socket.data.user.id, name: socket.data.user.name, sentAt: new Date() };
      const result = await Project.updateOne({
        _id: projectId, 'chat.messageId': { $ne: input.messageId },
        $or: [{ owner: message.userId }, { 'members.user': message.userId }],
      }, { $push: { chat: { $each: [message], $slice: -100 } } });
      if (result.modifiedCount) for (const member of await members(projectId)) member.emit('chat', message);
      return {};
    });

    socket.on('disconnect', () => { void presence(projectId).catch(() => {}); });
    void presence(projectId).catch(() => {});
  });

  const interval = setInterval(() => {
    const projects = new Set([...io.sockets.sockets.values()].map((socket) => socket.data.projectId as string));
    for (const projectId of projects) void presence(projectId).catch(() => {});
  }, 10000);
  interval.unref();

  return () => {
    clearInterval(interval);
    projectEvents.off('changed', onChanged);
    projectEvents.off('document', onDocument);
    projectEvents.off('session-ended', onSessionEnded);
    io.close();
  };
}
