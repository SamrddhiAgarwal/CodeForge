import { useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { MonacoBinding } from 'y-monaco';
import * as Y from 'yjs';
import { monaco, languageFor } from './monaco';
import { fromBase64, toBase64 } from './yEncoding';
import type { FileTab, Presence } from './useFileTabs';

interface Props { tab: FileTab; projectId: string; readOnly: boolean; people: Presence[]; socketId?: string; sendCursor: (cursor: Presence['cursor']) => void; onSelectionChange: (code: string) => void }
const colors = ['#df9a57', '#72b9e8', '#c694e8', '#75c99a', '#eb8585', '#c8be69'];

export function CollaborativeEditor({ tab, projectId, readOnly, people, socketId, sendCursor, onSelectionChange }: Props) {
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const binding = useRef<MonacoBinding | null>(null);
  const cursorListener = useRef<monaco.IDisposable | null>(null);
  const contentListener = useRef<monaco.IDisposable | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function drawCursors() {
    const model = editor.current?.getModel();
    if (!model || !decorations.current) return;
    const items: monaco.editor.IModelDeltaDecoration[] = [];
    for (const person of people) {
      if (person.socketId === socketId || person.cursor?.fileId !== tab.id) continue;
      try {
        const anchor = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(person.cursor.anchor)), tab.doc);
        const head = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(person.cursor.head)), tab.doc);
        if (!anchor || !head || anchor.type !== tab.doc.getText('content') || head.type !== anchor.type) continue;
        const start = model.getPositionAt(Math.min(anchor.index, head.index));
        const end = model.getPositionAt(Math.max(anchor.index, head.index));
        const caret = model.getPositionAt(head.index);
        const color = Math.max(0, colors.indexOf(person.color));
        items.push({ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), options: { className: `remote-selection remote-color-${color}` } });
        items.push({ range: new monaco.Range(caret.lineNumber, caret.column, caret.lineNumber, caret.column), options: { beforeContentClassName: `remote-caret remote-color-${color}`, hoverMessage: { value: person.name.replace(/[\\`*_{}\[\]()#+.!<>]/g, '\\$&') } } });
      } catch { /* Ignore stale cursor positions until the document catches up. */ }
    }
    decorations.current.set(items);
  }

  useEffect(drawCursors, [people, tab.content, socketId]);
  useEffect(() => () => {
    clearTimeout(cursorTimer.current);
    cursorListener.current?.dispose();
    contentListener.current?.dispose();
    binding.current?.destroy();
    decorations.current?.clear();
    sendCursor(null);
  }, [tab.doc]);

  return <Editor height="560px" path={`file:///${projectId}/${tab.id}`} language={languageFor(tab.name)} theme="vs-dark" keepCurrentModel saveViewState
    loading={<p role="status">Loading Monaco Editor…</p>}
    onMount={(instance) => {
      editor.current = instance;
      binding.current = new MonacoBinding(tab.doc.getText('content'), instance.getModel()!, new Set([instance]));
      decorations.current = instance.createDecorationsCollection();
      const reportSelection = () => {
        const selection = instance.getSelection();
        onSelectionChange(selection ? instance.getModel()?.getValueInRange(selection) ?? '' : '');
      };
      contentListener.current = instance.onDidChangeModelContent(reportSelection);
      cursorListener.current = instance.onDidChangeCursorSelection(() => {
        reportSelection();
        clearTimeout(cursorTimer.current);
        cursorTimer.current = setTimeout(() => {
          const selection = instance.getSelection();
          const model = instance.getModel();
          if (!selection || !model) return;
          const text = tab.doc.getText('content');
          sendCursor({ fileId: tab.id,
            anchor: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, model.getOffsetAt(selection.getSelectionStart())))),
            head: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, model.getOffsetAt(selection.getPosition())))),
          });
        }, 80);
      });
      reportSelection();
      drawCursors();
    }}
    options={{ readOnly, domReadOnly: readOnly, automaticLayout: true, minimap: { enabled: false }, fontSize: 14, tabSize: 2, scrollBeyondLastLine: false, ariaLabel: `Code for ${tab.name}` }} />;
}
