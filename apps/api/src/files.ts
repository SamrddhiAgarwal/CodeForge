import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Project } from './models.js';
import { HttpError, requireProjectRole } from './middleware.js';
import { documentOperation } from './documents.js';
import { projectEvents } from './projectEvents.js';

export const fileRouter = Router({ mergeParams: true });
const idSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid file or folder ID.');
const nameSchema = z.string().trim().min(1).max(120).refine(
  (name) => name !== '.' && name !== '..' && !/[\\/\x00-\x1f\x7f]/.test(name),
  'Names cannot contain path separators, control characters, or be . or ...',
);
const writers = requireProjectRole(['owner', 'editor']);

async function loadProject(req: Request) {
  const project = await Project.findById(req.project!._id).select('+files');
  if (!project) throw new HttpError(404, 'Project not found.');
  return project;
}

type FileNode = InstanceType<typeof Project>['files'][number];
function metadata(node: FileNode) {
  return { id: node._id.toString(), name: node.name, kind: node.kind, parentId: node.parentId?.toString() ?? null, revision: node.revision };
}

function writeFilter(req: Request) {
  // Check current permission again in the write, including membership changes during the request.
  return { _id: req.project!._id, $or: [{ owner: req.session.userId }, { members: { $elemMatch: { user: req.session.userId, role: 'editor' } } }] };
}

function treeFilter(req: Request, version: number) {
  // Older projects do not yet have a tree version. Structural writes serialize via this counter.
  return { ...writeFilter(req), $expr: { $eq: [{ $ifNull: ['$fileTreeVersion', 0] }, version] } };
}

fileRouter.get('/', requireProjectRole(), async (req, res) => {
  const project = await loadProject(req);
  res.json({ files: project.files.map(metadata) });
});

fileRouter.get('/:fileId', requireProjectRole(), async (req, res) => {
  const project = await loadProject(req);
  const node = project.files.id(idSchema.parse(req.params.fileId));
  if (!node) throw new HttpError(404, 'File not found.');
  if (node.kind !== 'file') throw new HttpError(400, 'Folders do not have file content.');
  res.json({ file: { ...metadata(node), content: node.content } });
});

fileRouter.post('/', writers, async (req, res) => {
  const input = z.object({ name: nameSchema, kind: z.enum(['file', 'folder']), parentId: idSchema.nullable().default(null) }).strict().parse(req.body);
  const project = await loadProject(req);
  if (project.files.length >= 100) throw new HttpError(400, 'Projects support up to 100 files and folders.');
  if (input.parentId && project.files.id(input.parentId)?.kind !== 'folder') throw new HttpError(400, 'Parent folder not found in this project.');
  const parentId = input.parentId ? new Types.ObjectId(input.parentId) : null;
  if (project.files.some((node) => (node.parentId?.toString() ?? null) === (parentId?.toString() ?? null) && node.name === input.name)) {
    throw new HttpError(409, 'A file or folder with that name already exists here.');
  }
  const node = { _id: new Types.ObjectId(), ...input, parentId, content: '', revision: 0 };
  const result = await Project.updateOne(treeFilter(req, project.fileTreeVersion), { $push: { files: node }, $inc: { fileTreeVersion: 1 } });
  if (!result.matchedCount) throw new HttpError(409, 'Project changed or access was revoked. Refresh the explorer and try again.');
  projectEvents.emit('changed', req.project!.id);
  res.status(201).json({ file: { id: node._id.toString(), ...input, parentId: parentId?.toString() ?? null, content: '', revision: 0 } });
});

fileRouter.patch('/:fileId', writers, async (req, res) => {
  const input = z.object({ name: nameSchema }).strict().parse(req.body);
  const project = await loadProject(req);
  const node = project.files.id(idSchema.parse(req.params.fileId));
  if (!node) throw new HttpError(404, 'File not found.');
  if (node.kind !== 'file') throw new HttpError(400, 'Only files can be renamed in this milestone.');
  if (project.files.some((other) => !other._id.equals(node._id) && (other.parentId?.toString() ?? null) === (node.parentId?.toString() ?? null) && other.name === input.name)) {
    throw new HttpError(409, 'A file or folder with that name already exists here.');
  }
  const result = await Project.updateOne({ ...treeFilter(req, project.fileTreeVersion), 'files._id': node._id }, { $set: { 'files.$.name': input.name }, $inc: { fileTreeVersion: 1 } });
  if (!result.matchedCount) throw new HttpError(409, 'Project changed or access was revoked. Refresh the explorer and try again.');
  projectEvents.emit('changed', req.project!.id);
  res.json({ file: { ...metadata(node), name: input.name } });
});

fileRouter.put('/:fileId/content', writers, async (req, res) => {
  const fileId = idSchema.parse(req.params.fileId);
  const input = z.object({
    content: z.string().max(65536).refine((value) => Buffer.byteLength(value, 'utf8') <= 65536, 'Files must be at most 64 KiB.'),
    revision: z.number().int().min(0),
  }).strict().parse(req.body);
  const result = await documentOperation(req.project!.id, fileId, req.session.userId!, input);
  res.json({ revision: result.revision });
});

fileRouter.delete('/:fileId', writers, async (req, res) => {
  const project = await loadProject(req);
  const node = project.files.id(idSchema.parse(req.params.fileId));
  if (!node) throw new HttpError(404, 'File or folder not found.');
  const deletedIds = new Set([node._id.toString()]);
  // Include every descendant before removing the subtree in a single MongoDB write.
  let previousSize = 0;
  while (previousSize !== deletedIds.size) {
    previousSize = deletedIds.size;
    for (const child of project.files) {
      if (child.parentId && deletedIds.has(child.parentId.toString())) deletedIds.add(child._id.toString());
    }
  }
  const result = await Project.updateOne(treeFilter(req, project.fileTreeVersion), { $pull: { files: { _id: { $in: [...deletedIds] } } }, $inc: { fileTreeVersion: 1 } });
  if (!result.matchedCount) throw new HttpError(409, 'Project changed or access was revoked. Refresh the explorer and try again.');
  projectEvents.emit('changed', req.project!.id);
  res.json({ deletedIds: [...deletedIds] });
});
