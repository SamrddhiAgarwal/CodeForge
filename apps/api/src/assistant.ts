import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { Project } from './models.js';
import { HttpError, requireProjectRole } from './middleware.js';
import { aiActionSchema, askLlm } from './llm.js';

export const assistantRouter = Router({ mergeParams: true });
const limit = rateLimit({ windowMs: 60_000, limit: 10, keyGenerator: (req) => req.session.userId!,
  message: { error: 'AI request limit reached. Try again in a minute.' }, standardHeaders: 'draft-8', legacyHeaders: false });
const inputSchema = z.object({
  fileId: z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid file ID.'),
  action: aiActionSchema,
  scope: z.enum(['file', 'selection']),
  code: z.string().max(65536).refine((code) => Boolean(code.trim()), 'Select some code or open a non-empty file.')
    .refine((code) => Buffer.byteLength(code) <= 65536, 'AI context must be at most 64 KiB.'),
}).strict();

// All project roles may ask for advice. This route never writes files or executes generated code.
assistantRouter.post('/', requireProjectRole(), limit, async (req, res) => {
  const input = inputSchema.parse(req.body);
  const filter = { _id: req.project!._id,
    $or: [{ owner: req.session.userId }, { 'members.user': req.session.userId }],
    files: { $elemMatch: { _id: input.fileId, kind: 'file' } },
  };
  const project = await Project.findOne(filter).select('+files');
  const file = project?.files.id(input.fileId);
  if (!file) throw new HttpError(404, 'Project or file not found.');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);
  try {
    const answer = await askLlm({ action: input.action, fileName: file.name, scope: input.scope, code: input.code }, controller.signal);
    if (res.destroyed) return;
    // Membership or the file may have changed during a slow provider response.
    if (!await Project.exists(filter)) throw new HttpError(404, 'Project or file is no longer accessible.');
    res.json({ answer });
  } catch (error) {
    if (!res.destroyed) throw error;
  } finally { res.off('close', cancel); }
});
