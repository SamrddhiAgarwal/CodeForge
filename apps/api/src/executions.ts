import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { executionJobSchema, languageForFile } from '@codeforge/execution';
import { Project } from './models.js';
import { requireProjectRole, HttpError } from './middleware.js';
import { executionQueue, executionReady } from './redis.js';

export const executionRouter = Router({ mergeParams: true });
const submitLimit = rateLimit({ windowMs: 60_000, limit: 10, keyGenerator: (req) => req.session.userId!,
  message: { error: 'Run limit reached. Try again in a minute.' }, standardHeaders: 'draft-8', legacyHeaders: false });

executionRouter.post('/', requireProjectRole(['owner', 'editor']), submitLimit, async (req, res) => {
  const { fileId } = z.object({ fileId: z.string().regex(/^[a-fA-F0-9]{24}$/) }).strict().parse(req.body);
  const project = await Project.findOne({ _id: req.project!._id,
    $or: [{ owner: req.session.userId }, { members: { $elemMatch: { user: req.session.userId, role: 'editor' } } }],
  }).select('+files');
  const file = project?.files.id(fileId);
  if (!file || file.kind !== 'file') throw new HttpError(404, 'File not found.');
  const language = languageForFile(file.name);
  if (!language) throw new HttpError(400, 'Run supports JavaScript (.js), Python (.py), and C++ (.cpp) files.');
  const data = executionJobSchema.parse({ projectId: project!.id, userId: req.session.userId!, fileId: file.id,
    fileName: file.name, revision: file.revision, language, code: file.content });
  try {
    if (!executionReady()) throw new HttpError(503, 'Execution is unavailable. Check Redis and the worker.');
    const counts = await executionQueue.getJobCounts('waiting', 'active');
    if (counts.waiting + counts.active >= 100) throw new HttpError(503, 'The execution queue is full. Try again later.');
    const job = await executionQueue.add('run-file', data);
    res.status(202).json({ job: { id: job.id, fileName: data.fileName, revision: data.revision, language } });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'Execution is unavailable. Check Redis and the worker.');
  }
});

executionRouter.get('/:jobId', requireProjectRole(), async (req, res) => {
  const id = z.string().regex(/^\d{1,20}$/).parse(req.params.jobId);
  try {
    if (!executionReady()) throw new HttpError(503, 'Execution status is unavailable. Check Redis and try again.');
    const job = await executionQueue.getJob(id);
    if (!job || job.data.projectId !== req.project!.id || job.data.userId !== req.session.userId) throw new HttpError(404, 'Execution not found or expired.');
    const state = await job.getState();
    if (state === 'unknown') throw new HttpError(404, 'Execution not found or expired.');
    res.json({ job: { id: job.id, status: state, fileName: job.data.fileName, revision: job.data.revision,
      language: job.data.language, result: state === 'completed' ? job.returnvalue : null,
      error: state === 'failed' ? 'The worker could not run this job. Check Docker and the runner images.' : null } });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'Execution status is unavailable. Check Redis and try again.');
  }
});
