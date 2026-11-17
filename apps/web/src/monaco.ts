import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import 'monaco-editor/editor/browser/coreCommands';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution';
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/cpp/register';

// Bundle Monaco and its worker locally instead of loading editor code from a CDN.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
export { monaco };

export function languageFor(name: string) {
  const extension = name.split('.').pop()?.toLowerCase();
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension ?? '')) return 'javascript';
  if (['ts', 'tsx'].includes(extension ?? '')) return 'typescript';
  if (extension === 'py') return 'python';
  if (['cpp', 'cc', 'cxx', 'h', 'hpp', 'c'].includes(extension ?? '')) return 'cpp';
  return 'plaintext';
}
