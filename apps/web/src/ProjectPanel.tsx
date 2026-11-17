import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, type ProjectDetails } from './api';

interface Props { id: string; onClose: () => void; onChanged: () => Promise<void>; onSignedOut: () => void; onOpenEditor: (project: ProjectDetails) => void }

export function ProjectPanel({ id, onClose, onChanged, onSignedOut, onOpenEditor }: Props) {
  const [project, setProject] = useState<ProjectDetails | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try { setProject((await api<{ project: ProjectDetails }>(`/projects/${id}`)).project); }
    catch (error) {
      setProject(null);
      if (error instanceof ApiError && error.status === 401) onSignedOut();
      else setLoadError(errorMessage(error));
    } finally { setLoading(false); }
  }, [id, onSignedOut]);
  useEffect(() => { void load(); }, [load]);

  async function mutate(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try { await action(); setMessage(success); await load(); await onChanged(); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) onSignedOut();
      else {
        setError(errorMessage(error));
        if (error instanceof ApiError && [403, 404].includes(error.status)) await load();
      }
    }
    finally { setBusy(false); }
  }

  function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get('name');
    void mutate(() => api(`/projects/${id}`, 'PATCH', { name }), 'Project renamed.');
  }

  function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    void mutate(async () => {
      await api(`/projects/${id}/members`, 'POST', { email: fields.get('email'), role: fields.get('role') });
      form.reset();
    }, 'Member added. They can now find this project in their workspace.');
  }

  function changeRole(event: FormEvent<HTMLFormElement>, userId: string) {
    event.preventDefault();
    const role = new FormData(event.currentTarget).get('role');
    void mutate(() => api(`/projects/${id}/members/${userId}`, 'PATCH', { role }), 'Member role updated.');
  }

  function removeMember(userId: string) {
    void mutate(async () => {
      await api(`/projects/${id}/members/${userId}`, 'DELETE');
      setRemovingId(null);
    }, 'Member removed. They no longer have access to this project.');
  }

  async function deleteProject() {
    setBusy(true);
    setError('');
    setMessage('');
    try { await api(`/projects/${id}`, 'DELETE'); await onChanged(); onClose(); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) onSignedOut();
      else setError(errorMessage(error));
    }
    finally { setBusy(false); }
  }

  return <section className="project-panel surface" aria-label="Project details">
    <div className="panel-heading"><div><span className="eyebrow">PROJECT DETAILS</span><h2>{project?.name ?? 'Project details'}</h2></div><button className="secondary" onClick={onClose} disabled={busy}>Close</button></div>
    {loading && <p role="status">Loading project…</p>}
    {busy && <p role="status">Saving changes…</p>}
    {loadError && <p className="error" role="alert">{loadError} <button className="text-button" disabled={loading || busy} onClick={() => void load()}>Retry project</button></p>}
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="success" role="status">{message}</p>}
    {project && !loading && <>
      <div className="panel-columns"><div>
        <h3>Project access</h3><p className="muted">You’re an <strong>{project.role}</strong> on this project.</p>
        {project.role === 'owner' ? <form onSubmit={rename} className="rename-form"><label>Project name<input name="name" defaultValue={project.name} key={project.name} required maxLength={80} disabled={busy} /></label><button className="secondary" disabled={busy}>Save name</button></form> : <p className="permission-note">The owner manages project settings and membership. {project.role === 'editor' ? 'Your editor role allows file and code changes.' : 'Your viewer role gives you read-only access to files.'}</p>}
        <div className="milestone-note"><button className="primary" disabled={busy} onClick={() => onOpenEditor(project)}>Open editor →</button><p>Browse files and {project.role === 'viewer' ? 'read code.' : 'edit code with automatic saving.'}</p></div>
      </div><div>
        <h3>People <span className="muted">({project.members.length})</span></h3>
        <ul className="member-list">{project.members.map((member) => <li key={member.id} className="member-row"><div className="member-summary"><span className="avatar small">{member.name.slice(0, 1).toUpperCase()}</span><div className="member-identity"><strong>{member.name}</strong><small>{member.email}</small></div><span className={`role role-${member.role}`}>{member.role}</span></div>
          {project.role === 'owner' && member.role !== 'owner' && <div className="member-controls"><form onSubmit={(event) => changeRole(event, member.id)}><select name="role" aria-label={`Role for ${member.email}`} defaultValue={member.role} key={member.role} disabled={busy}><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button className="secondary" aria-label={`Save role for ${member.email}`} disabled={busy}>Save role</button></form><button className="text-button danger-text" aria-label={`Remove ${member.email}`} disabled={busy} onClick={() => setRemovingId(member.id)}>Remove</button>
            {removingId === member.id && <div className="remove-confirm"><p>Remove {member.name}? They will lose project access.</p><button className="danger" disabled={busy} onClick={() => removeMember(member.id)}>Confirm removal</button><button className="secondary" disabled={busy} onClick={() => setRemovingId(null)}>Cancel removal</button></div>}
          </div>}
        </li>)}</ul>
        {project.role === 'owner' && <form onSubmit={addMember} className="member-form"><h4>Add a collaborator</h4><p className="muted">They’ll need a registered CodeForge account.</p><label>Email address<input name="email" type="email" placeholder="teammate@example.com" required maxLength={254} disabled={busy} /></label><div className="member-actions"><label>Role<select name="role" defaultValue="editor" disabled={busy}><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label><button className="primary" disabled={busy}>Add member</button></div><small className="muted">Editors can modify files; viewers can only read them.</small></form>}
      </div></div>
      {project.role === 'owner' && <div className="delete-area">{confirmDelete ? <><p>Delete <strong>{project.name}</strong>? All members will lose access. This cannot be undone.</p><button className="danger" onClick={() => void deleteProject()} disabled={busy}>Yes, delete project</button><button className="secondary" onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</button></> : <button className="text-button danger-text" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete project</button>}</div>}
    </>}
  </section>;
}
