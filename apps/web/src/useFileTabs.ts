import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import * as Y from 'yjs';
import { errorMessage, type FileNode, type ProjectFile, type Role } from './api';
import { fromBase64, toBase64 } from './yEncoding';

export interface Presence {
  socketId: string; id: string; name: string; role: Role; color: string;
  fileId: string | null;
  cursor: { fileId: string; anchor: string; head: string } | null;
}
export interface ChatMessage { messageId: string; userId: string; name: string; text: string; sentAt: string }
export interface FileTab extends ProjectFile {
  doc: Y.Doc;
  synced: boolean;
  localVersion: number;
  acknowledgedVersion: number;
  savedContent: string;
  status: 'saved' | 'pending' | 'saving' | 'error';
  error: string;
}
interface SyncResult { state: string; revision: number; name: string }

export function useFileTabs(projectId: string) {
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [connection, setConnection] = useState('Connecting…');
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState<Role | null>(null);
  const [people, setPeople] = useState<Presence[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [projectVersion, setProjectVersion] = useState(0);
  const current = useRef<FileTab[]>([]);
  const socket = useRef<Socket | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const requests = useRef(new Map<string, Promise<boolean>>());
  const mounted = useRef(true);
  const connected = useRef(false);

  function update(transform: (tabs: FileTab[]) => FileTab[]) {
    current.current = transform(current.current);
    if (mounted.current) setTabs(current.current);
  }

  async function request<T>(event: string, payload: unknown): Promise<T> {
    if (!socket.current?.connected) throw new Error('Disconnected. Your unsaved code is kept in this tab.');
    const result = await socket.current.timeout(10000).emitWithAck(event, payload);
    if (!result.ok) throw new Error(result.error);
    return result as T;
  }

  function cancelTimer(id: string) {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }

  function apply(id: string, result: SyncResult) {
    const tab = current.current.find((file) => file.id === id);
    if (!tab) return;
    Y.applyUpdate(tab.doc, fromBase64(result.state), 'server');
    update((tabs) => tabs.map((file) => file.id === id ? { ...file, revision: Math.max(file.revision, result.revision), name: result.name ?? file.name } : file));
  }

  async function join(id: string) {
    try {
      const result = await request<SyncResult>('document:join', { fileId: id });
      apply(id, result);
      update((tabs) => tabs.map((file) => file.id === id ? { ...file, synced: true, status: file.localVersion === file.acknowledgedVersion ? 'saved' : 'pending', error: '' } : file));
      const tab = current.current.find((file) => file.id === id);
      if (tab && tab.localVersion !== tab.acknowledgedVersion) {
        await requests.current.get(id);
        await save(id);
      }
    } catch (error) {
      update((tabs) => tabs.map((file) => file.id === id ? { ...file, synced: false, status: 'error', error: errorMessage(error) } : file));
    }
  }

  async function save(id: string): Promise<boolean> {
    cancelTimer(id);
    const inFlight = requests.current.get(id);
    if (inFlight) { if (!await inFlight) return false; return save(id); }
    const tab = current.current.find((file) => file.id === id);
    if (!tab || tab.localVersion === tab.acknowledgedVersion) return true;
    const version = tab.localVersion;
    update((tabs) => tabs.map((file) => file.id === id ? { ...file, status: 'saving', error: '' } : file));
    const pending = (async () => {
      try {
        if (!tab.synced) throw new Error('Reconnect and synchronize this file before saving.');
        const result = await request<SyncResult>('document:update', { fileId: id, update: toBase64(Y.encodeStateAsUpdate(tab.doc)) });
        apply(id, result);
        update((tabs) => tabs.map((file) => file.id === id ? {
          ...file, acknowledgedVersion: version, savedContent: file.content,
          status: file.localVersion === version ? 'saved' : 'pending', error: '',
        } : file));
        return true;
      } catch (error) {
        update((tabs) => tabs.map((file) => file.id === id ? { ...file, status: 'error', error: errorMessage(error) } : file));
        return false;
      } finally { requests.current.delete(id); }
    })();
    requests.current.set(id, pending);
    const saved = await pending;
    const latest = current.current.find((file) => file.id === id);
    if (saved && mounted.current && latest && latest.localVersion !== latest.acknowledgedVersion && !timers.current.has(id)) {
      timers.current.set(id, setTimeout(() => void save(id), 100));
    }
    return saved;
  }

  async function flushAll() {
    for (const file of current.current) {
      do { if (!await save(file.id)) return false; }
      while (current.current.some((tab) => tab.id === file.id && tab.localVersion !== tab.acknowledgedVersion));
    }
    return true;
  }

  async function open(file: ProjectFile) {
    if (current.current.some((tab) => tab.id === file.id)) return;
    const doc = new Y.Doc();
    doc.getText('content');
    update((tabs) => [...tabs, { ...file, doc, synced: false, localVersion: 0, acknowledgedVersion: 0, savedContent: file.content, status: 'saved', error: '' }]);
    doc.on('update', (_update, origin) => {
      const local = origin !== 'server';
      update((tabs) => tabs.map((tab) => tab.id === file.id ? {
        ...tab, content: doc.getText('content').toString(),
        localVersion: tab.localVersion + (local ? 1 : 0),
        status: local ? 'pending' : tab.status,
      } : tab));
      if (local) {
        cancelTimer(file.id);
        if (connected.current) timers.current.set(file.id, setTimeout(() => void save(file.id), 100));
      }
    });
    if (socket.current?.connected) await join(file.id);
  }

  function remove(ids: string[]) {
    for (const id of ids) {
      cancelTimer(id);
      const tab = current.current.find((file) => file.id === id);
      tab?.doc.destroy();
      if (socket.current?.connected) void request('document:leave', { fileId: id }).catch(() => {});
    }
    update((tabs) => tabs.filter((tab) => !ids.includes(tab.id)));
  }

  function rename(file: FileNode) { update((tabs) => tabs.map((tab) => tab.id === file.id ? { ...tab, name: file.name } : tab)); }

  function reconcile(files: FileNode[]) {
    const missing = current.current.filter((tab) => !files.some((file) => file.id === tab.id));
    remove(missing.filter((tab) => tab.localVersion === tab.acknowledgedVersion).map((tab) => tab.id));
    update((tabs) => tabs.map((tab) => {
      const file = files.find((file) => file.id === tab.id);
      return file ? { ...tab, name: file.name } : { ...tab, synced: false, status: 'error', error: 'File was deleted. Copy your unsaved code, then discard this tab.' };
    }));
  }

  async function reload(id: string) {
    const pending = requests.current.get(id);
    if (pending) await pending;
    const file = current.current.find((tab) => tab.id === id);
    if (!file) return;
    remove([id]);
    await open(file);
  }

  function sendCursor(cursor: Presence['cursor']) {
    if (connected.current) socket.current?.volatile.emit('cursor', cursor);
  }

  async function sendChat(messageId: string, text: string) { await request('chat:send', { messageId, text }); }

  useEffect(() => {
    mounted.current = true;
    // Browser WebSocket handshakes include Origin, including through the local Vite proxy.
    const client = io({ transports: ['websocket'], autoConnect: false, withCredentials: true, auth: { projectId }, reconnectionDelay: 500, reconnectionDelayMax: 3000 });
    socket.current = client;
    client.on('connect', async () => {
      setConnection('Synchronizing…');
      try {
        const result = await request<{ user: { role: Role }; messages: ChatMessage[] }>('project:sync', {});
        if (!mounted.current || !client.connected) return;
        setRole(result.user.role);
        setMessages((existing) => [...new Map([...result.messages, ...existing].map((message) => [message.messageId, message])).values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt)).slice(-100));
        for (const tab of current.current) await join(tab.id);
        if (!mounted.current || !client.connected) return;
        connected.current = true;
        setReady(true);
        setConnection('Connected');
        setProjectVersion((version) => version + 1);
      } catch (error) { if (mounted.current) setConnection(errorMessage(error)); }
    });
    client.on('disconnect', (reason) => {
      connected.current = false;
      setReady(false);
      setConnection((previous) => reason === 'io server disconnect' ? previous : 'Disconnected — reconnecting…');
      setPeople([]);
      update((tabs) => tabs.map((tab) => ({ ...tab, synced: false })));
    });
    client.on('connect_error', () => { setReady(false); setConnection('Connection failed. Check your session and project access, then reconnect.'); });
    client.on('access-lost', ({ error }: { error: string }) => {
      connected.current = false;
      setReady(false);
      setRole(null);
      setConnection(error);
      update((tabs) => tabs.map((tab) => ({ ...tab, synced: false, status: 'error', error })));
    });
    client.on('document', (result: SyncResult & { fileId: string }) => apply(result.fileId, result));
    client.on('presence', setPeople);
    client.on('chat', (message: ChatMessage) => setMessages((messages) => messages.some((item) => item.messageId === message.messageId) ? messages : [...messages, message].slice(-100)));
    client.on('project-changed', ({ role }: { role: Role }) => { setRole(role); setProjectVersion((version) => version + 1); });
    client.connect();
    const warn = (event: BeforeUnloadEvent) => {
      if (current.current.some((tab) => tab.localVersion !== tab.acknowledgedVersion)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      mounted.current = false;
      connected.current = false;
      client.removeAllListeners();
      client.disconnect();
      timers.current.forEach(clearTimeout);
      current.current.forEach((tab) => tab.doc.destroy());
      window.removeEventListener('beforeunload', warn);
    };
  }, [projectId]);

  return { tabs, open, save, flushAll, remove, rename, reload, reconcile, ready, role, connection, people, messages, sendChat, sendCursor, projectVersion,
    socketId: socket.current?.id, reconnect: () => { socket.current?.disconnect(); socket.current?.connect(); } };
}
