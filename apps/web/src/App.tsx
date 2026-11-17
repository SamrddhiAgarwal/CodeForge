import { useEffect, useState } from 'react';
import { api, ApiError, errorMessage, type User } from './api';
import { AuthForm } from './AuthForm';
import { Dashboard } from './Dashboard';

export function Brand() {
  return <div className="brand"><span className="brand-icon" aria-hidden="true">&lt;/&gt;</span> CodeForge<span className="brand-dot">.</span></div>;
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function restoreSession() {
    setLoading(true);
    setError('');
    try { setUser((await api<{ user: User }>('/auth/me')).user); }
    catch (error) { if (!(error instanceof ApiError && error.status === 401)) setError(errorMessage(error)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void restoreSession(); }, []);

  if (loading) return <main className="loading-screen"><Brand /><p role="status">Opening your workspace…</p></main>;
  if (error) return <main className="loading-screen"><Brand /><p role="alert">{error}</p><button onClick={() => void restoreSession()}>Try again</button></main>;
  if (!user) return <AuthForm onAuthenticated={setUser} />;
  return <Dashboard user={user} onSignedOut={() => setUser(null)} />;
}
