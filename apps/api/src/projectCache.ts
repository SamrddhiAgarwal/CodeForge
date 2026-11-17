import { Project, User } from './models.js';
import { redis } from './redis.js';
import { config } from './config.js';

const key = (id: string) => `${config.REDIS_PREFIX}:project-meta:${id}`;
export async function invalidateProjectCache(id: string) {
  await redis.del(key(id)).catch(() => {});
}

export async function projectMembers(project: InstanceType<typeof Project>) {
  // The route always authorizes against MongoDB first. This fingerprint also rejects a stale cache refill.
  const fingerprint = JSON.stringify([project.name, project.owner.toString(), project.members.map((member) => [member.user.toString(), member.role])]);
  const cached = await redis.get(key(project.id)).catch(() => null);
  if (cached) {
    try {
      const entry = JSON.parse(cached);
      if (entry.fingerprint === fingerprint) return entry.members;
    } catch { /* Rebuild invalid cache entries from MongoDB. */ }
  }
  const users = await User.find({ _id: { $in: [project.owner, ...project.members.map((member) => member.user)] } });
  const members = users.map((user) => ({
    id: user.id, name: user.name, email: user.email,
    role: user.id === project.owner.toString() ? 'owner' : project.members.find((member) => member.user.toString() === user.id)!.role,
  }));
  await redis.set(key(project.id), JSON.stringify({ fingerprint, members }), 'EX', 30).catch(() => {});
  return members;
}
