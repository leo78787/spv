import { useState, useEffect, useRef } from 'react';
import { X, Trash2 } from 'lucide-react';
import { getAuthToken } from '../../store';
import { Board, BoardVisibility } from '../../types';
import type { OrgUser } from './BoardsModal';
import { animateModalIn } from './animations';

interface Props {
  board: Board;
  orgUsers: OrgUser[];
  myAdminUserId: string | null;
  onClose: () => void;
  onUpdated: (board: Board) => void;
  onDeleted: (id: string) => void;
}

export function BoardSettingsPopup({ board, orgUsers, myAdminUserId, onClose, onUpdated, onDeleted }: Props) {
  const isOwner = board.ownerId === myAdminUserId;
  const [name, setName] = useState(board.name);
  const [visibility, setVisibility] = useState<BoardVisibility>(board.visibility);
  const [selectedUsers, setSelectedUsers] = useState<string[]>(board.visibleToUserIds || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    animateModalIn(panelRef.current);
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const token = getAuthToken();
      const resp = await fetch(`/api/boards/${board.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, visibility, visibleToUserIds: visibility === 'selected' ? selectedUsers : undefined }),
      });
      const data = await resp.json();
      if (!resp.ok) { setError(data.error || 'Fehler beim Speichern.'); return; }
      onUpdated(data);
      onClose();
    } catch {
      setError('Verbindungsfehler.');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    const token = getAuthToken();
    const resp = await fetch(`/api/boards/${board.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (resp.ok) onDeleted(board.id);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div ref={panelRef} className="w-full max-w-md bg-white rounded-lg shadow-lg overflow-hidden" style={{ opacity: 0 }}>
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold">Board-Einstellungen</h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded"><X size={18} /></button>
        </div>

        <div className="p-4 space-y-4">
          {!isOwner && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded p-2">
              Nur {board.ownerName} (Ersteller:in) kann diese Einstellungen ändern.
            </div>
          )}
          {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded p-2">{error}</div>}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text" value={name} onChange={e => setName(e.target.value)} disabled={!isOwner}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-100"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Sichtbarkeit</label>
            <div className="space-y-1.5">
              {([
                { value: 'private', label: 'Privat', hint: 'Nur ich kann dieses Board sehen.' },
                { value: 'organization', label: 'Gesamte Organisation', hint: 'Alle Personen mit Zugang zum Admin-Dashboard.' },
                { value: 'selected', label: 'Ausgewählte Personen', hint: 'Nur die unten ausgewählten Personen.' },
              ] as { value: BoardVisibility; label: string; hint: string }[]).map(opt => (
                <label key={opt.value} className={`flex items-start gap-2 p-2 border rounded-md ${isOwner ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'} ${visibility === opt.value ? 'border-primary-400 bg-primary-50' : 'border-gray-200'}`}>
                  <input type="radio" checked={visibility === opt.value} onChange={() => isOwner && setVisibility(opt.value)} disabled={!isOwner} className="mt-0.5" />
                  <span>
                    <span className="text-sm font-medium text-gray-800 block">{opt.label}</span>
                    <span className="text-xs text-gray-500">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {visibility === 'selected' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Personen</label>
              <div className="max-h-40 overflow-y-auto border rounded-md p-2 space-y-1">
                {orgUsers.filter(u => u.id !== board.ownerId).map(u => (
                  <label key={u.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedUsers.includes(u.id)}
                      disabled={!isOwner}
                      onChange={e => setSelectedUsers(prev => e.target.checked ? [...prev, u.id] : prev.filter(id => id !== u.id))}
                    />
                    {u.name} <span className="text-xs text-gray-400">({u.email})</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t flex items-center justify-between">
          <div>
            {isOwner && (
              confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-rose-600">Wirklich löschen?</span>
                  <button onClick={doDelete} className="px-2.5 py-1.5 bg-rose-600 text-white rounded text-xs">Ja, löschen</button>
                  <button onClick={() => setConfirmDelete(false)} className="px-2.5 py-1.5 border rounded text-xs">Abbrechen</button>
                </div>
              ) : (
                <button onClick={() => setConfirmDelete(true)} className="px-3 py-1.5 border border-rose-200 text-rose-600 rounded text-sm hover:bg-rose-50 flex items-center gap-1.5">
                  <Trash2 size={14} /> Board löschen
                </button>
              )
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 border rounded">Schließen</button>
            {isOwner && (
              <button onClick={save} disabled={saving || !name.trim()} className="px-4 py-2 bg-primary-600 text-white rounded font-medium hover:bg-primary-700 disabled:bg-gray-300">
                {saving ? 'Speichern…' : 'Speichern'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
