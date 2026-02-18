import { useState, useMemo } from 'react';
import { useStore } from '../store';
import { Plus, Trash2, X, Pencil, RotateCcw } from 'lucide-react';
import { generateId, getBerlinHolidays } from '../utils/helpers';

export function HolidaySettings({ onClose }: { onClose: () => void }) {
  const { customHolidays, addCustomHoliday, updateCustomHoliday, deleteCustomHoliday, currentYear } = useStore();
  const [newDate, setNewDate] = useState('');
  const [newName, setNewName] = useState('');
  const [viewYear, setViewYear] = useState<number>(currentYear);

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
          <h3 className="text-lg font-semibold">Feiertage verwalten ({viewYear})</h3>
          <div className="flex items-center gap-2">
            <select value={viewYear} onChange={e => setViewYear(Number(e.target.value))} className="px-2 py-1 border rounded">
              {Array.from({ length: 7 }).map((_, i) => {
                const y = currentYear - 3 + i;
                return <option key={y} value={y}>{y}</option>;
              })}
            </select>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded"><X /></button>
          </div>
        </div>

        <div className="p-4 space-y-4">
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

        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 border rounded">Schließen</button>
        </div>
      </div>
    </div>
  );
}
