import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Plus, Settings, Trello } from 'lucide-react';
import { useStore, getAuthToken } from '../../store';
import { Board, BoardVisibility } from '../../types';
import { KanbanBoard } from './KanbanBoard';
import { BoardSettingsPopup } from './BoardSettingsPopup';
import { animateModalIn, animateListIn } from '../../utils/uiAnimations';

export interface OrgUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'leitung' | 'betrachter';
}

export function BoardsModal({ onClose }: { onClose: () => void }) {
  const myAdminUserId = useStore(s => s.myAdminUserId);

  const [boardsList, setBoardsList] = useState<Board[]>([]);
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewBoard, setShowNewBoard] = useState(false);
  const [newName, setNewName] = useState('');
  const [newVisibility, setNewVisibility] = useState<BoardVisibility>('organization');
  const [newSelectedUsers, setNewSelectedUsers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const loadBoards = useCallback(async (): Promise<Board[]> => {
    const token = getAuthToken();
    if (!token) return [];
    try {
      const resp = await fetch('/api/boards', { headers: { Authorization: `Bearer ${token}` } });
      if (resp.ok) {
        const data: Board[] = await resp.json();
        setBoardsList(data);
        return data;
      }
    } catch {
      // ignore — sidebar just stays empty, user can retry by reopening
    }
    return [];
  }, []);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    animateModalIn(panelRef.current);
  }, []);

  useEffect(() => {
    const token = getAuthToken();
    if (!token) return;
    setLoading(true);
    Promise.all([
      loadBoards(),
      fetch('/api/admin/org/users', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.ok ? r.json() : []),
    ]).then(([bs, users]) => {
      setOrgUsers(users);
      if (bs.length > 0 && !selectedBoardId) setSelectedBoardId(bs[0].id);
      setLoading(false);
      if (bs.length > 0) {
        requestAnimationFrame(() => {
          if (sidebarRef.current) animateListIn(sidebarRef.current.querySelectorAll('.board-list-item'));
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedBoard = boardsList.find(b => b.id === selectedBoardId) || null;

  const refreshSelectedBoard = useCallback(async () => {
    const token = getAuthToken();
    if (!token || !selectedBoardId) return;
    const resp = await fetch(`/api/boards/${selectedBoardId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.ok) {
      const updated: Board = await resp.json();
      setBoardsList(prev => prev.map(b => b.id === updated.id ? updated : b));
    }
  }, [selectedBoardId]);

  // Light polling while the modal is open, so a collaborator's changes show up.
  useEffect(() => {
    if (!selectedBoardId) return;
    const timer = setInterval(refreshSelectedBoard, 6000);
    return () => clearInterval(timer);
  }, [selectedBoardId, refreshSelectedBoard]);

  const createBoard = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const token = getAuthToken();
      const resp = await fetch('/api/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: newName.trim(),
          visibility: newVisibility,
          visibleToUserIds: newVisibility === 'selected' ? newSelectedUsers : undefined,
        }),
      });
      if (resp.ok) {
        const board: Board = await resp.json();
        setBoardsList(prev => [...prev, board]);
        setSelectedBoardId(board.id);
        setShowNewBoard(false);
        setNewName('');
        setNewVisibility('organization');
        setNewSelectedUsers([]);
      }
    } finally {
      setCreating(false);
    }
  };

  const onBoardUpdated = (updated: Board) => {
    setBoardsList(prev => prev.map(b => b.id === updated.id ? updated : b));
  };

  const onBoardDeleted = (id: string) => {
    setBoardsList(prev => prev.filter(b => b.id !== id));
    setSelectedBoardId(prev => (prev === id ? (boardsList.find(b => b.id !== id)?.id ?? null) : prev));
    setShowSettings(false);
  };

  const visibilityLabel = (b: Board) => b.visibility === 'private' ? 'Privat' : b.visibility === 'organization' ? 'Organisation' : 'Ausgewählte Personen';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div ref={panelRef} className="w-full max-w-6xl h-[88vh] bg-white rounded-lg shadow-lg overflow-hidden flex flex-col" style={{ opacity: 0 }}>
        <div className="flex items-center justify-between p-4 border-b flex-shrink-0">
          <h3 className="text-lg font-semibold flex items-center gap-2"><Trello size={20} className="text-primary-600" /> Boards</h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded"><X /></button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar */}
          <div ref={sidebarRef} className="w-64 flex-shrink-0 border-r bg-gray-50 overflow-y-auto p-3 space-y-1">
            {loading ? (
              <p className="text-sm text-gray-400 px-2">Lädt…</p>
            ) : boardsList.length === 0 ? (
              <p className="text-sm text-gray-400 px-2">Noch keine Boards.</p>
            ) : (
              boardsList.map(b => (
                <button
                  key={b.id}
                  onClick={() => setSelectedBoardId(b.id)}
                  className={`board-list-item w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${selectedBoardId === b.id ? 'bg-primary-100 text-primary-800 font-medium' : 'hover:bg-gray-100 text-gray-700'}`}
                >
                  <div className="truncate">{b.name}</div>
                  <div className="text-[11px] text-gray-400">{visibilityLabel(b)}</div>
                </button>
              ))
            )}

            {showNewBoard ? (
              <div className="mt-3 p-3 bg-white border rounded-md space-y-2">
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Board-Name"
                  className="w-full px-2 py-1.5 border rounded text-sm"
                  onKeyDown={e => { if (e.key === 'Enter') createBoard(); }}
                />
                <select
                  value={newVisibility}
                  onChange={e => setNewVisibility(e.target.value as BoardVisibility)}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                >
                  <option value="private">Privat</option>
                  <option value="organization">Gesamte Organisation</option>
                  <option value="selected">Ausgewählte Personen</option>
                </select>
                {newVisibility === 'selected' && (
                  <div className="max-h-28 overflow-y-auto border rounded p-1.5 space-y-1">
                    {orgUsers.filter(u => u.id !== myAdminUserId).map(u => (
                      <label key={u.id} className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={newSelectedUsers.includes(u.id)}
                          onChange={e => setNewSelectedUsers(prev => e.target.checked ? [...prev, u.id] : prev.filter(id => id !== u.id))}
                        />
                        {u.name}
                      </label>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={createBoard} disabled={creating || !newName.trim()} className="flex-1 px-2 py-1.5 bg-primary-600 text-white rounded text-xs font-medium disabled:bg-gray-300">
                    {creating ? 'Wird erstellt…' : 'Erstellen'}
                  </button>
                  <button onClick={() => setShowNewBoard(false)} className="px-2 py-1.5 border rounded text-xs">Abbrechen</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowNewBoard(true)}
                className="w-full mt-2 flex items-center gap-1.5 px-3 py-2 text-sm text-primary-600 hover:bg-primary-50 rounded-md"
              >
                <Plus size={15} /> Neues Board
              </button>
            )}
          </div>

          {/* Main area */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {!selectedBoard ? (
              <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                {loading ? '' : 'Wähle ein Board aus oder erstelle ein neues.'}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between px-4 py-2.5 border-b flex-shrink-0">
                  <div>
                    <h4 className="font-semibold text-gray-800">{selectedBoard.name}</h4>
                    <p className="text-xs text-gray-400">{visibilityLabel(selectedBoard)} · Erstellt von {selectedBoard.ownerName}</p>
                  </div>
                  <button onClick={() => setShowSettings(true)} className="p-2 text-gray-500 hover:bg-gray-100 rounded-md" title="Board-Einstellungen">
                    <Settings size={16} />
                  </button>
                </div>
                <div className="flex-1 overflow-x-auto overflow-y-hidden">
                  <KanbanBoard board={selectedBoard} orgUsers={orgUsers} onBoardChanged={onBoardUpdated} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {showSettings && selectedBoard && (
        <BoardSettingsPopup
          board={selectedBoard}
          orgUsers={orgUsers}
          myAdminUserId={myAdminUserId}
          onClose={() => setShowSettings(false)}
          onUpdated={onBoardUpdated}
          onDeleted={onBoardDeleted}
        />
      )}
    </div>
  );
}
