import { Router } from 'express';
import { z } from 'zod';
import { Project, User } from './models.js';
import { HttpError, requireAuth, requireProjectRole } from './middleware.js';
import { emailSchema } from './auth.js';
import { fileRouter } from './files.js';
import { projectEvents } from './projectEvents.js';
import { executionRouter } from './executions.js';
import { invalidateProjectCache, projectMembers } from './projectCache.js';
import { assistantRouter } from './assistant.js';

export const projectRouter = Router();
projectRouter.use(requireAuth);
projectRouter.use('/:id/files', fileRouter);
projectRouter.use('/:id/executions', executionRouter);
projectRouter.use('/:id/assistant', assistantRouter);
const projectInput = z.object({ name: z.string().trim().min(1, 'Enter a project name.').max(80) }).strict();
const memberIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid member ID.');
const memberRoleSchema = z.object({ role: z.enum(['editor', 'viewer']) }).strict();

function summarize(project: InstanceType<typeof Project>, userId: string) {
  return {
    id: project.id, name: project.name, ownerId: project.owner.toString(),
    role: project.owner.toString() === userId ? 'owner' : project.members.find((member) => member.user.toString() === userId)!.role,
    memberCount: project.members.length + 1,
    createdAt: project.createdAt, updatedAt: project.updatedAt,
  };
}

projectRouter.get('/', async (req, res) => {
  const userId = req.session.userId!;
  const projects = await Project.find({ $or: [{ owner: userId }, { 'members.user': userId }] }).sort({ updatedAt: -1 });
  res.json({ projects: projects.map((project) => summarize(project, userId)) });
});

projectRouter.post('/', async (req, res) => {
  const input = projectInput.parse(req.body);
  const project = await Project.create({ name: input.name, owner: req.session.userId });
  res.status(201).json({ project: summarize(project, req.session.userId!) });
});

projectRouter.get('/:id', requireProjectRole(), async (req, res) => {
  const project = req.project!;
  const members = await projectMembers(project);
  res.json({ project: { ...summarize(project, req.session.userId!), members } });
});

projectRouter.patch('/:id', requireProjectRole(['owner']), async (req, res) => {
  const project = req.project!;
  const input = projectInput.parse(req.body);
  const updated = await Project.findOneAndUpdate({ _id: project._id, owner: req.session.userId }, { $set: { name: input.name } }, { new: true, runValidators: true });
  if (!updated) throw new HttpError(404, 'Project not found.');
  await invalidateProjectCache(project.id);
  projectEvents.emit('changed', project.id);
  res.json({ project: summarize(updated, req.session.userId!) });
});

projectRouter.delete('/:id', requireProjectRole(['owner']), async (req, res) => {
  const project = req.project!;
  await Project.deleteOne({ _id: project._id, owner: req.session.userId });
  await invalidateProjectCache(project.id);
  projectEvents.emit('changed', project.id);
  res.status(204).end();
});

projectRouter.post('/:id/members', requireProjectRole(['owner']), async (req, res) => {
  const project = req.project!;
  const input = z.object({ email: z.string().trim().pipe(emailSchema), role: z.enum(['editor', 'viewer']) }).strict().parse(req.body);
  const user = await User.findOne({ email: input.email });
  if (!user) throw new HttpError(404, 'No registered user has this email address.');
  if (project.owner.equals(user._id)) throw new HttpError(409, 'This user already owns the project.');
  // The condition and push run atomically, preventing duplicate members during concurrent requests.
  const updated = await Project.findOneAndUpdate(
    { _id: project._id, owner: req.session.userId, 'members.user': { $ne: user._id } },
    { $push: { members: { user: user._id, role: input.role } } },
    { new: true, runValidators: true },
  );
  if (!updated) {
    if (!await Project.exists({ _id: project._id })) throw new HttpError(404, 'Project not found.');
    throw new HttpError(409, 'This user is already a project member.');
  }
  await invalidateProjectCache(project.id);
  res.status(201).json({ member: { id: user.id, name: user.name, email: user.email, role: input.role } });
  projectEvents.emit('changed', project.id);
});

projectRouter.patch('/:id/members/:userId', requireProjectRole(['owner']), async (req, res) => {
  const project = req.project!;
  const userId = memberIdSchema.parse(req.params.userId);
  const input = memberRoleSchema.parse(req.body);
  if (project.owner.equals(userId)) throw new HttpError(400, 'The owner role cannot be changed.');
  const updated = await Project.findOneAndUpdate(
    { _id: project._id, owner: req.session.userId, 'members.user': userId },
    { $set: { 'members.$.role': input.role } },
    { new: true, runValidators: true },
  );
  if (!updated) throw new HttpError(404, 'Project or member not found.');
  await invalidateProjectCache(project.id);
  projectEvents.emit('changed', project.id);
  res.json({ member: { id: userId, role: input.role } });
});

projectRouter.delete('/:id/members/:userId', requireProjectRole(['owner']), async (req, res) => {
  const project = req.project!;
  const userId = memberIdSchema.parse(req.params.userId);
  if (project.owner.equals(userId)) throw new HttpError(400, 'The project owner cannot be removed.');
  const updated = await Project.findOneAndUpdate(
    { _id: project._id, owner: req.session.userId, 'members.user': userId },
    { $pull: { members: { user: userId } } },
    { new: true },
  );
  if (!updated) throw new HttpError(404, 'Project or member not found.');
  await invalidateProjectCache(project.id);
  projectEvents.emit('changed', project.id);
  res.status(204).end();
});
