import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Plus, Trash2, Pencil, ChevronLeft, ChevronRight } from 'lucide-react';
import { useStore, getAuthToken } from '../store';
import { animateModalIn, animateNudge, animatePop } from '../utils/uiAnimations';

interface OrgUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'leitung' | 'betrachter';
}

interface VacationEntry {
  id: string;
  organizationId: string;
  adminUserId: string;
  startDate: string;
  endDate: string;
  substituteAdminUserId?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

const PALETTE = [
  { bg: 'bg-indigo-100', text: 'text-indigo-700', dot: 'bg-indigo-500' },
  { bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
  { bg: 'bg-rose-100', text: 'text-rose-700', dot: 'bg-rose-500' },
  { bg: 'bg-sky-100', text: 'text-sky-700', dot: 'bg-sky-500' },
  { bg: 'bg-violet-100', text: 'text-violet-700', dot: 'bg-violet-500' },
  { bg: 'bg-teal-100', text: 'text-teal-700', dot: 'bg-teal-500' },
  { bg: 'bg-orange-100', text: 'text-orange-700', dot: 'bg-orange-500' },
];

/** Stable per-account color, independent of list order. */
function colorFor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Full weeks (Mon–Sun) covering the given month; leading/trailing padding cells are null. */
function buildMonthGrid(year: number, month: number): (Date | null)[] {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // 0 = Monday
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function formatRange(start: string, end: string): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  };
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
}

export function AdminVacationCalendar({ onClose }: { onClose: () => void }) {
  const myAdminUserId = useStore(s => s.myAdminUserId);
  const myName = useStore(s => s.myName);

  const today = useMemo(() => new Date(), []);
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const [users, setUsers] = useState<OrgUser[]>([]);
  const [entries, setEntries] = useState<VacationEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formStart, setFormStart] = useState('');
  const [formEnd, setFormEnd] = useState('');
  const [formSubstitute, setFormSubstitute] = useState('');
  const [formNote, setFormNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const prevMonthRef = useRef<HTMLButtonElement | null>(null);
  const nextMonthRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    animateModalIn(panelRef.current);
  }, []);

  const load = async () => {
    const token = getAuthToken();
    if (!token) return;
    setLoading(true);
    try {
      const [uRes, vRes] = await Promise.all([
        fetch('/api/admin/org/users', { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/api/admin/vacations', { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (uRes.ok) setUsers(await uRes.json());
      if (vRes.ok) setEntries(await vRes.json());
    } catch {
      // ignore — panels just stay empty, user can retry by reopening
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const userById = useMemo(() => {
    const map = new Map<string, OrgUser>();
    users.forEach(u => map.set(u.id, u));
    return map;
  }, [users]);

  const entriesForDay = (iso: string) => entries.filter(e => e.startDate <= iso && iso <= e.endDate);

  const myEntries = useMemo(
    () => entries.filter(e => e.adminUserId === myAdminUserId).sort((a, b) => a.startDate.localeCompare(b.startDate)),
    [entries, myAdminUserId],
  );
  const sortedEntries = useMemo(() => [...entries].sort((a, b) => a.startDate.localeCompare(b.startDate)), [entries]);

  const resetForm = () => {
    setEditingId(null);
    setFormStart('');
    setFormEnd('');
    setFormSubstitute('');
    setFormNote('');
    setFormError(null);
  };

  const startEdit = (entry: VacationEntry) => {
    setEditingId(entry.id);
    setFormStart(entry.startDate);
    setFormEnd(entry.endDate);
    setFormSubstitute(entry.substituteAdminUserId || '');
    setFormNote(entry.note || '');
    setFormError(null);
  };

  const submitForm = async () => {
    if (!formStart || !formEnd) { setFormError('Bitte Start- und Enddatum angeben.'); return; }
    if (formStart > formEnd) { setFormError('Das Enddatum muss nach dem Startdatum liegen.'); return; }
    setSaving(true);
    setFormError(null);
    try {
      const token = getAuthToken();
      const url = editingId ? `/api/admin/vacations/${editingId}` : '/api/admin/vacations';
      const method = editingId ? 'PUT' : 'POST';
      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          startDate: formStart,
          endDate: formEnd,
          substituteAdminUserId: formSubstitute || undefined,
          note: formNote || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) { setFormError(data.error || 'Fehler beim Speichern.'); return; }
      resetForm();
      await load();
    } catch {
      setFormError('Verbindungsfehler.');
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = async (id: string) => {
    if (!confirm('Diesen Eintrag wirklich löschen?')) return;
    const token = getAuthToken();
    await fetch(`/api/admin/vacations/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (editingId === id) resetForm();
    await load();
  };

  const goPrevMonth = () => {
    animateNudge(prevMonthRef.current, 'left');
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1);
  };
  const goNextMonth = () => {
    animateNudge(nextMonthRef.current, 'right');
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else setViewMonth(m => m + 1);
  };
  const goToday = () => { setViewYear(today.getFullYear()); setViewMonth(today.getMonth()); };

  const grid = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);
  const todayIso = toISODate(today);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div ref={panelRef} className="w-full max-w-5xl bg-white rounded-lg shadow-lg overflow-hidden max-h-[90vh] flex flex-col" style={{ opacity: 0 }}>
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold">Urlaubskalender</h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded"><X /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Calendar grid */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <button ref={prevMonthRef} onClick={goPrevMonth} className="p-1.5 border rounded hover:bg-gray-50"><ChevronLeft size={16} /></button>
                <span className="font-medium text-gray-800 w-40 text-center">{MONTH_NAMES[viewMonth]} {viewYear}</span>
                <button ref={nextMonthRef} onClick={goNextMonth} className="p-1.5 border rounded hover:bg-gray-50"><ChevronRight size={16} /></button>
              </div>
              <button onClick={goToday} className="text-xs px-2 py-1 border rounded hover:bg-gray-50">Heute</button>
            </div>

            <div className="grid grid-cols-7 gap-1 text-xs font-medium text-gray-500 mb-1">
              {WEEKDAYS.map(d => <div key={d} className="text-center py-1">{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {grid.map((date, i) => {
                if (!date) return <div key={i} className="min-h-[76px] bg-gray-50 rounded" />;
                const iso = toISODate(date);
                const dayEntries = entriesForDay(iso);
                const isToday = iso === todayIso;
                return (
                  <div key={i} className={`min-h-[76px] border rounded p-1 ${isToday ? 'border-primary-400 bg-primary-50/40' : 'border-gray-100'}`}>
                    <div className={`text-xs mb-1 ${isToday ? 'font-bold text-primary-700' : 'text-gray-500'}`}>{date.getDate()}</div>
                    <div className="space-y-0.5">
                      {dayEntries.slice(0, 3).map(e => {
                        const u = userById.get(e.adminUserId);
                        const sub = e.substituteAdminUserId ? userById.get(e.substituteAdminUserId) : null;
                        const color = colorFor(e.adminUserId);
                        const title = `${u?.name || '?'}${sub ? ` — Vertretung: ${sub.name}` : ''}${e.note ? ` (${e.note})` : ''}`;
                        return (
                          <div key={e.id} title={title} className={`truncate rounded px-1 py-0.5 text-[10px] font-medium ${color.bg} ${color.text}`}>
                            {u?.name || '?'}
                          </div>
                        );
                      })}
                      {dayEntries.length > 3 && (
                        <div className="text-[10px] text-gray-400 px-1">+{dayEntries.length - 3} weitere</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Own entry: add/edit form + list */}
          <div className="space-y-4">
            <div className="bg-white border rounded-lg p-4">
              <h4 className="font-medium text-gray-900 mb-1">{editingId ? 'Eintrag bearbeiten' : 'Urlaub eintragen'}</h4>
              <p className="text-xs text-gray-500 mb-3">{myName ? `Für ${myName}. ` : ''}Nur der eigene Eintrag kann bearbeitet werden.</p>
              {formError && <div className="mb-2 text-xs text-rose-700 bg-rose-50 border border-rose-100 p-2 rounded">{formError}</div>}
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Von</label>
                    <input type="date" value={formStart} onChange={e => setFormStart(e.target.value)} className="w-full px-2 py-1.5 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Bis</label>
                    <input type="date" value={formEnd} onChange={e => setFormEnd(e.target.value)} className="w-full px-2 py-1.5 border rounded text-sm" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Vertretung</label>
                  <select value={formSubstitute} onChange={e => setFormSubstitute(e.target.value)} className="w-full px-2 py-1.5 border rounded text-sm">
                    <option value="">— keine —</option>
                    {users.filter(u => u.id !== myAdminUserId).map(u => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Notiz (optional)</label>
                  <input type="text" value={formNote} onChange={e => setFormNote(e.target.value)} placeholder="z. B. Grund, Erreichbarkeit" className="w-full px-2 py-1.5 border rounded text-sm" />
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={submitForm}
                    disabled={saving || !formStart || !formEnd}
                    className="flex-1 px-3 py-1.5 bg-primary-600 text-white rounded text-sm font-medium hover:bg-primary-700 disabled:bg-gray-300"
                  >
                    {saving ? 'Wird gespeichert…' : editingId ? 'Speichern' : (
                      <span className="flex items-center justify-center gap-1"><Plus size={14} /> Eintragen</span>
                    )}
                  </button>
                  {editingId && (
                    <button onClick={resetForm} className="px-3 py-1.5 border rounded text-sm hover:bg-gray-50">Abbrechen</button>
                  )}
                </div>
              </div>
            </div>

            {myEntries.length > 0 && (
              <div className="bg-white border rounded-lg overflow-hidden">
                <div className="p-3 border-b bg-gray-50">
                  <h4 className="font-medium text-gray-900 text-sm">Meine Einträge</h4>
                </div>
                <div className="divide-y max-h-40 overflow-y-auto">
                  {myEntries.map(e => (
                    <div key={e.id} className="p-2.5 flex items-center justify-between gap-2 text-sm">
                      <div>
                        <div className="text-gray-800">{formatRange(e.startDate, e.endDate)}</div>
                        {e.substituteAdminUserId && (
                          <div className="text-xs text-gray-500">Vertretung: {userById.get(e.substituteAdminUserId)?.name || '—'}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button onClick={ev => { animatePop(ev.currentTarget); startEdit(e); }} className="p-1 text-gray-500 hover:bg-gray-100 rounded"><Pencil size={13} /></button>
                        <button onClick={ev => { animatePop(ev.currentTarget); removeEntry(e.id); }} className="p-1 text-rose-600 hover:bg-rose-50 rounded"><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Everyone's entries, read-only */}
        <div className="border-t p-4">
          <h4 className="font-medium text-gray-900 mb-2 text-sm">Urlaub im Team</h4>
          {loading ? (
            <p className="text-sm text-gray-400">Lädt…</p>
          ) : sortedEntries.length === 0 ? (
            <p className="text-sm text-gray-400">Noch keine Einträge.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto border rounded">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-3 py-1.5 text-left">Person</th>
                    <th className="px-3 py-1.5 text-left">Zeitraum</th>
                    <th className="px-3 py-1.5 text-left">Vertretung</th>
                    <th className="px-3 py-1.5 text-left">Notiz</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedEntries.map(e => {
                    const u = userById.get(e.adminUserId);
                    const sub = e.substituteAdminUserId ? userById.get(e.substituteAdminUserId) : null;
                    const color = colorFor(e.adminUserId);
                    return (
                      <tr key={e.id} className="border-t">
                        <td className="px-3 py-1.5"><span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${color.dot}`} />{u?.name || '?'}</td>
                        <td className="px-3 py-1.5">{formatRange(e.startDate, e.endDate)}</td>
                        <td className="px-3 py-1.5">{sub?.name || '—'}</td>
                        <td className="px-3 py-1.5 text-gray-500">{e.note || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="p-4 border-t flex justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded">Schließen</button>
        </div>
      </div>
    </div>
  );
}
