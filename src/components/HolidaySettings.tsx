import { useState, useMemo } from 'react';
import { useStore } from '../store';
import { Plus, Trash2, X, Pencil, RotateCcw } from 'lucide-react';
import { generateId, getBerlinHolidays } from '../utils/helpers';
import { ViewTab, DEFAULT_TAB_VISIBILITY, TabVisibility, DEFAULT_SWAP_SETTINGS } from '../types';

export function HolidaySettings({ onClose }: { onClose: () => void }) {
  const { customHolidays, addCustomHoliday, updateCustomHoliday, deleteCustomHoliday, currentYear, swapSettings, setSwapSettings, tabVisibility, setTabVisibility } = useStore();
  const [settingsTab, setSettingsTab] = useState<'holidays' | 'swap' | 'tabs' | 'reset'>('holidays');
  const [newDate, setNewDate] = useState('');
  const [newName, setNewName] = useState('');
  const [viewYear, setViewYear] = useState<number>(currentYear);

  // Password gates
  const [tabsPassword, setTabsPassword] = useState('');
  const [tabsUnlocked, setTabsUnlocked] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [resetUnlocked, setResetUnlocked] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [resetting, setResetting] = useState(false);

  // edits holds temporary edits keyed by date
  const [edits, setEdits] = useState<Record<string, { date: string; name: string }>>({});

  const builtin = useMemo(() => getBerlinHolidays(viewYear), [viewYear]);

  // merged list of dates (builtin + custom)
  const allDates = useMemo(() => {
    const set = new Set<string>([...Object.keys(builtin), ...customHolidays.map(h => h.date)]);
    return Array.from(set).sort();
  }, [builtin, customHolidays]);

  const handleAdd = () => {
    if (!newDate || !newName) return;
    addCustomHoliday({ id: generateId(), date: newDate, name: newName });
    setNewDate('');
    setNewName('');
  };

  const saveRow = (dateKey: string) => {
    const edit = edits[dateKey];
    const currentCustom = customHolidays.find(h => h.date === dateKey) || customHolidays.find(h => h.date === (edit?.date || dateKey));

    if (!edit) return;

    if (currentCustom) {
      updateCustomHoliday(currentCustom.id, { date: edit.date, name: edit.name, disabled: !!currentCustom.disabled });
    } else {
      addCustomHoliday({ id: generateId(), date: edit.date, name: edit.name });
    }
  };

  const removeRow = (dateKey: string) => {
    const custom = customHolidays.find(h => h.date === dateKey);
    if (custom) {
      // remove custom entry (restore builtin if exists)
      deleteCustomHoliday(custom.id);
      return;
    }

    // no custom entry -> hide builtin by adding a disabled custom
    const builtinName = builtin[dateKey] || '';
    addCustomHoliday({ id: generateId(), date: dateKey, name: builtinName, disabled: true });
  };

  const restoreRow = (dateKey: string) => {
    const custom = customHolidays.find(h => h.date === dateKey && h.disabled);
    if (custom) deleteCustomHoliday(custom.id);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-3xl bg-white rounded-lg shadow-lg overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold">Einstellungen</h3>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded"><X /></button>
          </div>
        </div>

        {/* Settings Tabs */}
        <div className="flex border-b">
          <button
            onClick={() => setSettingsTab('holidays')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${settingsTab === 'holidays' ? 'border-b-2 border-primary-600 text-primary-600' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Feiertage
          </button>
          <button
            onClick={() => setSettingsTab('swap')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${settingsTab === 'swap' ? 'border-b-2 border-primary-600 text-primary-600' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Tauschen
          </button>
          <button
            onClick={() => setSettingsTab('tabs')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${settingsTab === 'tabs' ? 'border-b-2 border-primary-600 text-primary-600' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Reiter
          </button>
          <button
            onClick={() => setSettingsTab('reset')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${settingsTab === 'reset' ? 'border-b-2 border-red-600 text-red-600' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Zurücksetzen
          </button>
        </div>

        {settingsTab === 'holidays' && (
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-gray-700">Jahr:</span>
            <select value={viewYear} onChange={e => setViewYear(Number(e.target.value))} className="px-2 py-1 border rounded">
              {Array.from({ length: 7 }).map((_, i) => {
                const y = currentYear - 3 + i;
                return <option key={y} value={y}>{y}</option>;
              })}
            </select>
          </div>
          <div className="flex gap-2">
            <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} className="px-3 py-2 border rounded w-40" />
            <input type="text" placeholder="Name (z. B. Buß- und Bettag)" value={newName} onChange={e => setNewName(e.target.value)} className="px-3 py-2 border rounded flex-1" />
            <button onClick={handleAdd} className="px-3 py-2 bg-primary-600 text-white rounded flex items-center gap-2"><Plus /> Hinzufügen</button>
          </div>

          <div className="max-h-72 overflow-y-auto border rounded">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left">Datum</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Quelle</th>
                  <th className="px-3 py-2 text-right">Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {allDates.map(dateKey => {
                  const builtinName = builtin[dateKey];
                  const custom = customHolidays.find(h => h.date === dateKey);
                  const isDisabled = !!custom?.disabled;
                  const displayName = custom ? custom.name || builtinName : (builtinName || '');
                  const source = custom ? (builtinName ? (custom.disabled ? 'versteckt (benutzerdef.)' : 'überschrieben (benutzerdef.)') : 'benutzerdefiniert') : 'System (Berlin)';

                  const edit = edits[dateKey] || { date: dateKey, name: displayName };

                  return (
                    <tr key={dateKey} className={`${isDisabled ? 'opacity-60 bg-gray-50' : ''} border-t`}> 
                      <td className="px-3 py-2 w-40">
                        <input type="date" value={edit.date} onChange={e => setEdits(prev => ({ ...prev, [dateKey]: { ...(prev[dateKey] || { date: dateKey, name: displayName }), date: e.target.value } }))} className="px-2 py-1 border rounded w-full" />
                      </td>
                      <td className="px-3 py-2">
                        <input type="text" value={edit.name} onChange={e => setEdits(prev => ({ ...prev, [dateKey]: { ...(prev[dateKey] || { date: dateKey, name: displayName }), name: e.target.value } }))} className="w-full px-2 py-1 border rounded" />
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-600">{source}</td>
                      <td className="px-3 py-2 text-right space-x-2">
                        <button onClick={() => saveRow(dateKey)} className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded border"> <Pencil size={14} /> Speichern</button>
                        {isDisabled ? (
                          <button onClick={() => restoreRow(dateKey)} className="px-2 py-1 bg-yellow-50 text-yellow-700 rounded border"> <RotateCcw size={14} /> Wiederherstellen</button>
                        ) : (
                          <button onClick={() => removeRow(dateKey)} className="px-2 py-1 text-rose-600 hover:bg-rose-50 rounded border"> <Trash2 size={14} /> Entfernen</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        )}

        {settingsTab === 'swap' && (
        <div className="p-4 space-y-4">
          <div className="bg-white border rounded-lg p-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h4 className="font-medium text-gray-900">Schichttausch aktivieren</h4>
                <p className="text-sm text-gray-500">Ermöglicht Mitarbeitern, freigegebene Schichten untereinander zu tauschen.</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={swapSettings.enabled}
                  onChange={e => setSwapSettings({ ...swapSettings, enabled: e.target.checked })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600"></div>
              </label>
            </div>

            {swapSettings.enabled && (
              <div className="space-y-3 pt-3 border-t">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={swapSettings.onlyWithinDepartment}
                    onChange={e => setSwapSettings({ ...swapSettings, onlyWithinDepartment: e.target.checked })}
                    className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-700">Tauschen nur in Abteilung</span>
                    <p className="text-xs text-gray-500">Nur Mitarbeiter der gleichen Abteilung können Schichten tauschen.</p>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={swapSettings.onlyWithinShiftType}
                    onChange={e => setSwapSettings({ ...swapSettings, onlyWithinShiftType: e.target.checked })}
                    className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-700">Tauschen nur im Schichttyp</span>
                    <p className="text-xs text-gray-500">Schichten können nur gegen den gleichen Schichttyp getauscht werden.</p>
                  </div>
                </label>
              </div>
            )}
          </div>
        </div>
        )}

        {settingsTab === 'tabs' && !tabsUnlocked && (
        <div className="p-4 space-y-4">
          <div className="bg-white border rounded-lg p-6 text-center">
            <h4 className="font-medium text-gray-900 mb-4">Passwort erforderlich</h4>
            <p className="text-sm text-gray-500 mb-4">Bitte geben Sie das Passwort ein, um die Reiter-Einstellungen zu bearbeiten.</p>
            <div className="max-w-xs mx-auto">
              <input
                type="password"
                value={tabsPassword}
                onChange={e => setTabsPassword(e.target.value)}
                placeholder="Passwort"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 mb-2"
                onKeyDown={e => { if (e.key === 'Enter' && tabsPassword === '2026') setTabsUnlocked(true); }}
              />
              {tabsPassword.length > 0 && tabsPassword !== '2026' && (
                <p className="text-sm text-red-500 mb-2">Falsches Passwort</p>
              )}
              <button
                onClick={() => { if (tabsPassword === '2026') setTabsUnlocked(true); }}
                disabled={tabsPassword !== '2026'}
                className={`w-full px-4 py-2 rounded-md text-white font-medium ${tabsPassword === '2026' ? 'bg-primary-600 hover:bg-primary-700' : 'bg-gray-400 cursor-not-allowed'}`}
              >
                Entsperren
              </button>
            </div>
          </div>
        </div>
        )}

        {settingsTab === 'tabs' && tabsUnlocked && (
        <div className="p-4 space-y-4">
          <div className="bg-white border rounded-lg p-4">
            <h4 className="font-medium text-gray-900 mb-2">Sichtbare Reiter (Manager-Ansicht)</h4>
            <p className="text-sm text-gray-500 mb-4">Deaktivierte Reiter werden in der Navigation ausgeblendet.</p>
            <div className="space-y-2">
              {([
                { id: 'employees' as ViewTab, label: 'Mitarbeiter' },
                { id: 'departments' as ViewTab, label: 'Abteilungen' },
                { id: 'planning' as ViewTab, label: 'Planung' },
                { id: 'calendar' as ViewTab, label: 'Kalender' },
                { id: 'kpis' as ViewTab, label: 'Fairness KPIs' },
                { id: 'swaps' as ViewTab, label: 'Tauschen' },
              ]).map(tab => (
                <label key={tab.id} className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={(tabVisibility || DEFAULT_TAB_VISIBILITY)[tab.id as keyof TabVisibility] !== false}
                    onChange={e => {
                      const current = tabVisibility || DEFAULT_TAB_VISIBILITY;
                      setTabVisibility({ ...current, [tab.id]: e.target.checked });
                    }}
                    className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                  />
                  <span className="text-sm font-medium text-gray-700">{tab.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        )}

        {settingsTab === 'reset' && !resetUnlocked && (
        <div className="p-4 space-y-4">
          <div className="bg-white border border-red-200 rounded-lg p-6 text-center">
            <h4 className="font-medium text-red-700 mb-4">Zurücksetzen — Passwort erforderlich</h4>
            <p className="text-sm text-gray-500 mb-4">Bitte geben Sie das Passwort ein, um auf die Reset-Funktion zuzugreifen.</p>
            <div className="max-w-xs mx-auto">
              <input
                type="password"
                value={resetPassword}
                onChange={e => setResetPassword(e.target.value)}
                placeholder="Passwort"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-red-500 mb-2"
                onKeyDown={e => { if (e.key === 'Enter' && resetPassword === '2026') setResetUnlocked(true); }}
              />
              {resetPassword.length > 0 && resetPassword !== '2026' && (
                <p className="text-sm text-red-500 mb-2">Falsches Passwort</p>
              )}
              <button
                onClick={() => { if (resetPassword === '2026') setResetUnlocked(true); }}
                disabled={resetPassword !== '2026'}
                className={`w-full px-4 py-2 rounded-md text-white font-medium ${resetPassword === '2026' ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-400 cursor-not-allowed'}`}
              >
                Entsperren
              </button>
            </div>
          </div>
        </div>
        )}

        {settingsTab === 'reset' && resetUnlocked && (
        <div className="p-4 space-y-4">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6">
            <h4 className="font-semibold text-red-700 mb-2">Alle Daten zurücksetzen</h4>
            <p className="text-sm text-red-600 mb-4">
              Diese Aktion löscht <strong>alle</strong> Mitarbeiter, Abteilungen, Schichtpläne, Feiertage, Labels und Einstellungen unwiderruflich.
            </p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Geben Sie <span className="font-mono font-bold text-red-600">ALLES LÖSCHEN</span> ein, um zu bestätigen:
              </label>
              <input
                type="text"
                value={resetConfirmText}
                onChange={e => setResetConfirmText(e.target.value)}
                placeholder="ALLES LÖSCHEN"
                className="w-full px-3 py-2 border border-red-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-red-500"
              />
            </div>
            <button
              onClick={async () => {
                if (resetConfirmText !== 'ALLES LÖSCHEN') return;
                setResetting(true);
                // Reset to pristine state
                const pristine = {
                  employees: [],
                  departments: [
                    { id: 'dept-1', name: 'Abteilung A' },
                    { id: 'dept-2', name: 'Abteilung B' },
                    { id: 'dept-3', name: 'Abteilung C' },
                  ],
                  currentYear: new Date().getFullYear(),
                  shiftPlan: null,
                  customHolidays: [],
                  labels: [],
                  calendarLabels: [],
                  swapSettings: DEFAULT_SWAP_SETTINGS,
                  tabVisibility: DEFAULT_TAB_VISIBILITY,
                };
                // Save to server first
                const token = localStorage.getItem('spm-auth-token');
                if (token) {
                  try {
                    await fetch('/api/state', {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify(pristine),
                    });
                  } catch {}
                }
                // Update local store
                useStore.setState(pristine as any);
                setResetting(false);
                onClose();
              }}
              disabled={resetConfirmText !== 'ALLES LÖSCHEN' || resetting}
              className={`w-full px-4 py-2 rounded-md text-white font-medium ${resetConfirmText === 'ALLES LÖSCHEN' ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-400 cursor-not-allowed'}`}
            >
              {resetting ? 'Wird zurückgesetzt…' : 'Alle Daten unwiderruflich löschen'}
            </button>
          </div>
        </div>
        )}

        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 border rounded">Schließen</button>
        </div>
      </div>
    </div>
  );
}
