import { useState, type FormEvent } from 'react';
import { api, errorMessage, type User } from './api';
import { Brand } from './App';

export function AuthForm({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const body = { email: fields.get('email'), password: fields.get('password'), ...(register ? { name: fields.get('name') } : {}) };
      const result = await api<{ user: User }>(`/auth/${register ? 'register' : 'login'}`, 'POST', body);
      onAuthenticated(result.user);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  return <main className="auth-layout">
    <section className="auth-story">
      <Brand />
      <div className="story-content">
        <span className="eyebrow">A SPACE FOR WHAT’S NEXT</span>
        <h1>Great projects<br />start with<br /><span>good company.</span></h1>
        <p>Bring your people and projects together.<br />Give every collaborator the right access.</p>
        <div className="workspace-illustration" aria-hidden="true">
          <div className="illustration-top"><i /><i /><i /><span>your next idea</span></div>
          <div className="code-line"><b>01</b><span>const</span> project = {'{'}</div>
          <div className="code-line"><b>02</b> &nbsp; name: <em>"Something great"</em>,</div>
          <div className="code-line"><b>03</b> &nbsp; team: [<em>"you"</em>, <em>"your people"</em>]</div>
          <div className="code-line"><b>04</b>{'};'}</div>
          <div className="illustration-bottom"><span className="status-dot" /> A little structure. A lot of possibility.</div>
        </div>
      </div>
      <p className="auth-footer">A shared foundation for your next build.</p>
    </section>
    <section className="auth-form-area">
      <div className="auth-card">
        <span className="eyebrow">YOUR WORKSPACE AWAITS</span>
        <h2>{register ? 'Make yourself at home.' : 'Welcome back.'}</h2>
        <p className="muted">{register ? 'Create an account to start your first project.' : 'Sign in to pick up where you left off.'}</p>
        <form onSubmit={submit} key={register ? 'register' : 'login'}>
          {register && <label>Your name<input name="name" autoComplete="name" placeholder="Alex Morgan" required maxLength={60} disabled={busy} /></label>}
          <label>Email address<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} disabled={busy} /></label>
          <label>Password<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? 'At least 12 characters' : 'Enter your password'} required minLength={12} maxLength={128} disabled={busy} /></label>
          {register && <small className="muted">Use 12–128 characters. A memorable passphrase works well.</small>}
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary full-width" disabled={busy}>{busy ? 'Please wait…' : register ? 'Create account →' : 'Sign in →'}</button>
        </form>
        <p className="switch-auth">{register ? 'Already have an account?' : 'New to CodeForge?'} <button className="text-button" disabled={busy} onClick={() => { setRegister(!register); setError(''); }}>{register ? 'Sign in' : 'Create an account'}</button></p>
      </div>
    </section>
  </main>;
}
