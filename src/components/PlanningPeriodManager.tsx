import { useState } from 'react';
import { useStore } from '../store';
import { PlanningPeriod, periodsOverlap, getPeriodDateRange } from '../types';
import { getMonthName } from '../utils/helpers';
import { Plus, Edit2, Trash2, Lock, Unlock, CheckCircle2, AlertTriangle, Circle } from 'lucide-react';

/** Human-readable label for a period: its custom name, or a date-range description. */
export function periodLabel(period: Pick<PlanningPeriod, 'name' | 'year' | 'startMonth' | 'months'>): string {
  if (period.name) return period.name;
  const { start, end } = getPeriodDateRange(period);
  return `${getMonthName(start.getMonth())} ${start.getFullYear()} – ${getMonthName(end.getMonth())} ${end.getFullYear()}`;
}

const YEAR_RANGE = (() => {
  const current = new Date().getFullYear();
  const years: number[] = [];
  for (let y = current - 2; y <= current + 6; y++) years.push(y);
  return years;
})();

interface PeriodFormState {
  id?: string;
  name: string;
  startYear: number;
  startMonth: number;
  endYear: number;
  endMonth: number;
}

function emptyForm(): PeriodFormState {
  const now = new Date();
  return {
    name: '',
    startYear: now.getFullYear(),
    startMonth: now.getMonth(),
    endYear: now.getFullYear(),
    endMonth: 11,
  };
}

function formToMonths(form: PeriodFormState): number {
  const startAbs = form.startYear * 12 + form.startMonth;
  const endAbs = form.endYear * 12 + form.endMonth;
  return Math.max(1, endAbs - startAbs + 1);
}

interface Props {
  selectedPeriodId: string | null;
  onSelect: (id: string) => void;
}

export function PlanningPeriodManager({ selectedPeriodId, onSelect }: Props) {
  const {
    planningPeriods,
    createPlanningPeriod,
    updatePlanningPeriod,
    deletePlanningPeriod,
    setPeriodReleased,
    setPeriodLocked,
  } = useStore();

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<PeriodFormState>(emptyForm());
  const [overlapWarning, setOverlapWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Password-protected confirmation for destructive/administrative actions
  // (Löschen, Freigeben/Zurückziehen, Sperren/Entsperren) — matches the
  // "2026" password convention used elsewhere in the admin UI.
  const [pwConfirm, setPwConfirm] = useState<{ title: string; message: string; run: () => void | Promise<void> } | null>(null);
  const [pwValue, setPwValue] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const ADMIN_PASSWORD = '2026';

  const requirePassword = (title: string, message: string, run: () => void | Promise<void>) => {
    setPwValue('');
    setPwConfirm({ title, message, run });
  };

  const runPwConfirm = async () => {
    if (!pwConfirm || pwValue !== ADMIN_PASSWORD) return;
    setPwBusy(true);
    try {
      await pwConfirm.run();
    } finally {
      setPwBusy(false);
      setPwConfirm(null);
      setPwValue('');
    }
  };

  const sorted = [...planningPeriods].sort((a, b) => {
    const ra = getPeriodDateRange(a);
    const rb = getPeriodDateRange(b);
    return ra.start.getTime() - rb.start.getTime();
  });

  // Client-side overlap detection for immediate, always-visible warnings (in addition
  // to the server's authoritative check surfaced on create/update).
  const overlapsById = new Map<string, PlanningPeriod[]>();
  for (const p of planningPeriods) {
    const others = planningPeriods.filter(o => o.id !== p.id && periodsOverlap(p, o));
    if (others.length > 0) overlapsById.set(p.id, others);
  }

  const openCreateForm = () => {
    setForm(emptyForm());
    setOverlapWarning(null);
    setFormOpen(true);
  };

  const openEditForm = (period: PlanningPeriod) => {
    const { start, end } = getPeriodDateRange(period);
    setForm({
      id: period.id,
      name: period.name || '',
      startYear: start.getFullYear(),
      startMonth: start.getMonth(),
      endYear: end.getFullYear(),
      endMonth: end.getMonth(),
    });
    setOverlapWarning(null);
    setFormOpen(true);
  };

  const submitForm = async () => {
    setSaving(true);
    setOverlapWarning(null);
    const months = formToMonths(form);
    const input = {
      name: form.name.trim() || undefined,
      year: form.startYear,
      startMonth: form.startMonth,
      months,
    };
    const result = form.id
      ? await updatePlanningPeriod(form.id, input)
      : await createPlanningPeriod(input);
    setSaving(false);
    if (!result) return;
    if (result.overlapWarning) {
      setOverlapWarning(result.overlapWarning);
    } else {
      setFormOpen(false);
      onSelect(result.period.id);
    }
  };

  const requestDelete = (period: PlanningPeriod) => {
    requirePassword(
      'Planungsperiode löschen',
      `Möchten Sie die Planungsperiode „${periodLabel(period)}“ wirklich löschen? Alle enthaltenen Schichtzuweisungen gehen unwiderruflich verloren.`,
      async () => {
        setBusyId(period.id);
        await deletePlanningPeriod(period.id);
        setBusyId(null);
      },
    );
  };

  const toggleRelease = (period: PlanningPeriod) => {
    const willRelease = !period.released;
    requirePassword(
      willRelease ? 'Periode freigeben' : 'Freigabe zurückziehen',
      willRelease
        ? `Möchten Sie „${periodLabel(period)}“ für die Mitarbeitenden freigeben? Der Plan wird im Mitarbeiter-Portal sichtbar.${!period.employeesLocked ? ' Änderungen (Urlaub/Präferenzen) werden dabei automatisch gesperrt.' : ''}`
        : `Möchten Sie die Freigabe von „${periodLabel(period)}“ zurückziehen? Mitarbeitende können den Plan dann nicht mehr im Portal einsehen.`,
      async () => {
        setBusyId(period.id);
        await setPeriodReleased(period.id, willRelease);
        setBusyId(null);
      },
    );
  };

  const toggleLock = (period: PlanningPeriod) => {
    const willLock = !period.employeesLocked;
    requirePassword(
      willLock ? 'Änderungen sperren' : 'Änderungen entsperren',
      willLock
        ? `Änderungen (Urlaub/Präferenzen) für Mitarbeitende bei „${periodLabel(period)}“ sperren?`
        : `Änderungen (Urlaub/Präferenzen) für Mitarbeitende bei „${periodLabel(period)}“ wieder freigeben?`,
      async () => {
        setBusyId(period.id);
        await setPeriodLocked(period.id, willLock);
        setBusyId(null);
      },
    );
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-gray-900">Planungsperioden</h2>
          <p className="text-sm text-gray-600">Verwalten Sie beliebig viele Zeiträume — Freigabe und Änderungssperre gelten pro Periode.</p>
        </div>
        <button
          onClick={openCreateForm}
          className="inline-flex items-center gap-2 px-3 sm:px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 font-medium text-sm"
        >
          <Plus size={16} /> Neue Periode
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="text-center py-8 text-gray-500 text-sm bg-gray-50 rounded-lg border border-gray-200">
          Noch keine Planungsperiode angelegt.
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map(period => {
            const isSelected = period.id === selectedPeriodId;
            const overlaps = overlapsById.get(period.id);
            const isBusy = busyId === period.id;
            return (
              <div
                key={period.id}
                onClick={() => onSelect(period.id)}
                className={`rounded-lg border-2 p-3 sm:p-4 cursor-pointer transition-colors ${
                  isSelected ? 'border-primary-400 bg-primary-50/50' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {isSelected ? (
                      <CheckCircle2 size={18} className="text-primary-600 flex-shrink-0" />
                    ) : (
                      <Circle size={18} className="text-gray-300 flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-900 truncate">{periodLabel(period)}</div>
                      <div className="text-xs text-gray-500">
                        {(period.assignments?.length ?? 0)} Zuweisungen
                        {period.algorithm ? ` · ${period.algorithm}` : ''}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`px-2 py-1 rounded-md text-xs font-semibold ${
                      period.released ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'
                    }`}>
                      {period.released ? 'Freigegeben' : 'In Planung'}
                    </span>
                    {period.employeesLocked && (
                      <span className="px-2 py-1 rounded-md text-xs font-semibold bg-red-100 text-red-800 flex items-center gap-1">
                        <Lock size={11} /> Gesperrt
                      </span>
                    )}

                    <button
                      onClick={(e) => { e.stopPropagation(); toggleRelease(period); }}
                      disabled={isBusy}
                      title={period.released ? 'Freigabe zurückziehen' : 'Für Mitarbeitende freigeben'}
                      className={`px-2 py-1 rounded-md text-xs font-medium border transition-colors ${
                        period.released
                          ? 'bg-white text-green-700 border-green-300 hover:bg-green-50'
                          : 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700'
                      }`}
                    >
                      {period.released ? 'Zurückziehen' : 'Freigeben'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (!period.released) toggleLock(period); }}
                      disabled={isBusy || period.released}
                      title={period.released
                        ? 'Freigegebene Perioden sind dauerhaft gesperrt und können nicht mehr entsperrt werden'
                        : period.employeesLocked ? 'Änderungen für Mitarbeitende entsperren' : 'Änderungen für Mitarbeitende sperren'}
                      className={`px-2 py-1 rounded-md text-xs font-medium border transition-colors flex items-center gap-1 ${
                        period.released ? 'bg-gray-50 text-gray-400 border-gray-200 cursor-not-allowed'
                        : period.employeesLocked
                          ? 'bg-white text-red-700 border-red-300 hover:bg-red-50'
                          : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {period.employeesLocked ? <Unlock size={12} /> : <Lock size={12} />}
                      {period.employeesLocked ? 'Entsperren' : 'Sperren'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); openEditForm(period); }}
                      title="Zeitraum bearbeiten"
                      className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-md"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); requestDelete(period); }}
                      title="Planungsperiode löschen"
                      className="p-1.5 text-red-500 hover:bg-red-50 rounded-md"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {overlaps && overlaps.length > 0 && (
                  <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                    <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                    <span>Überschneidet sich mit: {overlaps.map(o => periodLabel(o)).join(', ')}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create/edit modal */}
      {formOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">
              {form.id ? 'Planungsperiode bearbeiten' : 'Neue Planungsperiode'}
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name (optional)</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder={`z. B. "${getMonthName(form.startMonth)} ${form.startYear}"`}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Von (Monat)</label>
                  <select
                    value={form.startMonth}
                    onChange={e => setForm(f => ({ ...f, startMonth: Number(e.target.value) }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    {Array.from({ length: 12 }).map((_, i) => <option key={i} value={i}>{getMonthName(i)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Von (Jahr)</label>
                  <select
                    value={form.startYear}
                    onChange={e => setForm(f => ({ ...f, startYear: Number(e.target.value) }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    {YEAR_RANGE.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Bis (Monat)</label>
                  <select
                    value={form.endMonth}
                    onChange={e => setForm(f => ({ ...f, endMonth: Number(e.target.value) }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    {Array.from({ length: 12 }).map((_, i) => <option key={i} value={i}>{getMonthName(i)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Bis (Jahr)</label>
                  <select
                    value={form.endYear}
                    onChange={e => setForm(f => ({ ...f, endYear: Number(e.target.value) }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    {YEAR_RANGE.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
              </div>

              <p className="text-xs text-gray-500">
                Umfasst {formToMonths(form)} Monat{formToMonths(form) !== 1 ? 'e' : ''}.
              </p>

              {overlapWarning && (
                <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-3">
                  <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                  <span>{overlapWarning} Die Periode wurde trotzdem gespeichert — bitte prüfen Sie die Zeiträume.</span>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setFormOpen(false)}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Abbrechen
              </button>
              <button
                onClick={submitForm}
                disabled={saving || formToMonths(form) < 1}
                className="px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 font-medium disabled:bg-gray-300"
              >
                {saving ? 'Speichern…' : form.id ? 'Speichern' : 'Erstellen'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Password confirmation — required for Löschen, Freigeben/Zurückziehen, Sperren/Entsperren */}
      {pwConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <div className="flex items-center gap-3 mb-3">
              <AlertTriangle className="text-amber-500 flex-shrink-0" size={24} />
              <h3 className="text-lg font-semibold text-gray-800">{pwConfirm.title}</h3>
            </div>
            <p className="text-gray-600 mb-4">{pwConfirm.message}</p>
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-1">Passwort eingeben</label>
              <input
                type="password"
                autoFocus
                value={pwValue}
                onChange={e => setPwValue(e.target.value)}
                placeholder="Passwort"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                onKeyDown={e => { if (e.key === 'Enter' && pwValue === ADMIN_PASSWORD) runPwConfirm(); }}
              />
              {pwValue.length > 0 && pwValue !== ADMIN_PASSWORD && (
                <p className="text-sm text-red-500 mt-1">Falsches Passwort</p>
              )}
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { setPwConfirm(null); setPwValue(''); }}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Abbrechen
              </button>
              <button
                onClick={runPwConfirm}
                disabled={pwBusy || pwValue !== ADMIN_PASSWORD}
                className={`px-4 py-2 rounded-md text-white font-medium ${
                  pwValue !== ADMIN_PASSWORD ? 'bg-gray-400 cursor-not-allowed' : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {pwBusy ? 'Wird verarbeitet…' : 'Bestätigen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
