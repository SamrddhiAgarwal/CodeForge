import { useRef, useState, type FormEvent } from 'react';
import type { ChatMessage, Presence } from './useFileTabs';
import { errorMessage } from './api';

interface Props { people: Presence[]; messages: ChatMessage[]; ready: boolean; send: (id: string, text: string) => Promise<void> }
export function ProjectChat({ people, messages, ready, send }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const messageId = useRef(crypto.randomUUID());
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try { await send(messageId.current, draft); setDraft(''); messageId.current = crypto.randomUUID(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <section className="collaboration-panel" aria-label="Project collaboration">
    <div><h2>Online <span>({people.length})</span></h2><ul className="online-users">{people.map((person) => <li key={person.socketId}><span style={{ background: person.color }} aria-hidden="true" />{person.name}<small>{person.role}</small></li>)}</ul></div>
    <div className="project-chat"><h2>Project chat</h2><ol className="chat-messages" aria-label="Chat messages" aria-live="polite">{messages.map((message) => <li key={message.messageId}><strong>{message.name}</strong><time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><p>{message.text}</p></li>)}</ol>
      {error && <p className="error" role="alert">{error}</p>}
      <form onSubmit={submit}><label>Message<input value={draft} onChange={(event) => { setDraft(event.target.value); messageId.current = crypto.randomUUID(); }} maxLength={2000} required disabled={!ready || busy} placeholder="Talk with your project members…" /></label><button className="primary" disabled={!ready || busy || !draft.trim()}>{busy ? 'Sending…' : 'Send message'}</button></form>
    </div>
  </section>;
}
