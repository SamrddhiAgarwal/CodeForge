import { useEffect, useId, useRef, useState } from 'react';
import { api, errorMessage, type ProjectFile } from './api';

const actions = { review: 'Code review', debug: 'Debugging suggestions', tests: 'Unit-test generation', explain: 'Code explanation' };
type Action = keyof typeof actions;
interface Props { projectId: string; file?: ProjectFile; selection: string; ready: boolean }

export function AssistantPanel({ projectId, file, selection, ready }: Props) {
  const actionId = useId();
  const [action, setAction] = useState<Action>('review');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ answer: string; context: string; action: string } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const code = selection || file?.content || '';
  const context = selection ? 'Selected code' : 'Active file';

  useEffect(() => () => { pending.current?.abort(); }, []);
  useEffect(() => {
    if (!ready) { pending.current?.abort(); setLoading(false); setResult(null); setError(''); }
  }, [ready]);

  async function ask() {
    if (!file || pending.current) return;
    setError('');
    setResult(null);
    if (!code.trim()) { setError('Select some code or open a non-empty file.'); return; }
    if (new TextEncoder().encode(code).length > 65536) { setError('AI context must be at most 64 KiB. Select a smaller section.'); return; }
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    try {
      const response = await api<{ answer: string }>(`/projects/${projectId}/assistant`, 'POST', {
        fileId: file.id, action, scope: selection ? 'selection' : 'file', code,
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (!response.answer?.trim()) throw new Error('The AI provider returned an empty response. Please try again.');
      setResult({ answer: response.answer, context: `${file.name} · ${context.toLowerCase()} · ${code.length} characters`, action: actions[action] });
    } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
    finally { pending.current = null; setLoading(false); }
  }

  return <aside className="assistant-panel" aria-label="AI developer assistant">
    <h2>AI developer assistant</h2>
    <p>Review, debug, generate tests, or understand your code.</p>
    <label htmlFor={actionId}>Assistant action</label>
    <select id={actionId} value={action} disabled={loading} onChange={(event) => setAction(event.target.value as Action)}>
      {Object.entries(actions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
    <p className="assistant-context">{file ? `${context}: ${file.name} · ${code.length} characters` : 'Open a file to ask the assistant.'}</p>
    <small>Select text in Monaco to use a snippet; clear the selection to use the active file. This code is sent to Google Gemini only when you ask.</small>
    <button className="primary" disabled={!file || !ready || loading} onClick={() => void ask()}>{loading ? 'Generating…' : 'Ask assistant'}</button>
    {loading && <p role="status">Generating a response…</p>}
    {file && !ready && <p role="status">Waiting for the editor to connect and synchronize…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {result && <div className="assistant-result"><h3>{result.action}</h3><small>{result.context}</small><pre aria-label="Assistant response">{result.answer}</pre></div>}
    <small>Suggestions only. Review generated code before using it; files are never changed automatically.</small>
  </aside>;
}
