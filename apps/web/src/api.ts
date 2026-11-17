export interface User { id: string; name: string; email: string }
export type Role = 'owner' | 'editor' | 'viewer';
export interface Member extends User { role: Role }
export interface Project {
  id: string;
  name: string;
  ownerId: string;
  role: Role;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectDetails extends Project { members: Member[] }
export interface FileNode {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  parentId: string | null;
  revision: number;
}
export interface ProjectFile extends FileNode { content: string }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method, credentials: 'include', signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Cannot reach the server. Check your connection and try again.');
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.error ?? 'The server is unavailable. Please try again.');
  if (!data) throw new Error('The server returned an unexpected response.');
  return data as T;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
