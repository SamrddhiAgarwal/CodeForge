import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage, type FileNode, type Project, type ProjectFile } from './api';
import { FileExplorer } from './FileExplorer';
import { useFileTabs } from './useFileTabs';
import { languageFor, monaco } from './monaco';
import { CollaborativeEditor } from './CollaborativeEditor';
import { ProjectChat } from './ProjectChat';
import { ExecutionPanel } from './ExecutionPanel';
import { AssistantPanel } from './AssistantPanel';
import './editor.css';

interface Props { project: Project; onBack: () => void }
type FileAction = 'file' | 'folder' | 'rename' | 'delete' | null;

export default function CodeWorkspace({ project: initialProject, onBack }: Props) {
  const [project, setProject] = useState(initialProject);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [action, setAction] = useState<FileAction>(null);
  const [codeSelection, setCodeSelection] = useState({ key: '', code: '' });
  const tabs = useFileTabs(project.id);
  const active = tabs.tabs.find((tab) => tab.id === activeId);
  const activeKey = active ? `${active.id}:${active.doc.clientID}` : 'no-file';
  const selected = files.find((file) => file.id === selectedId);
  const effectiveRole = tabs.role ?? project.role;
  const canEdit = effectiveRole !== 'viewer';
  const allowChanges = canEdit && tabs.ready;
  const parentId = selected?.kind === 'folder' ? selected.id : selected?.parentId ?? null;
  const modelPrefix = `file:///${project.id}/`;

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [details, listing] = await Promise.all([
        api<{ project: Project }>(`/projects/${project.id}`),
        api<{ files: FileNode[] }>(`/projects/${project.id}/files`),
      ]);
      setProject(details.project);
      setFiles(listing.files);
      tabs.reconcile(listing.files);
      setSelectedId((id) => listing.files.some((file) => file.id === id) ? id : null);
    } catch (error) { setError(errorMessage(error)); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    void load();
    return () => {
      monaco.editor.getModels().filter((model) => model.uri.toString().startsWith(modelPrefix)).forEach((model) => model.dispose());
    };
  }, [project.id]);

  useEffect(() => { if (tabs.projectVersion > 0) void load(); }, [tabs.projectVersion]);

  useEffect(() => {
    // Closed/deleted files must not retain an old draft when they are reopened.
    const openPaths = new Set(tabs.tabs.map((tab) => `${modelPrefix}${tab.id}`));
    monaco.editor.getModels().filter((model) => model.uri.toString().startsWith(modelPrefix) && !openPaths.has(model.uri.toString())).forEach((model) => model.dispose());
  }, [tabs.tabs, modelPrefix]);

  async function selectFile(file: FileNode | null) {
    setSelectedId(file?.id ?? null);
    setAction(null);
    if (!file || file.kind === 'folder') return;
    if (tabs.tabs.some((tab) => tab.id === file.id)) { setActiveId(file.id); return; }
    setOpening(true);
    setError('');
    try {
      const result = await api<{ file: ProjectFile }>(`/projects/${project.id}/files/${file.id}`);
      await tabs.open(result.file);
      setActiveId(file.id);
    } catch (error) { setError(errorMessage(error)); }
    finally { setOpening(false); }
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function closeTab(id: string, discard = false) {
    if (discard) {
      if (!window.confirm('Discard the unsaved code in this tab?')) return;
    } else if (!await tabs.flushAll()) return;
    tabs.remove([id]);
    if (activeId === id) setActiveId(tabs.tabs.find((tab) => tab.id !== id)?.id ?? null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get('name');
    void run(async () => {
      if (!await tabs.flushAll()) return;
      if (action === 'rename' && selected) {
        const result = await api<{ file: FileNode }>(`/projects/${project.id}/files/${selected.id}`, 'PATCH', { name });
        tabs.rename(result.file);
      } else if (action === 'file' || action === 'folder') {
        const result = await api<{ file: ProjectFile }>(`/projects/${project.id}/files`, 'POST', { name, kind: action, parentId });
        setSelectedId(result.file.id);
        if (action === 'file') { await tabs.open(result.file); setActiveId(result.file.id); }
      }
      setAction(null);
      await load();
    });
  }

  async function deleteNode() {
    if (!selected) return;
    // Deletion explicitly discards the selected subtree. Finish outstanding saves first.
    if (!await tabs.flushAll()) return;
    const result = await api<{ deletedIds: string[] }>(`/projects/${project.id}/files/${selected.id}`, 'DELETE');
    tabs.remove(result.deletedIds);
    if (activeId && result.deletedIds.includes(activeId)) setActiveId(tabs.tabs.find((tab) => !result.deletedIds.includes(tab.id))?.id ?? null);
    setSelectedId(null);
    setAction(null);
    await load();
  }

  return <main className="code-workspace">
    <header className="code-header"><button className="secondary" disabled={busy || opening} onClick={() => void run(async () => { if (await tabs.flushAll()) onBack(); })}>← Projects</button><div><span className="eyebrow">CODEFORGE / EDITOR</span><h1>{project.name}</h1></div><span className={`role role-${effectiveRole}`}>{effectiveRole}{!canEdit ? ' · read only' : ''}</span></header>
    <div className="code-toolbar"><span role="status">{tabs.connection}{canEdit ? ' · Changes sync and save automatically.' : ' · Read-only editing; chat is available.'}</span>{!tabs.ready && <button className="secondary" onClick={tabs.reconnect}>Reconnect</button>}<button className="text-button" disabled={busy || loading || opening} onClick={() => void run(async () => { if (await tabs.flushAll()) await load(); })}>Refresh explorer</button></div>
    {error && <p className="error" role="alert">{error} <button className="text-button" disabled={busy || loading} onClick={() => void load()}>Retry loading</button></p>}
    <div className="code-layout">
      <aside className="explorer"><div className="explorer-heading"><h2>Files</h2><small>{files.length}/100</small></div>
        {canEdit && <div className="file-actions"><button disabled={!allowChanges || busy || loading || opening} onClick={() => setAction('file')}>+ File</button><button disabled={!allowChanges || busy || loading || opening} onClick={() => setAction('folder')}>+ Folder</button><button disabled={!allowChanges || busy || loading || !selected || selected.kind !== 'file'} onClick={() => setAction('rename')}>Rename</button><button disabled={!allowChanges || busy || loading || !selected} onClick={() => setAction('delete')}>Delete</button></div>}
        {loading ? <p role="status">Loading files…</p> : <FileExplorer files={files} selectedId={selectedId} disabled={busy || opening} onSelect={(file) => void selectFile(file)} />}
        {action && action !== 'delete' && <form className="file-form" onSubmit={submit} key={`${action}:${selectedId}`}><label>{action === 'rename' ? 'New file name' : action === 'file' ? 'File name' : 'Folder name'}<input name="name" defaultValue={action === 'rename' ? selected?.name : ''} placeholder={action === 'folder' ? 'src' : 'main.ts'} required maxLength={120} autoFocus disabled={busy} /></label>{action !== 'rename' && <small>Inside: {files.find((file) => file.id === parentId)?.name ?? 'Project root'}</small>}<button className="primary" disabled={busy}>{action === 'rename' ? 'Rename file' : action === 'folder' ? 'Create folder' : 'Create file'}</button><button type="button" className="secondary" disabled={busy} onClick={() => setAction(null)}>Cancel</button></form>}
        {action === 'delete' && selected && <div className="file-form"><p>Delete <strong>{selected.name}</strong>{selected.kind === 'folder' ? ' and all its contents' : ''}? This cannot be undone.</p><button className="danger" disabled={busy} onClick={() => void run(deleteNode)}>Confirm delete</button><button className="secondary" disabled={busy} onClick={() => setAction(null)}>Cancel</button></div>}
      </aside>
      <section className="editor-area" aria-label="Code editor">
        <div className="editor-tabs" role="tablist" aria-label="Open files">{tabs.tabs.map((tab) => <div key={tab.id} className={`editor-tab ${activeId === tab.id ? 'active' : ''}`}><button role="tab" aria-selected={activeId === tab.id} disabled={opening || busy} onClick={() => { setActiveId(tab.id); setSelectedId(tab.id); setAction(null); }}>{tab.name}{tab.localVersion !== tab.acknowledgedVersion ? ' •' : ''}</button><button aria-label={`Close ${tab.name}`} disabled={busy || opening} onClick={() => void run(() => closeTab(tab.id))}>×</button></div>)}</div>
        {opening && <p className="editor-notice" role="status">Loading file…</p>}
        {active ? <>
          <div className="save-status" role="status"><span>{active.name} · {languageFor(active.name)}</span><strong>{active.status === 'error' ? 'Not saved' : !active.synced ? 'Synchronizing…' : !canEdit ? 'Read only' : active.status === 'saved' ? 'Saved to MongoDB' : active.status === 'saving' ? 'Saving…' : 'Unsaved changes…'}</strong></div>
          {active.error && <div className="error" role="alert">{active.error}<div className="save-error-actions"><button disabled={busy} onClick={() => void run(async () => { await tabs.flushAll(); })}>Retry save</button><button disabled={busy} onClick={() => { if (window.confirm('Discard local edits and reload the saved version?')) void run(() => tabs.reload(active.id)); }}>Reload saved version</button><button disabled={busy} onClick={() => void run(() => closeTab(active.id, true))}>Discard tab</button></div><small>Your code is still in this tab. Copy it before discarding or reloading.</small></div>}
          <CollaborativeEditor key={activeKey} tab={active} projectId={project.id} readOnly={!allowChanges || !active.synced || busy || opening} people={tabs.people} socketId={tabs.socketId} sendCursor={tabs.sendCursor} onSelectionChange={(code) => setCodeSelection({ key: activeKey, code })} />
        </> : <div className="editor-empty"><span aria-hidden="true">&lt;/&gt;</span><h2>A place for your code.</h2><p>Open a file from the explorer{canEdit ? ', or create your first file' : ''}.</p><small>JavaScript · TypeScript · Python · C++</small></div>}
      </section>
      <AssistantPanel key={`${project.id}:${activeKey}`} projectId={project.id} file={active} selection={codeSelection.key === activeKey ? codeSelection.code : ''} ready={tabs.ready && Boolean(active?.synced) && !opening && !busy} />
    </div>
    <footer className="code-footer"><span role="status">{busy ? 'Working…' : tabs.tabs.some((tab) => tab.status === 'error') ? 'Some files are not saved' : tabs.tabs.some((tab) => tab.localVersion !== tab.acknowledgedVersion) ? 'Changes pending across open tabs…' : 'All changes saved'}</span><span>64 KiB per file · Live collaboration</span></footer>
    <ExecutionPanel key={project.id} projectId={project.id} file={active} canRun={canEdit} ready={allowChanges && !busy && !opening && Boolean(active?.synced)} flush={tabs.flushAll} />
    <ProjectChat people={tabs.people} messages={tabs.messages} ready={tabs.ready} send={tabs.sendChat} />
  </main>;
}
