import * as Y from 'yjs';
import { Project } from './models.js';
import { HttpError } from './middleware.js';
import { projectEvents } from './projectEvents.js';

const queues = new Map<string, Promise<unknown>>();

export async function inProjectOrder<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(projectId, next);
  try { return await next; }
  finally { if (queues.get(projectId) === next) queues.delete(projectId); }
}

export function decodeUpdate(value: unknown) {
  if (typeof value !== 'string' || value.length > 350000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new HttpError(400, 'Invalid document update.');
  }
  return Buffer.from(value, 'base64');
}

// Persist the CRDT state and plain text together, before acknowledging or broadcasting.
// Loading a fresh Y.Doc per operation avoids a cache drifting from REST writes or restarts.
export function documentOperation(projectId: string, fileId: string, userId: string,
  change?: { update: string } | { content: string; revision: number }) {
  return inProjectOrder(projectId, async () => {
    const project = await Project.findById(projectId).select('+files');
    const role = project?.owner.toString() === userId ? 'owner' : project?.members.find((member) => member.user.toString() === userId)?.role;
    if (!project || !role) throw new HttpError(404, 'Project not found.');
    if (change && role === 'viewer') throw new HttpError(403, 'Viewers cannot edit documents.');
    const file = project.files.id(fileId);
    if (!file || file.kind !== 'file') throw new HttpError(404, 'File not found.');
    if (change && 'revision' in change && change.revision !== file.revision) throw new HttpError(409, 'File changed. Reload before saving.');
    const doc = new Y.Doc();
    try {
      const text = doc.getText('content');
      if (file.yState) Y.applyUpdate(doc, new Uint8Array(file.yState));
      else text.insert(0, file.content);
      if (change && 'update' in change) {
        try { Y.applyUpdate(doc, decodeUpdate(change.update)); }
        catch { throw new HttpError(400, 'Invalid Yjs update.'); }
      } else if (change) {
        doc.transact(() => { text.delete(0, text.length); text.insert(0, change.content); });
      }
      if (doc.share.size !== 1 || text.toDelta().some((part: { insert?: unknown; attributes?: unknown }) => typeof part.insert !== 'string' || part.attributes)) {
        throw new HttpError(400, 'Only plain-text document updates are supported.');
      }
      const content = text.toString();
      const state = Buffer.from(Y.encodeStateAsUpdate(doc));
      if (Buffer.byteLength(content) > 65536) throw new HttpError(400, 'Files must be at most 64 KiB.');
      if (state.length > 262144) throw new HttpError(400, 'Document history limit reached. Copy your code into a new file.');
      const totalBytes = project.files.reduce((sum, item) => sum + (item._id.equals(file._id) ? state.length + Buffer.byteLength(content) : (item.yState?.length ?? 0) + Buffer.byteLength(item.content)), 0);
      if (totalBytes > 12 * 1024 * 1024) throw new HttpError(400, 'Project document storage limit reached.');
      let revision = file.revision;
      if (!file.yState || !state.equals(file.yState)) {
        const result = await Project.updateOne({
          _id: project._id,
          $or: [{ owner: userId }, { members: { $elemMatch: { user: userId, ...(change ? { role: 'editor' } : {}) } } }],
          files: { $elemMatch: { _id: file._id, revision: file.revision } },
        }, {
          $set: { 'files.$.content': content, 'files.$.yState': state },
          $inc: { 'files.$.revision': 1 },
        });
        if (!result.matchedCount) throw new HttpError(409, 'File or permissions changed. Reconnect and try again.');
        revision++;
        projectEvents.emit('document', projectId, fileId, state.toString('base64'), revision);
      }
      return { state: state.toString('base64'), revision, name: file.name };
    } finally { doc.destroy(); }
  });
}
