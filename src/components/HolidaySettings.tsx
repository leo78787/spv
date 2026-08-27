import { useState, useMemo, useEffect } from 'react';
import { useStore, getAuthToken } from '../store';
import { Plus, Trash2, X, Pencil, RotateCcw, Upload, Mail } from 'lucide-react';
import { generateId, getBerlinHolidays } from '../utils/helpers';
import { ViewTab, DEFAULT_TAB_VISIBILITY, TabVisibility, DEFAULT_SWAP_SETTINGS } from '../types';

export function HolidaySettings({ onClose }: { onClose: () => void }) {
  const { customHolidays, addCustomHoliday, updateCustomHoliday, deleteCustomHoliday, currentYear, swapSettings, setSwapSettings, tabVisibility, setTabVisibility } = useStore();
  const [settingsTab, setSettingsTab] = useState<'holidays' | 'swap' | 'tabs' | 'backup' | 'reset'>('holidays');
  const [newDate, setNewDate] = useState('');
  const [newName, setNewName] = useState('');
  const [viewYear, setViewYear] = useState<number>(currentYear);

  // Password gates
  const [tabsPassword, setTabsPassword] = useState('');
  const [tabsUnlocked, setTabsUnlocked] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [backupUnlocked, setBackupUnlocked] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [resetUnlocked, setResetUnlocked] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [resetting, setResetting] = useState(false);

  // Backup tab state
  const [backupSettings, setBackupSettings] = useState<{ email: string; intervalHours: number; enabled: boolean; lastSentAt?: string } | null>(null);
  const [backupEmail, setBackupEmail] = useState('');
  const [backupIntervalValue, setBackupIntervalValue] = useState(1);
  const [backupIntervalUnit, setBackupIntervalUnit] = useState<'hours' | 'days' | 'weeks'>('days');
  const [backupSaving, setBackupSaving] = useState(false);
  const [backupMessage, setBackupMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreConfirmText, setRestoreConfirmText] = useState('');
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (!backupUnlocked) return;
    const token = getAuthToken();
    if (!token) return;
    fetch('/api/backup/settings', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        setBackupSettings(d);
        if (d) {
          setBackupEmail(d.email);
          const h = d.intervalHours as number;
          if (h % 168 === 0) { setBackupIntervalValue(h / 168); setBackupIntervalUnit('weeks'); }
          else if (h % 24 === 0) { setBackupIntervalValue(h / 24); setBackupIntervalUnit('days'); }
          else { setBackupIntervalValue(h); setBackupIntervalUnit('hours'); }
        }
      })
      .catch(() => {});
  }, [backupUnlocked]);

  const intervalToHours = () => backupIntervalValue * (backupIntervalUnit === 'hours' ? 1 : backupIntervalUnit === 'days' ? 24 : 168);

  const saveBackupSettings = async () => {
    if (!backupEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(backupEmail)) {
      setBackupMessage({ type: 'error', text: 'Bitte eine gültige E-Mail-Adresse angeben.' });
      return;
    }
    setBackupSaving(true);
    setBackupMessage(null);
    try {
      const token = getAuthToken();
      const resp = await fetch('/api/backup/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: backupEmail, intervalHours: intervalToHours() }),
      });
      const data = await resp.json();
      if (!resp.ok) { setBackupMessage({ type: 'error', text: data.error || 'Fehler beim Speichern.' }); return; }
      setBackupSettings({ email: backupEmail, intervalHours: intervalToHours(), enabled: true, lastSentAt: new Date().toISOString() });
      setBackupMessage({ type: 'success', text: 'Backup aktiviert — die erste E-Mail wurde soeben versendet.' });
    } catch {
      setBackupMessage({ type: 'error', text: 'Verbindungsfehler.' });
    } finally {
      setBackupSaving(false);
    }
  };

  const disableBackup = async () => {
    setBackupSaving(true);
    try {
      const token = getAuthToken();
      await fetch('/api/backup/disable', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      setBackupSettings(prev => prev ? { ...prev, enabled: false } : prev);
      setBackupMessage({ type: 'success', text: 'Automatisches Backup deaktiviert.' });
    } catch {
      setBackupMessage({ type: 'error', text: 'Verbindungsfehler.' });
    } finally {
      setBackupSaving(false);
    }
  };

  const doRestore = async () => {
    if (!restoreFile || restoreConfirmText !== 'WIEDERHERSTELLEN') return;
    setRestoring(true);
    setBackupMessage(null);
    try {
      const text = await restoreFile.text();
      const parsed = JSON.parse(text);
      const token = getAuthToken();
      const resp = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(parsed),
      });
      const data = await resp.json();
      if (!resp.ok) { setBackupMessage({ type: 'error', text: data.error || 'Fehler bei der Wiederherstellung.' }); return; }
      setBackupMessage({ type: 'success', text: 'Wiederherstellung erfolgreich. Die Seite wird neu geladen.' });
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      setBackupMessage({ type: 'error', text: `Ungültige Backup-Datei: ${err}` });
    } finally {
      setRestoring(false);
    }
  };

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
            onClick={() => setSettingsTab('backup')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${settingsTab === 'backup' ? 'border-b-2 border-primary-600 text-primary-600' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Backup
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

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={swapSettings.allowRingSwap ?? false}
                    onChange={e => setSwapSettings({ ...swapSettings, allowRingSwap: e.target.checked })}
                    className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-700">Ringtausch erlauben</span>
                    <p className="text-xs text-gray-500">Zusätzlich zu direkten Tauschen werden auch zirkuläre Tauschketten erkannt (A→B→C→A), bei denen mehrere Mitarbeiter ihre Schichten im Kreis tauschen.</p>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={swapSettings.allowDirectTakeover ?? false}
                    onChange={e => setSwapSettings({ ...swapSettings, allowDirectTakeover: e.target.checked })}
                    className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-700">Direktübernahme ohne Gegenleistung erlauben</span>
                    <p className="text-xs text-gray-500">Mitarbeiter können angebotene Schichten von Kolleg:innen direkt übernehmen, ohne selbst eine Schicht im Tausch anzubieten. Der Administrator muss die Übernahme im Bereich &quot;Matches&quot; noch bestätigen oder ablehnen.</p>
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

        {settingsTab === 'backup' && !backupUnlocked && (
        <div className="p-4 space-y-4">
          <div className="bg-white border rounded-lg p-6 text-center">
            <h4 className="font-medium text-gray-900 mb-4">Backup — Passwort erforderlich</h4>
            <p className="text-sm text-gray-500 mb-4">Bitte geben Sie das Passwort ein, um die Backup-Einstellungen zu bearbeiten.</p>
            <div className="max-w-xs mx-auto">
              <input
                type="password"
                value={backupPassword}
                onChange={e => setBackupPassword(e.target.value)}
                placeholder="Passwort"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 mb-2"
                onKeyDown={e => { if (e.key === 'Enter' && backupPassword === '2026') setBackupUnlocked(true); }}
              />
              {backupPassword.length > 0 && backupPassword !== '2026' && (
                <p className="text-sm text-red-500 mb-2">Falsches Passwort</p>
              )}
              <button
                onClick={() => { if (backupPassword === '2026') setBackupUnlocked(true); }}
                disabled={backupPassword !== '2026'}
                className={`w-full px-4 py-2 rounded-md text-white font-medium ${backupPassword === '2026' ? 'bg-primary-600 hover:bg-primary-700' : 'bg-gray-400 cursor-not-allowed'}`}
              >
                Entsperren
              </button>
            </div>
          </div>
        </div>
        )}

        {settingsTab === 'backup' && backupUnlocked && (
        <div className="p-4 space-y-4">
          {backupMessage && (
            <div className={`text-sm px-3 py-2 rounded-md ${backupMessage.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
              {backupMessage.text}
            </div>
          )}

          <div className="bg-white border rounded-lg p-4">
            <h4 className="font-medium text-gray-900 mb-1 flex items-center gap-2"><Mail size={16} /> Automatisches E-Mail-Backup</h4>
            <p className="text-sm text-gray-500 mb-4">
              Es wird sofort eine E-Mail mit einer vollständigen Sicherungsdatei (.json) verschickt, danach im angegebenen Intervall erneut. Die Datei enthält alles aus dem Admin-Bereich sowie alle Mitarbeiterdaten inkl. Portal-Zugänge — damit lässt sich die App exakt wiederherstellen.
            </p>

            {backupSettings?.enabled && (
              <div className="mb-4 text-sm bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md px-3 py-2">
                Aktiv für <strong>{backupSettings.email}</strong>, alle {backupSettings.intervalHours} Stunde(n).
                {backupSettings.lastSentAt && <> Zuletzt gesendet: {new Date(backupSettings.lastSentAt).toLocaleString('de-DE')}.</>}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">E-Mail-Adresse</label>
                <input
                  type="email"
                  value={backupEmail}
                  onChange={e => setBackupEmail(e.target.value)}
                  placeholder="backup@example.de"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Intervall</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={1}
                    value={backupIntervalValue}
                    onChange={e => setBackupIntervalValue(Math.max(1, Number(e.target.value)))}
                    className="w-20 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                  <select
                    value={backupIntervalUnit}
                    onChange={e => setBackupIntervalUnit(e.target.value as 'hours' | 'days' | 'weeks')}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="hours">Stunde(n)</option>
                    <option value="days">Tag(e)</option>
                    <option value="weeks">Woche(n)</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={saveBackupSettings}
                disabled={backupSaving || !backupEmail}
                className="px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 font-medium disabled:bg-gray-300"
              >
                {backupSaving ? 'Wird gespeichert…' : backupSettings?.enabled ? 'Speichern & sofort senden' : 'Aktivieren & sofort senden'}
              </button>
              {backupSettings?.enabled && (
                <button
                  onClick={disableBackup}
                  disabled={backupSaving}
                  className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 font-medium"
                >
                  Deaktivieren
                </button>
              )}
            </div>
          </div>

          <div className="bg-white border border-amber-200 rounded-lg p-4">
            <h4 className="font-medium text-gray-900 mb-1 flex items-center gap-2"><Upload size={16} /> Aus Backup wiederherstellen</h4>
            <p className="text-sm text-gray-500 mb-4">
              Ersetzt <strong>alle</strong> aktuellen Daten (Admin-Bereich und Mitarbeiter-Portal) durch den Inhalt der hochgeladenen Sicherungsdatei. Diese Aktion kann nicht rückgängig gemacht werden — eine Sicherheitskopie des aktuellen Stands wird vor dem Überschreiben serverseitig abgelegt.
            </p>
            <div className="space-y-3">
              <input
                type="file"
                accept="application/json,.json"
                onChange={e => setRestoreFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border file:border-gray-300 file:bg-white file:text-sm file:font-medium hover:file:bg-gray-50"
              />
              {restoreFile && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Geben Sie <span className="font-mono font-bold text-amber-700">WIEDERHERSTELLEN</span> ein, um zu bestätigen:
                    </label>
                    <input
                      type="text"
                      value={restoreConfirmText}
                      onChange={e => setRestoreConfirmText(e.target.value)}
                      placeholder="WIEDERHERSTELLEN"
                      className="w-full px-3 py-2 border border-amber-300 rounded-md focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
                    />
                  </div>
                  <button
                    onClick={doRestore}
                    disabled={restoreConfirmText !== 'WIEDERHERSTELLEN' || restoring}
                    className={`w-full px-4 py-2 rounded-md text-white font-medium ${restoreConfirmText === 'WIEDERHERSTELLEN' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-gray-400 cursor-not-allowed'}`}
                  >
                    {restoring ? 'Wird wiederhergestellt…' : 'Backup einspielen'}
                  </button>
                </>
              )}
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
                  departments: [],
                  currentYear: new Date().getFullYear(),
                  planningPeriods: [],
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
                    // Also wipe all portal credentials
                    await fetch('/api/portal/reset', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
