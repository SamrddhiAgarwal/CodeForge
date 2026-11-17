import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, type Project, type User } from './api';
import { Brand } from './App';
import { ProjectPanel } from './ProjectPanel';
const CodeWorkspace = lazy(() => import('./CodeWorkspace'));

export function Dashboard({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [editorProject, setEditorProject] = useState<Project | null>(null);

  const loadProjects = useCallback(async () => {
    setListError('');
    setLoading(true);
    try {
      const projects = (await api<{ projects: Project[] }>('/projects')).projects;
      setProjects(projects);
      setSelectedId((id) => projects.some((project) => project.id === id) ? id : null);
    }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) onSignedOut();
      else setListError(errorMessage(error));
    } finally { setLoading(false); }
  }, [onSignedOut]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get('name');
    setBusy(true);
    setError('');
    try {
      const { project } = await api<{ project: Project }>('/projects', 'POST', { name });
      setCreating(false);
      setSelectedId(project.id);
      await loadProjects();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSignedOut();
      else setError(errorMessage(error));
    }
    finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    try { await api('/auth/logout', 'POST'); onSignedOut(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  if (editorProject) return <Suspense fallback={<main className="loading-screen"><p role="status">Loading editor…</p></main>}><CodeWorkspace project={editorProject} onBack={() => { setEditorProject(null); void loadProjects(); }} /></Suspense>;

  return <div className="workspace">
    <aside className="sidebar">
      <Brand />
      <p className="sidebar-label">WORKSPACE</p>
      <div className="nav-item"><span aria-hidden="true">▦</span> Projects <span className="count">{projects.length}</span></div>
      <div className="sidebar-note"><span className="status-dot" /> A place to build together<p>Organize projects and bring your team on board.</p></div>
      <div className="account"><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><small>{user.email}</small></div></div>
      <button className="sign-out" disabled={busy} onClick={() => void logout()}>Sign out ↗</button>
    </aside>
    <main className="workspace-main">
      <header className="topbar"><span>Workspace <span className="slash">/</span> <strong>Projects</strong></span><span className="workspace-tag">PERSONAL WORKSPACE</span></header>
      <div className="workspace-content">
        <div className="page-heading"><div><span className="eyebrow">MAKE ROOM FOR YOUR NEXT IDEA</span><h1>Your projects<span className="brand-dot">.</span></h1><p className="muted">Your work, your people, all in one place.</p></div><button className="primary" onClick={() => setCreating(!creating)} aria-expanded={creating}>{creating ? 'Cancel' : '+ New project'}</button></div>
        {creating && <form className="create-form surface" onSubmit={createProject}><label>Project name<input name="name" placeholder="e.g. Interview practice" autoFocus required maxLength={80} disabled={busy} /></label><button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button></form>}
        {error && <div className="error" role="alert">{error}</div>}
        {listError && <div className="error" role="alert">{listError} <button className="text-button" disabled={loading} onClick={() => void loadProjects()}>Retry loading</button></div>}
        <div className="list-heading"><h2>All projects <span>{projects.length}</span></h2><button className="text-button" disabled={loading || busy} onClick={() => void loadProjects()}>Refresh ↻</button></div>
        {loading ? <p role="status">Loading projects…</p> : listError ? null : projects.length === 0 ? <section className="empty-state surface"><span className="empty-icon" aria-hidden="true">⌘</span><h2>A clean slate. A new beginning.</h2><p>Create your first project, then invite collaborators.<br />Projects shared with you will appear here too.</p><button className="primary" onClick={() => setCreating(true)}>+ Create your first project</button></section> : <div className="project-grid">{projects.map((project) => <button key={project.id} className={`project-card ${selectedId === project.id ? 'selected' : ''}`} onClick={() => setSelectedId(project.id)} aria-pressed={selectedId === project.id}>
          <div className="card-top"><span className="folder-icon" aria-hidden="true">▱</span><span className={`role role-${project.role}`}>{project.role}</span></div>
          <h3>{project.name}</h3><p>{project.memberCount} {project.memberCount === 1 ? 'member' : 'members'} <span aria-hidden="true">·</span> Project workspace</p>
          <div className="card-bottom"><span>Updated {new Date(project.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><span aria-hidden="true">↗</span></div>
        </button>)}</div>}
        {selectedId && <ProjectPanel key={selectedId} id={selectedId} onClose={() => setSelectedId(null)} onChanged={loadProjects} onSignedOut={onSignedOut} onOpenEditor={setEditorProject} />}
        <footer className="workspace-footer"><span>Built around your next idea.</span><span>CodeForge / Workspace</span></footer>
      </div>
    </main>
  </div>;
}
