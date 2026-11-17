import { useEffect, useState } from 'react';
import type { ExecutionResult } from '@codeforge/execution';
import { api, ApiError, errorMessage, type FileNode } from './api';

interface Job {
  id: string;
  fileName: string;
  revision: number;
  status?: string;
  result?: ExecutionResult | null;
  error?: string | null;
}
interface Props {
  projectId: string;
  file?: FileNode;
  canRun: boolean;
  ready: boolean;
  flush: () => Promise<boolean>;
}

export function ExecutionPanel({ projectId, file, canRun, ready, flush }: Props) {
  const [job, setJob] = useState<Job | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [pollAttempt, setPollAttempt] = useState(0);
  const pending = Boolean(job && job.status !== 'completed' && job.status !== 'failed');
  const supported = Boolean(file && /\.(js|mjs|cjs|py|cpp|cc|cxx)$/i.test(file.name));

  useEffect(() => {
    if (!job || !pending) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await api<{ job: Job }>(`/projects/${projectId}/executions/${job.id}`);
        if (cancelled) return;
        setJob(response.job);
        setError('');
        if (!['completed', 'failed'].includes(response.job.status ?? '')) timer = setTimeout(() => void poll(), 1000);
      } catch (error) {
        if (cancelled) return;
        setError(errorMessage(error));
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) setJob((current) => current ? { ...current, status: 'failed' } : null);
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [projectId, job?.id, pending, pollAttempt]);

  async function run() {
    if (!file) return;
    setSubmitting(true);
    setError('');
    try {
      if (!await flush()) throw new Error('Save your changes successfully before running.');
      const response = await api<{ job: Job }>(`/projects/${projectId}/executions`, 'POST', { fileId: file.id });
      setJob({ ...response.job, status: 'waiting' });
    } catch (error) { setError(errorMessage(error)); }
    finally { setSubmitting(false); }
  }

  return <section className="execution-panel" aria-label="Code execution">
    <div className="execution-heading"><div><h2>Run code</h2><p>Run the saved file · JavaScript, Python, C++</p></div>
      <button className="primary" disabled={!canRun || !ready || !supported || submitting || pending} onClick={() => void run()}>{submitting ? 'Saving and submitting…' : 'Run file'}</button>
    </div>
    {!canRun ? <p>Viewers can read files; running code requires an Owner or Editor role.</p> : file && !supported ? <p>This file type cannot run. Choose a JavaScript, Python, or C++ file.</p> : !file ? <p>Open a file to run it.</p> : null}
    {error && <p className="error" role="alert">{error}{pending && <button className="text-button" onClick={() => setPollAttempt((value) => value + 1)}>Retry status</button>}</p>}
    {job && <>
      <p role="status">{job.fileName} · Saved revision {job.revision} · {job.status === 'active' ? 'Running' : job.status === 'waiting' ? 'Queued — waiting for worker' : job.status}</p>
      {job.error && <p className="error" role="alert">{job.error}</p>}
      {job.result && <>
        <p className="execution-summary">Exit code: {job.result.exitCode ?? 'unavailable'} · {(job.result.durationMs / 1000).toFixed(2)}s
          {job.result.timedOut && ' · Time limit exceeded'}{job.result.outputLimited && ' · Output limit exceeded (truncated)'}{job.result.memoryLimited && ' · Memory limit exceeded'}</p>
        <div className="execution-output"><div><h3>stdout</h3><pre aria-label="Standard output">{job.result.stdout || '(no output)'}</pre></div><div><h3>stderr</h3><pre aria-label="Standard error">{job.result.stderr || '(no errors)'}</pre></div></div>
      </>}
    </>}
    <small>Single file · No network or interactive input · 256 MiB memory · 1 CPU · 32 KiB output · 5s (C++: 15s including compilation)</small>
  </section>;
}
