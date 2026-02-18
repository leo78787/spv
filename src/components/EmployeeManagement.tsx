import React, { useState } from 'react';
import { useStore } from '../store';
import { Employee, ShiftPreference, ShiftType, SHIFT_LABELS } from '../types';
import { generateId, parseBoolean, parseVacationRanges, processImportPreview, getBerlinHolidays, formatDate } from '../utils/helpers';
import { UserPlus, Trash2, Edit2, Save, X } from 'lucide-react';
import { addDays, startOfDay, startOfMonth, endOfMonth, eachDayOfInterval, addMonths, isSameDay } from 'date-fns';
import * as XLSX from 'xlsx';

export function EmployeeManagement() {
  const { employees, departments, customHolidays, addEmployee, updateEmployee, deleteEmployee, addDepartment } = useStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedDepartment, setSelectedDepartment] = useState<string>('all');

  // Import from Excel/CSV
  const [importPreview, setImportPreview] = useState<any[] | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  
  const [formData, setFormData] = useState<Partial<Employee>>({
    name: '',
    department: departments[0]?.id || '',
    isOver55: false,
    hasL2: false,
    vacationDays: [],
    vacationRanges: [],
    preferences: []
  });
  
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (editingId) {
      updateEmployee(editingId, {
        ...formData,
        vacationDays: formData.vacationDays || [],
        vacationRanges: formData.vacationRanges || [],
        preferences: formData.preferences || []
      });
      setEditingId(null);
    } else {
      const newEmployee: Employee = {
        id: generateId(),
        name: formData.name || '',
        department: formData.department || departments[0]?.id || '',
        isOver55: formData.isOver55 || false,
        hasL2: formData.hasL2 || false,
        vacationDays: formData.vacationDays || [],
        vacationRanges: formData.vacationRanges || [],
        preferences: formData.preferences || []
      };
      addEmployee(newEmployee);
    }
    
    resetForm();
  };
  
  const resetForm = () => {
    setFormData({
      name: '',
      department: departments[0]?.id || '',
      isOver55: false,
      hasL2: false,
      vacationDays: [],
      preferences: []
    });
    setShowAddForm(false);
    setEditingId(null);
  };
  
  const handleEdit = (employee: Employee) => {
    setFormData(employee);
    setEditingId(employee.id);
    setShowAddForm(true);
  };
  

  
  const addPreference = () => {
    const newPref: ShiftPreference = {
      shiftType: 'fruehschicht',
      startDate: new Date(),
      endDate: new Date(),
      preferred: true
    };
    setFormData(prev => ({
      ...prev,
      preferences: [...(prev.preferences || []), newPref]
    }));
  };

  // --- Excel/CSV template + upload support ---
  const downloadTemplate = (type: 'csv' | 'xlsx' = 'xlsx') => {
    const headers = ['name','department','isOver55','hasL2','vacationRanges'];
    const sample = [{
      name: 'Max Mustermann',
      department: departments[0]?.name || 'Abteilung A',
      isOver55: 'false',
      hasL2: 'true',
      vacationRanges: '2026-02-20:2026-02-24;2026-07-01:2026-07-03'
    }];

    if (type === 'csv') {
      const csv = [headers.join(','), sample.map(s => headers.map(h => (s as any)[h]).join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'employee_template.csv';
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    // xlsx
    const ws = XLSX.utils.json_to_sheet(sample, {header: headers});
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mitarbeiter');
    XLSX.writeFile(wb, 'employee_template.xlsx');
  };



  const handleFile = async (file: File) => {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    const existingNames = new Set(employees.map(e => e.name.toLowerCase().trim()));

    const preliminary = rows.map((row, index) => {
      const errors: string[] = [];
      const name = String(row.name || row.Name || '').trim();
      const lowerName = name.toLowerCase().trim();
      const departmentName = String(row.department || row.Department || '').trim();
      if (!name) errors.push('Name fehlt');
      if (!departmentName) errors.push('Abteilung fehlt');
      const isOver55 = parseBoolean(row.isOver55 || row.IsOver55 || row.Ü55 || row.ue55);
      const hasL2 = parseBoolean(row.hasL2 || row.HasL2 || row.L2);
      const vacationRanges = parseVacationRanges(row.vacationRanges || row.VacationRanges || row.vacations || row.Urlaub);
      const duplicateInExisting = existingNames.has(lowerName);
      return { rowIndex: index + 2, name, lowerName, departmentName, isOver55, hasL2, vacationRanges, errors, duplicateInExisting };
    });

    // mark duplicates within the import file
    const counts: Record<string, number> = {};
    preliminary.forEach(p => { counts[p.lowerName] = (counts[p.lowerName] || 0) + 1; });
    const parsed = preliminary.map(p => ({
      ...p,
      duplicateInImport: counts[p.lowerName] > 1,
      // suggestion is only shown in preview; final unique name is created at import time
      suggestedName: p.duplicateInExisting || counts[p.lowerName] > 1 ? `${p.name} (1)` : undefined
    }));

    setImportPreview(parsed);
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    handleFile(f);
    e.target.value = '';
  };

  const confirmImport = () => {
    if (!importPreview) return;

    const { departmentsToCreate, employeesToAdd } = processImportPreview(importPreview, employees, departments);

    // create missing departments first and keep a local map so we can assign imported employees to them immediately
    const createdDeptMap: Record<string, { id: string; name: string }> = {};
    departmentsToCreate.forEach(name => {
      const newDept = { id: `dept-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, name };
      addDepartment(newDept);
      createdDeptMap[name.toLowerCase().trim()] = newDept;
    });

    // add employees (resolve department id by name)
    employeesToAdd.forEach(emp => {
      const lookup = (n: string | undefined) => n ? n.toLowerCase().trim() : '';
      const wanted = lookup(emp.departmentName);

      // prefer existing store departments, then newly created local ones
      const existing = departments.find(d => d.name.toLowerCase().trim() === wanted);
      const created = createdDeptMap[wanted];
      const fallback = departments.find(d => d.name === emp.departmentName);
      const deptObj = existing || created || fallback || departments[0];

      const newEmp: Employee = {
        id: generateId(),
        name: emp.name,
        department: deptObj ? deptObj.id : 'dept-unknown',
        isOver55: emp.isOver55,
        hasL2: emp.hasL2,
        vacationDays: [],
        vacationRanges: emp.vacationRanges,
        preferences: []
      };
      addEmployee(newEmp);
    });

    const added = employeesToAdd.length;
    const failed = (importPreview as any[]).filter(r => r.errors.length > 0).length;
    if (importPreview.length > 0) {
      alert(`Import abgeschlossen. ${added} Mitarbeiter hinzugefügt, ${failed} fehlerhafte Zeilen.`);
    }

    setImportPreview(null);
  };

  const cancelImport = () => setImportPreview(null);

  const calcTotalVacationDays = (emp: Partial<Employee> | Employee) => {
    // build holiday set for years involved
    const years = new Set<number>();
    (emp.vacationDays || []).forEach(d => years.add(new Date(d).getFullYear()));
    (emp.vacationRanges || []).forEach(r => { years.add(new Date(r.startDate).getFullYear()); years.add(new Date(r.endDate).getFullYear()); });
    if (years.size === 0) years.add(new Date().getFullYear());

    const holidaySet = new Set<string>();
    years.forEach(y => {
      const bh = getBerlinHolidays(y);
      Object.keys(bh).forEach(k => holidaySet.add(k));
    });
    // include custom holidays (not disabled)
    (customHolidays || []).forEach((h: any) => { if (!h.disabled) holidaySet.add(h.date); });

    let total = 0;
    // single days
    (emp.vacationDays || []).forEach(d => {
      const dt = startOfDay(new Date(d));
      const iso = dt.toISOString().slice(0,10);
      const dow = dt.getDay();
      if (dow === 0 || dow === 6) return; // skip weekends
      if (holidaySet.has(iso)) return; // skip holidays
      total += 1;
    });

    // ranges
    (emp.vacationRanges || []).forEach(r => {
      const s = startOfDay(new Date(r.startDate));
      const e = startOfDay(new Date(r.endDate));
      for (let d = s; d <= e; d = addDays(d, 1)) {
        const iso = d.toISOString().slice(0,10);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        if (holidaySet.has(iso)) continue;
        total += 1;
      }
    });

    return total;
  };

  // Vacation ranges (multi-day)
  // Range picker modal state
  const [rangePickerOpen, setRangePickerOpen] = useState(false);
  const [rangePickerIndex, setRangePickerIndex] = useState<number | null>(null);
  const [pickerStart, setPickerStart] = useState<Date | null>(null);
  const [pickerEnd, setPickerEnd] = useState<Date | null>(null);
  const [pickerViewMonth, setPickerViewMonth] = useState<Date>(new Date());

  const openRangePicker = (index: number) => {
    const r = (formData.vacationRanges || [])[index];
    setRangePickerIndex(index);
    setPickerStart(r?.startDate ? new Date(r.startDate) : null);
    setPickerEnd(r?.endDate ? new Date(r.endDate) : null);
    setPickerViewMonth(r?.startDate ? new Date(r.startDate) : new Date());
    setRangePickerOpen(true);
  };

  const closeRangePicker = () => {
    setRangePickerOpen(false);
    setRangePickerIndex(null);
    setPickerStart(null);
    setPickerEnd(null);
  };

  const saveRangePicker = () => {
    if (rangePickerIndex === null) return closeRangePicker();
    const s = pickerStart || new Date();
    const e = pickerEnd || s;
    updateVacationRange(rangePickerIndex, { startDate: s, endDate: e });
    closeRangePicker();
  };

  const handlePickerDayClick = (d: Date) => {
    if (!pickerStart) {
      setPickerStart(d);
      setPickerEnd(null);
      return;
    }
    if (pickerStart && !pickerEnd) {
      if (d < pickerStart) {
        setPickerStart(d);
        setPickerEnd(null);
      } else {
        setPickerEnd(d);
      }
      return;
    }
    // restart selection
    setPickerStart(d);
    setPickerEnd(null);
  };

  // Preference range-picker (same single-calendar UX as vacation)
  const [prefPickerOpen, setPrefPickerOpen] = useState(false);
  const [prefPickerIndex, setPrefPickerIndex] = useState<number | null>(null);
  const [prefPickerStart, setPrefPickerStart] = useState<Date | null>(null);
  const [prefPickerEnd, setPrefPickerEnd] = useState<Date | null>(null);
  const [prefPickerViewMonth, setPrefPickerViewMonth] = useState<Date>(new Date());

  const openPrefPicker = (index: number) => {
    const p = (formData.preferences || [])[index];
    setPrefPickerIndex(index);
    setPrefPickerStart(p?.startDate ? new Date(p.startDate) : null);
    setPrefPickerEnd(p?.endDate ? new Date(p.endDate) : null);
    setPrefPickerViewMonth(p?.startDate ? new Date(p.startDate) : new Date());
    setPrefPickerOpen(true);
  };

  const closePrefPicker = () => {
    setPrefPickerOpen(false);
    setPrefPickerIndex(null);
    setPrefPickerStart(null);
    setPrefPickerEnd(null);
  };

  const savePrefPicker = () => {
    if (prefPickerIndex === null) return closePrefPicker();
    const s = prefPickerStart || new Date();
    const e = prefPickerEnd || s;
    updatePreference(prefPickerIndex, { startDate: s, endDate: e });
    closePrefPicker();
  };

  const handlePrefPickerDayClick = (d: Date) => {
    if (!prefPickerStart) {
      setPrefPickerStart(d);
      setPrefPickerEnd(null);
      return;
    }
    if (prefPickerStart && !prefPickerEnd) {
      if (d < prefPickerStart) {
        setPrefPickerStart(d);
        setPrefPickerEnd(null);
      } else {
        setPrefPickerEnd(d);
      }
      return;
    }
    // restart
    setPrefPickerStart(d);
    setPrefPickerEnd(null);
  };

  const addVacationRange = () => {
    const newRange = { startDate: new Date(), endDate: new Date() };
    const idx = (formData.vacationRanges || []).length;
    setFormData(prev => ({
      ...prev,
      vacationRanges: [...(prev.vacationRanges || []), newRange]
    }));
    // open picker for newly added range
    setRangePickerIndex(idx);
    setPickerStart(newRange.startDate);
    setPickerEnd(newRange.endDate);
    setPickerViewMonth(newRange.startDate);
    setRangePickerOpen(true);
  };

  const removeVacationRange = (index: number) => {
    setFormData(prev => ({
      ...prev,
      vacationRanges: (prev.vacationRanges || []).filter((_, i) => i !== index)
    }));
  };

  const updateVacationRange = (index: number, updates: Partial<{ startDate: Date; endDate: Date }>) => {
    setFormData(prev => {
      const newRanges = [...(prev.vacationRanges || [])];
      newRanges[index] = { ...newRanges[index], ...updates } as any;
      return { ...prev, vacationRanges: newRanges };
    });
  };
  
  const removePreference = (index: number) => {
    setFormData(prev => ({
      ...prev,
      preferences: (prev.preferences || []).filter((_, i) => i !== index)
    }));
  };
  
  const updatePreference = (index: number, updates: Partial<ShiftPreference>) => {
    setFormData(prev => {
      const newPreferences = [...(prev.preferences || [])];
      newPreferences[index] = { ...newPreferences[index], ...updates };
      return { ...prev, preferences: newPreferences };
    });
  };
  
  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6 gap-4">
        <div className="flex items-center gap-4">
          <h2 className="text-2xl font-bold text-gray-800">Mitarbeiterverwaltung</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => downloadTemplate('xlsx')}
              className="text-sm px-3 py-1 border border-gray-200 rounded-md hover:bg-gray-50"
            >Vorlage (.xlsx)</button>
            <button
              onClick={() => downloadTemplate('csv')}
              className="text-sm px-3 py-1 border border-gray-200 rounded-md hover:bg-gray-50"
            >Vorlage (.csv)</button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="text-sm px-3 py-1 border border-primary-600 text-primary-600 rounded-md hover:bg-primary-50"
            >Import (.xlsx/.csv)</button>
            <input ref={fileInputRef} type="file" accept=".csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx" onChange={onFileChange} className="hidden" />
          </div>
        </div>

        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-2 bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors"
        >
          {showAddForm ? <X size={20} /> : <UserPlus size={20} />}
          {showAddForm ? 'Abbrechen' : 'Mitarbeiter hinzufügen'}
        </button>
      </div>
      
      {importPreview && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded shadow-lg w-11/12 max-w-3xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Import‑Vorschau</h3>
              <div className="text-sm text-gray-500">Zeilen: {importPreview.length}</div>
            </div>

            <div className="mt-4 overflow-auto max-h-72 border rounded-md">
              <table className="w-full text-sm table-fixed">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="p-2 text-left">Zeile</th>
                    <th className="p-2 text-left">Name</th>
                    <th className="p-2 text-left">Abteilung</th>
                    <th className="p-2 text-left">Hinweis</th>
                    <th className="p-2 text-left">Fehler</th>
                  </tr>
                </thead>
                <tbody>
                  {importPreview.map((row: any) => (
                    <tr key={row.rowIndex} className={row.errors && row.errors.length > 0 ? 'bg-rose-50' : ''}>
                      <td className="p-2 align-top">{row.rowIndex}</td>
                      <td className="p-2 align-top">
                        <div className="font-medium">{row.name}</div>
                        {row.duplicateInExisting && <div className="text-xs text-amber-700">Bestehender Name</div>}
                        {row.duplicateInImport && <div className="text-xs text-amber-700">Doppelte Zeile in Import</div>}
                      </td>
                      <td className="p-2 align-top">{row.departmentName}</td>
                      <td className="p-2 align-top">
                        {row.suggestedName && <div className="text-xs text-gray-600">Vorschlag: {row.suggestedName}</div>}
                      </td>
                      <td className="p-2 align-top text-xs text-rose-800">{(row.errors || []).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex justify-end gap-3">
              <button onClick={cancelImport} className="px-4 py-2 border rounded">Abbrechen</button>
              <button onClick={confirmImport} className="px-4 py-2 bg-primary-600 text-white rounded">Importieren</button>
            </div>
          </div>
        </div>
      )}

      {showAddForm && (
        <form onSubmit={handleSubmit} className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h3 className="text-lg font-semibold mb-4">
            {editingId ? 'Mitarbeiter bearbeiten' : 'Neuer Mitarbeiter'}
          </h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
              <input
                type="text"
                required
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Abteilung *</label>
              <select
                required
                value={formData.department}
                onChange={e => setFormData({ ...formData, department: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {departments.map(dept => (
                  <option key={dept.id} value={dept.id}>{dept.name}</option>
                ))}
              </select>
            </div>
          </div>
          
          <div className="flex gap-6 mb-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.isOver55}
                onChange={e => setFormData({ ...formData, isOver55: e.target.checked })}
                className="w-4 h-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
              />
              <span className="text-sm font-medium text-gray-700">Über 55 Jahre</span>
            </label>
            
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.hasL2}
                onChange={e => setFormData({ ...formData, hasL2: e.target.checked })}
                className="w-4 h-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
              />
              <span className="text-sm font-medium text-gray-700">L2-Zertifizierung</span>
            </label>
          </div>
          
{/* Urlaubszeiträume (inkl. eintägiger Bereiche) */}
          <div className="mb-4">
            <div className="flex justify-between items-center mb-2">
              <label className="block text-sm font-medium text-gray-700">Urlaubszeiträume</label>
              <div className="flex items-center gap-3">
                <div className="text-sm text-gray-600">Bisher genommen: {calcTotalVacationDays(formData)} Tag(e)</div>
                <button
                  type="button"
                  onClick={addVacationRange}
                  className="text-sm text-primary-600 hover:text-primary-700"
                >
                  + Zeitraum
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {(formData.vacationRanges || []).map((r, index) => (
                <div key={`r-${index}`} className="flex gap-2 items-center">
                  <div className="flex-1 grid grid-cols-1 gap-2">
                    <label className="block text-xs text-gray-500">Zeitraum</label>
                    <button type="button" onClick={() => openRangePicker(index)} className="w-full text-left px-3 py-2 border border-gray-300 rounded-md bg-white hover:bg-gray-50">
                      <div className="text-sm font-medium">{r.startDate instanceof Date ? formatDate(r.startDate) : '--'} — {r.endDate instanceof Date ? formatDate(r.endDate) : '--'}</div>
                      <div className="text-xs text-gray-500">{calcTotalVacationDays({ vacationRanges: [r] } as any)} Tag(e) (ohne Wochenenden/Feiertage)</div>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeVacationRange(index)}
                    className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-md"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}

              {/* Range Picker Modal */}
              {rangePickerOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                  <div className="bg-white rounded-lg shadow-lg w-full max-w-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={() => setPickerViewMonth(addMonths(pickerViewMonth, -1))} className="px-2 py-1 border rounded">‹</button>
                        <div className="font-semibold">{pickerViewMonth.toLocaleString('de-DE', { month: 'long', year: 'numeric' })}</div>
                        <button type="button" onClick={() => setPickerViewMonth(addMonths(pickerViewMonth, 1))} className="px-2 py-1 border rounded">›</button>
                      </div>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => { setPickerStart(null); setPickerEnd(null); }} className="px-3 py-1 border rounded text-sm">Auswahl löschen</button>
                        <button type="button" onClick={closeRangePicker} className="px-3 py-1 border rounded text-sm">Abbrechen</button>
                        <button type="button" onClick={saveRangePicker} className="px-3 py-1 bg-primary-600 text-white rounded text-sm">Speichern</button>
                      </div>
                    </div>

                    <div className="grid grid-cols-7 gap-1 text-center">
                      {['Mo','Di','Mi','Do','Fr','Sa','So'].map(d => (
                        <div key={d} className="text-xs text-gray-500 py-1">{d}</div>
                      ))}

                      {(() => {
                        const monthStart = startOfMonth(pickerViewMonth);
                        const monthEnd = endOfMonth(pickerViewMonth);
                        const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
                        // Monday-first lead calculation
                        const lead = (monthStart.getDay() + 6) % 7;
                        const cells: any[] = [];
                        for (let i = 0; i < lead; i++) cells.push(<div key={`empty-${i}`} />);

                        // holiday map for the picker month/year (builtin + custom, excluding disabled)
                        const builtin = getBerlinHolidays(pickerViewMonth.getFullYear());
                        const customMap = Object.fromEntries((customHolidays || []).filter((h: any) => !h.disabled).map((h: any) => [h.date, h.name]));
                        const holidayMap: Record<string,string> = { ...builtin, ...customMap };

                        days.forEach(day => {
                          const isStart = pickerStart ? isSameDay(day, pickerStart) : false;
                          const isEnd = pickerEnd ? isSameDay(day, pickerEnd) : false;
                          const inRange = pickerStart && pickerEnd ? (day >= pickerStart && day <= pickerEnd) : false;
                          const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                          const iso = day.toISOString().slice(0,10);
                          const isHoliday = !!holidayMap[iso];

                          const holidayBg = isHoliday && !(isStart || isEnd || inRange) ? 'bg-rose-100' : '';

                          cells.push(
                            <button type="button"
                              key={day.toISOString()}
                              onClick={() => handlePickerDayClick(day)}
                              className={`py-2 rounded ${isStart || isEnd ? 'bg-primary-600 text-white' : inRange ? 'bg-primary-100' : isWeekend ? 'text-gray-400' : 'hover:bg-gray-100'} ${holidayBg}`}
                            >
                              <div className="text-sm">{day.getDate()}</div>
                            </button>
                          );
                        });

                        return cells;
                      })()}
                    </div>
                  </div>
                </div>
              )}

            </div>

            <div className="mt-2 text-xs text-gray-500">Einzelne Tage bitte als Zeitraum mit gleichem Start‑ und Enddatum eingeben (z. B. 20.–20.).</div>
          </div>
          
          {/* Preferences */}
          <div className="mb-6">
            <div className="flex justify-between items-center mb-2">
              <label className="block text-sm font-medium text-gray-700">Schichtpräferenzen</label>
              <button
                type="button"
                onClick={addPreference}
                className="text-sm text-primary-600 hover:text-primary-700"
              >
                + Präferenz hinzufügen
              </button>
            </div>
            <div className="space-y-3">
              {(formData.preferences || []).map((pref, index) => (
                <div key={index} className="border border-gray-200 p-3 rounded-md">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-2">
                    <select
                      value={pref.shiftType}
                      onChange={e => updatePreference(index, { shiftType: e.target.value as ShiftType })}
                      className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      {Object.entries(SHIFT_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                    
                    <select
                      value={pref.preferred ? 'preferred' : 'avoid'}
                      onChange={e => updatePreference(index, { preferred: e.target.value === 'preferred' })}
                      className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      <option value="preferred">Bevorzugt</option>
                      <option value="avoid">Vermeiden</option>
                    </select>
                  </div>
                  
                  <div className="grid grid-cols-1 gap-3 mb-2">
                    <label className="block text-xs text-gray-600 mb-1">Zeitraum</label>
                    <button type="button" onClick={() => openPrefPicker(index)} className="w-full text-left px-3 py-2 border border-gray-300 rounded-md bg-white hover:bg-gray-50">
                      <div className="text-sm font-medium">{pref.startDate instanceof Date ? formatDate(pref.startDate) : '--'} — {pref.endDate instanceof Date ? formatDate(pref.endDate) : '--'}</div>
                    </button>
                  </div>
                  
                  <button
                    type="button"
                    onClick={() => removePreference(index)}
                    className="text-sm text-red-600 hover:text-red-700"
                  >
                    Entfernen
                  </button>
                </div>
              ))}
            </div>
          </div>
          
          {/* Preference range-picker modal */}
          {prefPickerOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
              <div className="bg-white rounded-lg shadow-lg w-full max-w-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => setPrefPickerViewMonth(addMonths(prefPickerViewMonth, -1))} className="px-2 py-1 border rounded">‹</button>
                    <div className="font-semibold">{prefPickerViewMonth.toLocaleString('de-DE', { month: 'long', year: 'numeric' })}</div>
                    <button type="button" onClick={() => setPrefPickerViewMonth(addMonths(prefPickerViewMonth, 1))} className="px-2 py-1 border rounded">›</button>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => { setPrefPickerStart(null); setPrefPickerEnd(null); }} className="px-3 py-1 border rounded text-sm">Auswahl löschen</button>
                    <button type="button" onClick={closePrefPicker} className="px-3 py-1 border rounded text-sm">Abbrechen</button>
                    <button type="button" onClick={savePrefPicker} className="px-3 py-1 bg-primary-600 text-white rounded text-sm">Speichern</button>
                  </div>
                </div>

                <div className="grid grid-cols-7 gap-1 text-center">
                  {['Mo','Di','Mi','Do','Fr','Sa','So'].map(d => (
                    <div key={d} className="text-xs text-gray-500 py-1">{d}</div>
                  ))}

                  {(() => {
                    const monthStart = startOfMonth(prefPickerViewMonth);
                    const monthEnd = endOfMonth(prefPickerViewMonth);
                    const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
                    const lead = (monthStart.getDay() + 6) % 7;
                    const cells: any[] = [];
                    for (let i = 0; i < lead; i++) cells.push(<div key={`empty-pref-${i}`} />);

                    const builtin = getBerlinHolidays(prefPickerViewMonth.getFullYear());
                    const customMap = Object.fromEntries((customHolidays || []).filter((h: any) => !h.disabled).map((h: any) => [h.date, h.name]));
                    const holidayMap: Record<string,string> = { ...builtin, ...customMap };

                    days.forEach(day => {
                      const isStart = prefPickerStart ? isSameDay(day, prefPickerStart) : false;
                      const isEnd = prefPickerEnd ? isSameDay(day, prefPickerEnd) : false;
                      const inRange = prefPickerStart && prefPickerEnd ? (day >= prefPickerStart && day <= prefPickerEnd) : false;
                      const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                      const iso = day.toISOString().slice(0,10);
                      const isHoliday = !!holidayMap[iso];

                      const holidayBg = isHoliday && !(isStart || isEnd || inRange) ? 'bg-rose-100' : '';

                      cells.push(
                        <button type="button"
                          key={day.toISOString()}
                          onClick={() => handlePrefPickerDayClick(day)}
                          className={`py-2 rounded ${isStart || isEnd ? 'bg-primary-600 text-white' : inRange ? 'bg-primary-100' : isWeekend ? 'text-gray-400' : 'hover:bg-gray-100'} ${holidayBg}`}
                        >
                          <div className="text-sm">{day.getDate()}</div>
                        </button>
                      );
                    });

                    return cells;
                  })()}
                </div>
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="submit"
              className="flex items-center gap-2 bg-primary-600 text-white px-6 py-2 rounded-lg hover:bg-primary-700 transition-colors"
            >
              <Save size={20} />
              {editingId ? 'Aktualisieren' : 'Hinzufügen'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="px-6 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Abbrechen
            </button>
          </div>
        </form>
      )}
      
      {/* Employee List */}

      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-700">Abteilung:</label>
          <select
            value={selectedDepartment}
            onChange={e => setSelectedDepartment(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="all">Alle Abteilungen</option>
            {departments.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
        <div className="text-sm text-gray-600">Angezeigt: {selectedDepartment === 'all' ? employees.length : employees.filter(emp => emp.department === selectedDepartment).length}</div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        { (selectedDepartment === 'all' ? employees : employees.filter(emp => emp.department === selectedDepartment)).map(employee => {
          const dept = departments.find(d => d.id === employee.department);
          return (
            <div key={employee.id} className="bg-white p-4 rounded-lg shadow-md hover:shadow-lg transition-shadow">
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h3 className="font-semibold text-lg text-gray-800">{employee.name}</h3>
                  <p className="text-sm text-gray-600">{dept?.name}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleEdit(employee)}
                    className="p-2 text-primary-600 hover:bg-primary-50 rounded-md transition-colors"
                  >
                    <Edit2 size={16} />
                  </button>
                  <button
                    onClick={() => deleteEmployee(employee.id)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-md transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              
              <div className="space-y-1 text-sm">
                <div className="flex gap-3">
                  {employee.isOver55 && (
                    <span className="px-2 py-1 bg-amber-100 text-amber-800 rounded-md text-xs">Ü55</span>
                  )}
                  {employee.hasL2 && (
                    <span className="px-2 py-1 bg-green-100 text-green-800 rounded-md text-xs">L2</span>
                  )}
                </div>
                
                {(employee.vacationDays.length > 0 || (employee.vacationRanges?.length || 0) > 0) && (
                  <div className="text-gray-600">
                    <span className="font-medium">Urlaub:</span>
                    <span className="ml-2 font-semibold">{calcTotalVacationDays(employee)} Tag(e)</span>
                    <div className="text-sm mt-1">
                      {employee.vacationRanges && employee.vacationRanges.length > 0 && (
                        <div className="mt-1 space-y-1">
                          {employee.vacationRanges.map((r, i) => (
                            <div key={i} className="text-xs text-gray-600">{new Date(r.startDate).toLocaleDateString('de-DE')} — {new Date(r.endDate).toLocaleDateString('de-DE')}</div>
                          ))}
                        </div>
                      )}
                      {employee.vacationDays && employee.vacationDays.length > 0 && (
                        <div className="mt-1 text-xs text-gray-600">(Einzeltage: {employee.vacationDays.length})</div>
                      )}
                    </div>
                  </div>
                )}
                
                {employee.preferences.length > 0 && (
                  <p className="text-gray-600">
                    <span className="font-medium">Präferenzen:</span> {employee.preferences.length}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      
      {employees.length === 0 && !showAddForm && (
        <div className="text-center py-12 text-gray-500">
          <p>Noch keine Mitarbeiter angelegt.</p>
          <p className="text-sm">Klicken Sie auf "Mitarbeiter hinzufügen" um zu beginnen.</p>
        </div>
      )}
    </div>
  );
}
