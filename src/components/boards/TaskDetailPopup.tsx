import { useState, useEffect, useRef } from 'react';
import { X, Trash2, Plus, Paperclip, Send, FileText, CheckSquare, Square } from 'lucide-react';
import { useStore, getAuthToken } from '../../store';
import { Board, BoardTask, BoardComment } from '../../types';
import type { OrgUser } from './BoardsModal';
import { animateModalIn, animatePop } from './animations';

interface Props {
  board: Board;
  task: BoardTask;
  orgUsers: OrgUser[];
  onClose: () => void;
  onChanged: () => void;
}

function assignablePeople(board: Board, orgUsers: OrgUser[]): OrgUser[] {
  if (board.visibility === 'organization') return orgUsers;
  if (board.visibility === 'selected') {
    const allowed = new Set([board.ownerId, ...(board.visibleToUserIds || [])]);
    return orgUsers.filter(u => allowed.has(u.id));
  }
  return orgUsers.filter(u => u.id === board.ownerId);
}

function AttachmentPreview({ attachmentId }: { attachmentId: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string>('');
  const [error, setError] = useState(false);

  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    (async () => {
      try {
        const token = getAuthToken();
        const resp = await fetch(`/api/boards/attachments/${attachmentId}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) { setError(true); return; }
        const blob = await resp.blob();
        url = URL.createObjectURL(blob);
        if (!revoked) { setBlobUrl(url); setMimeType(blob.type); }
      } catch {
        setError(true);
      }
    })();
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
  }, [attachmentId]);

  if (error) return <span className="text-xs text-rose-500">Datei nicht verfügbar</span>;
  if (!blobUrl) return <span className="text-xs text-gray-400">Lädt…</span>;

  if (mimeType.startsWith('image/')) {
    return (
      <a href={blobUrl} target="_blank" rel="noreferrer">
        <img src={blobUrl} alt="Anhang" className="max-h-32 rounded border" />
      </a>
    );
  }
  return (
    <a href={blobUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-primary-700 bg-primary-50 border border-primary-200 rounded px-2 py-1.5 hover:bg-primary-100">
      <FileText size={13} /> PDF öffnen
    </a>
  );
}

export function TaskDetailPopup({ board, task, orgUsers, onClose, onChanged }: Props) {
  const myAdminUserId = useStore(s => s.myAdminUserId);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const [deadline, setDeadline] = useState(task.deadline || '');
  const [assigneeIds, setAssigneeIds] = useState<string[]>(task.assigneeIds);
  const [newSubtask, setNewSubtask] = useState('');
  const [commentText, setCommentText] = useState('');
  const [commentFiles, setCommentFiles] = useState<File[]>([]);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const doneButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleFocused = useRef(false);
  const descriptionFocused = useRef(false);

  useEffect(() => {
    animateModalIn(panelRef.current);
  }, []);

  // Keep local edit state in sync if the task is refreshed from a poll (or from any other
  // action's refetch) while open — but never while the user is actively typing into a field.
  // `onChanged()` re-fetches the whole board after every action (adding a subtask, toggling a
  // different task, posting a comment, ...) and the board also polls every 6s while this popup
  // is open, so `task` here updates far more often than the user actually edits anything; title
  // and description are only persisted on blur, so blindly resetting them on every such refresh
  // would wipe out whatever the user has typed since their last blur.
  const assigneeIdsKey = task.assigneeIds.join(',');
  useEffect(() => {
    if (!titleFocused.current) setTitle(task.title);
    if (!descriptionFocused.current) setDescription(task.description || '');
    setDeadline(task.deadline || '');
    setAssigneeIds(task.assigneeIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.title, task.description, task.deadline, assigneeIdsKey]);

  const people = assignablePeople(board, orgUsers);

  const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` });
  const patchTask = async (body: Record<string, any>) => {
    await fetch(`/api/boards/${board.id}/tasks/${task.id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) });
    onChanged();
  };

  const toggleDone = () => { animatePop(doneButtonRef.current); patchTask({ done: !task.done }); };
  const saveTitle = () => { if (title.trim() && title !== task.title) patchTask({ title }); };
  const saveDescription = () => { if (description !== (task.description || '')) patchTask({ description }); };
  const saveDeadline = (value: string) => { setDeadline(value); patchTask({ deadline: value || null }); };
  const toggleAssignee = (id: string) => {
    const next = assigneeIds.includes(id) ? assigneeIds.filter(a => a !== id) : [...assigneeIds, id];
    setAssigneeIds(next);
    patchTask({ assigneeIds: next });
  };

  const deleteTask = async () => {
    if (!confirm('Aufgabe wirklich löschen?')) return;
    await fetch(`/api/boards/${board.id}/tasks/${task.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${getAuthToken()}` } });
    onChanged();
    onClose();
  };

  const addSubtask = async () => {
    if (!newSubtask.trim()) return;
    await fetch(`/api/boards/${board.id}/tasks/${task.id}/subtasks`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ title: newSubtask.trim() }) });
    setNewSubtask('');
    onChanged();
  };

  const toggleSubtask = async (subtaskId: string, done: boolean) => {
    await fetch(`/api/boards/${board.id}/tasks/${task.id}/subtasks/${subtaskId}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ done }) });
    onChanged();
  };

  const deleteSubtask = async (subtaskId: string) => {
    await fetch(`/api/boards/${board.id}/tasks/${task.id}/subtasks/${subtaskId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${getAuthToken()}` } });
    onChanged();
  };

  const onFilesPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setCommentFiles(prev => [...prev, ...files].slice(0, 5));
    e.target.value = '';
  };

  const postComment = async () => {
    if (!commentText.trim() && commentFiles.length === 0) return;
    setPosting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('text', commentText);
      commentFiles.forEach(f => form.append('files', f));
      const resp = await fetch(`/api/boards/${board.id}/tasks/${task.id}/comments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        body: form,
      });
      const data = await resp.json();
      if (!resp.ok) { setError(data.error || 'Fehler beim Senden.'); return; }
      setCommentText('');
      setCommentFiles([]);
      onChanged();
    } catch {
      setError('Verbindungsfehler.');
    } finally {
      setPosting(false);
    }
  };

  const deleteComment = async (commentId: string) => {
    await fetch(`/api/boards/${board.id}/tasks/${task.id}/comments/${commentId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${getAuthToken()}` } });
    onChanged();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div ref={panelRef} className="w-full max-w-2xl bg-white rounded-lg shadow-lg overflow-hidden max-h-[90vh] flex flex-col" style={{ opacity: 0 }}>
        <div className="flex items-center justify-between p-4 border-b flex-shrink-0">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <button ref={doneButtonRef} onClick={toggleDone} className="flex-shrink-0 text-primary-600">
              {task.done ? <CheckSquare size={20} /> : <Square size={20} className="text-gray-300" />}
            </button>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              onFocus={() => { titleFocused.current = true; }}
              onBlur={() => { titleFocused.current = false; saveTitle(); }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              className={`flex-1 min-w-0 font-semibold text-lg px-1 py-0.5 border border-transparent hover:border-gray-200 focus:border-primary-400 rounded outline-none ${task.done ? 'line-through text-gray-400' : ''}`}
            />
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded flex-shrink-0"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Deadline</label>
              <input type="date" value={deadline} onChange={e => saveDeadline(e.target.value)} className="w-full px-2 py-1.5 border rounded text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Zugewiesen</label>
              <div className="flex flex-wrap gap-1.5">
                {people.map(u => (
                  <button
                    key={u.id}
                    onClick={() => toggleAssignee(u.id)}
                    className={`text-xs px-2 py-1 rounded-full border ${assigneeIds.includes(u.id) ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}
                  >
                    {u.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Beschreibung</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              onFocus={() => { descriptionFocused.current = true; }}
              onBlur={() => { descriptionFocused.current = false; saveDescription(); }}
              rows={3}
              placeholder="Beschreibung hinzufügen…"
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Unteraufgaben {task.subtasks.length > 0 && `(${task.subtasks.filter(s => s.done).length}/${task.subtasks.length})`}
            </label>
            <div className="space-y-1">
              {task.subtasks.map(s => (
                <div key={s.id} className="flex items-center gap-2 group">
                  <button onClick={() => toggleSubtask(s.id, !s.done)} className="text-primary-600 flex-shrink-0">
                    {s.done ? <CheckSquare size={15} /> : <Square size={15} className="text-gray-300" />}
                  </button>
                  <span className={`text-sm flex-1 ${s.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>{s.title}</span>
                  <button onClick={() => deleteSubtask(s.id)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-rose-600">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-1.5 mt-1.5">
              <input
                value={newSubtask}
                onChange={e => setNewSubtask(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addSubtask(); }}
                placeholder="Unteraufgabe hinzufügen"
                className="flex-1 px-2 py-1 border rounded text-sm"
              />
              <button onClick={addSubtask} className="px-2 py-1 border rounded text-sm hover:bg-gray-50"><Plus size={14} /></button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-2">Kommentare</label>
            <div className="space-y-3">
              {task.comments.map(c => (
                <CommentRow key={c.id} comment={c} canDelete={c.authorId === myAdminUserId} onDelete={() => deleteComment(c.id)} />
              ))}
            </div>

            {error && <div className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded p-2">{error}</div>}

            <div className="mt-3 border rounded-md p-2 space-y-2">
              <textarea
                value={commentText}
                onChange={e => setCommentText(e.target.value)}
                placeholder="Kommentar schreiben…"
                rows={2}
                className="w-full px-2 py-1.5 border rounded text-sm"
              />
              {commentFiles.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {commentFiles.map((f, i) => (
                    <span key={i} className="text-xs bg-gray-100 px-2 py-1 rounded flex items-center gap-1">
                      {f.name}
                      <button onClick={() => setCommentFiles(prev => prev.filter((_, idx) => idx !== i))} className="text-gray-400 hover:text-rose-600">×</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between">
                <button onClick={() => fileInputRef.current?.click()} className="p-1.5 text-gray-500 hover:bg-gray-100 rounded" title="Datei anhängen">
                  <Paperclip size={15} />
                </button>
                <input ref={fileInputRef} type="file" accept="image/*,application/pdf" multiple onChange={onFilesPicked} className="hidden" />
                <button
                  onClick={postComment}
                  disabled={posting || (!commentText.trim() && commentFiles.length === 0)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 text-white rounded text-sm font-medium disabled:bg-gray-300"
                >
                  <Send size={13} /> {posting ? 'Senden…' : 'Senden'}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="p-4 border-t flex justify-between flex-shrink-0">
          <button onClick={deleteTask} className="px-3 py-1.5 border border-rose-200 text-rose-600 rounded text-sm hover:bg-rose-50 flex items-center gap-1.5">
            <Trash2 size={14} /> Aufgabe löschen
          </button>
          <button onClick={onClose} className="px-4 py-2 border rounded">Schließen</button>
        </div>
      </div>
    </div>
  );
}

function CommentRow({ comment, canDelete, onDelete }: { comment: BoardComment; canDelete: boolean; onDelete: () => void }) {
  return (
    <div className="flex gap-2">
      <div className="w-7 h-7 rounded-full bg-gray-200 text-gray-600 text-xs font-semibold flex items-center justify-center flex-shrink-0">
        {comment.authorName.slice(0, 1).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-800">{comment.authorName}</span>
          <span className="text-[11px] text-gray-400">{new Date(comment.createdAt).toLocaleString('de-DE')}</span>
          {canDelete && (
            <button onClick={onDelete} className="text-gray-300 hover:text-rose-600 ml-auto"><Trash2 size={12} /></button>
          )}
        </div>
        {comment.text && <p className="text-sm text-gray-700 mt-0.5 whitespace-pre-wrap">{comment.text}</p>}
        {comment.attachmentIds.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1.5">
            {comment.attachmentIds.map(id => <AttachmentPreview key={id} attachmentId={id} />)}
          </div>
        )}
      </div>
    </div>
  );
}
