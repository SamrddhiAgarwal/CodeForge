import { useState } from 'react';
import type { FileNode } from './api';

interface Props {
  files: FileNode[];
  selectedId: string | null;
  disabled: boolean;
  onSelect: (file: FileNode | null) => void;
}

export function FileExplorer({ files, selectedId, disabled, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  function branch(parentId: string | null, path = '') {
    return files.filter((file) => file.parentId === parentId)
      .sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1)
      .map((file) => <li key={file.id}>
        <div className={`explorer-row ${selectedId === file.id ? 'active' : ''}`}>
          {file.kind === 'folder' && <button className="folder-toggle" aria-label={`Toggle folder ${path}${file.name}`} aria-expanded={!collapsed.includes(file.id)} onClick={() => setCollapsed((ids) => ids.includes(file.id) ? ids.filter((id) => id !== file.id) : [...ids, file.id])}>{collapsed.includes(file.id) ? '▸' : '▾'}</button>}
          <button className="file-entry" disabled={disabled} aria-pressed={selectedId === file.id} aria-label={`${file.kind === 'folder' ? 'Select folder' : 'Open file'} ${path}${file.name}`} onClick={() => onSelect(file)}><span aria-hidden="true">{file.kind === 'folder' ? '▱' : '◇'}</span> {file.name}</button>
        </div>
        {file.kind === 'folder' && !collapsed.includes(file.id) && <ul>{branch(file.id, `${path}${file.name}/`)}</ul>}
      </li>);
  }
  return <nav aria-label="Project files"><button className={`explorer-root ${selectedId === null ? 'active' : ''}`} disabled={disabled} onClick={() => onSelect(null)}>Project root</button>{files.length ? <ul className="file-tree">{branch(null)}</ul> : <p className="explorer-empty">No files yet. Create a file or folder to get started.</p>}</nav>;
}
