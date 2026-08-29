import React, { useState, useEffect } from 'react';
import { useStore, getAuthToken } from '../store';
import { Employee, ShiftPreference, ShiftType, SHIFT_LABELS, getPeriodDateRange } from '../types';
import { generateId, parseVacationRanges, processImportPreview, getBerlinHolidays, formatDate, formatDateForInput, parseDateInput } from '../utils/helpers';
import { getEmployeeActiveWeight } from '../utils/scheduler';
import { periodLabel } from './PlanningPeriodManager';
import { UserPlus, Trash2, Edit2, Save, X, Mail, Send, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { addDays, startOfDay, startOfMonth, endOfMonth, eachDayOfInterval, addMonths, isSameDay } from 'date-fns';
import * as XLSX from 'xlsx-js-style';

export function EmployeeManagement() {
  const { employees, departments, planningPeriods, customHolidays, addEmployee, updateEmployee, deleteEmployee, batchImport, defaultDepartmentId, adminRole } = useStore();
  const canEdit = adminRole !== 'betrachter';
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedDepartment, setSelectedDepartment] = useState<string>('all');
  // Managers assigned to a department get it pre-selected here by default (still switchable)
  const appliedDefaultDept = React.useRef(false);
  useEffect(() => {
    if (!appliedDefaultDept.current && defaultDepartmentId) {
      setSelectedDepartment(defaultDepartmentId);
      appliedDefaultDept.current = true;
    }
  }, [defaultDepartmentId]);
  const [selectedPeriodId, setSelectedPeriodIdState] = useState<string>(
    () => localStorage.getItem('spm-employees-period') || 'all'
  );
  const setSelectedPeriodId = (id: string) => {
    setSelectedPeriodIdState(id);
    localStorage.setItem('spm-employees-period', id);
  };

  // Import from Excel/CSV
  const [importPreview, setImportPreview] = useState<any[] | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  
  const [formData, setFormData] = useState<Partial<Employee>>({
    name: '',
    email: '',
    department: departments[0]?.id || '',
    allowedShiftTypes: ['fruehschicht', 'verschieben', 'nachtbereitschaft'],
    vacationDays: [],
    vacationRanges: [],
    preferences: []
  });

  // Portal credentials info
  const [credentialInfo, setCredentialInfo] = useState<Record<string, { username: string; mustChangePassword: boolean }>>({});
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Delete confirmation modal state
  const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null);
  const [deleteNameInput, setDeleteNameInput] = useState('');

  const showToast = (type: 'success' | 'error', text: string) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 4000);
  };

  // If the persisted period selection no longer exists (e.g. it was deleted), fall back to "Alle Zeiträume"
  useEffect(() => {
    if (selectedPeriodId !== 'all' && planningPeriods.length > 0 && !planningPeriods.some(p => p.id === selectedPeriodId)) {
      setSelectedPeriodId('all');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planningPeriods]);

  useEffect(() => {
    const token = getAuthToken();
    if (!token) return;
    fetch('/api/portal/credentials', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(setCredentialInfo)
      .catch(() => {});
  }, [employees]);

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
        email: formData.email || undefined,
        department: formData.department || departments[0]?.id || '',
        allowedShiftTypes: formData.allowedShiftTypes || ['fruehschicht', 'verschieben', 'nachtbereitschaft'],
        vacationDays: formData.vacationDays || [],
        vacationRanges: formData.vacationRanges || [],
        preferences: formData.preferences || [],
        hireDate: formData.hireDate,
        terminationDate: formData.terminationDate,
      };
      addEmployee(newEmployee);
    }
    
    resetForm();
  };
  
  const resetForm = () => {
    setFormData({
      name: '',
      email: '',
      department: departments[0]?.id || '',
      allowedShiftTypes: ['fruehschicht', 'verschieben', 'nachtbereitschaft'],
      vacationDays: [],
      preferences: []
    });
    setShowAddForm(false);
    setEditingId(null);
  };

  const handleInvite = async (empId: string) => {
    // Update the employee email in the store
    if (formData.email) {
      updateEmployee(empId, { email: formData.email });
    }
    setInvitingId(empId);
    try {
      const token = getAuthToken();
      const resp = await fetch('/api/portal/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ employeeId: empId, email: formData.email }),
      });
      const data = await resp.json();
      if (resp.ok) {
        showToast('success', `Einladung gesendet – Benutzername: ${data.username}`);
        fetch('/api/portal/credentials', { headers: { Authorization: `Bearer ${token}` } })
          .then(r => r.json()).then(setCredentialInfo).catch(() => {});
      } else {
        showToast('error', data.error || 'Fehler beim Senden der Einladung');
      }
    } catch (err) {
      showToast('error', 'Fehler: ' + err);
    } finally {
      setInvitingId(null);
    }
  };

  const handleResend = async (empId: string) => {
    setInvitingId(empId);
    try {
      const token = getAuthToken();
      const resp = await fetch('/api/portal/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ employeeId: empId }),
      });
      const data = await resp.json();
      if (resp.ok) {
        showToast('success', `Neue Zugangsdaten gesendet – Benutzername: ${data.username}`);
      } else {
        showToast('error', data.error || 'Fehler beim Senden');
      }
    } catch (err) {
      showToast('error', 'Fehler: ' + err);
    } finally {
      setInvitingId(null);
    }
  };
  
  const handleEdit = (employee: Employee) => {
    setFormData(employee);
    setEditingId(employee.id);
    setShowAddForm(true);
    // Scroll to form after React renders it
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const handleResetStatus = async (empId: string) => {
    try {
      const token = getAuthToken();
      const resp = await fetch('/api/portal/reset-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ employeeId: empId }),
      });
      if (resp.ok) {
        updateEmployee(empId, { portalStatus: 'draft' });
        setFormData(prev => ({ ...prev, portalStatus: 'draft' }));
        showToast('success', 'Status zurückgesetzt auf Entwurf');
      } else {
        const d = await resp.json().catch(() => ({}));
        showToast('error', d.error || 'Fehler beim Zurücksetzen');
      }
    } catch {
      showToast('error', 'Fehler beim Zurücksetzen');
    }
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
    const headers = ['name','email','department','isOver55','allowedShiftTypes','vacationRanges'];
    const sample = [{
      name: 'Max Mustermann',
      email: 'max@example.de',
      department: departments[0]?.name || 'Abteilung A',
      isOver55: 'nein',
      allowedShiftTypes: 'fruehschicht;verschieben;nachtbereitschaft',
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
      const email = String(row.email || row.Email || row['E-Mail'] || '').trim() || undefined;
      const departmentName = String(row.department || row.Department || '').trim();
      if (!name) errors.push('Name fehlt');
      if (!departmentName) errors.push('Abteilung fehlt');
      const allowedShiftTypesRaw = String(row.allowedShiftTypes || row.AllowedShiftTypes || row.Schichttypen || '').trim();
      const allowedShiftTypes: ShiftType[] = allowedShiftTypesRaw
        ? (allowedShiftTypesRaw.split(';').map(s => s.trim()).filter(s => ['fruehschicht','verschieben','nachtbereitschaft'].includes(s)) as ShiftType[])
        : ['fruehschicht', 'verschieben', 'nachtbereitschaft'];
      const isOver55Raw = String(row.isOver55 || row.IsÜ55 || row['Ü55'] || '').trim().toLowerCase();
      const isOver55 = ['ja', 'yes', 'true', '1', 'x'].includes(isOver55Raw);
      const vacationRanges = parseVacationRanges(row.vacationRanges || row.VacationRanges || row.vacations || row.Urlaub);
      const duplicateInExisting = existingNames.has(lowerName);
      return { rowIndex: index + 2, name, lowerName, email, departmentName, allowedShiftTypes, isOver55, vacationRanges, errors, duplicateInExisting };
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

    // Build new departments
    const newDepts: { id: string; name: string }[] = [];
    const createdDeptMap: Record<string, { id: string; name: string }> = {};
    departmentsToCreate.forEach(name => {
      const newDept = { id: `dept-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, name };
      newDepts.push(newDept);
      createdDeptMap[name.toLowerCase().trim()] = newDept;
    });

    // Build new employees list (resolve department id by name)
    const newEmps: Employee[] = [];
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
        email: emp.email,
        department: deptObj ? deptObj.id : 'dept-unknown',
        isOver55: !!emp.isOver55,
        allowedShiftTypes: emp.allowedShiftTypes || ['fruehschicht', 'verschieben', 'nachtbereitschaft'],
        vacationDays: [],
        vacationRanges: emp.vacationRanges,
        preferences: []
      };
      newEmps.push(newEmp);
    });

    // Single atomic batch update → one saveToServer call
    batchImport(newDepts, newEmps);

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

  // ── Planning-period filter (list view only — the edit form always shows/edits the full history) ──
  const selectedPeriod = selectedPeriodId === 'all' ? null : planningPeriods.find(p => p.id === selectedPeriodId) ?? null;
  const selectedPeriodRange = selectedPeriod ? getPeriodDateRange(selectedPeriod) : null;

  /** Vacation ranges/days of an employee that overlap the selected period (or all of them, if no period is selected). */
  const vacationForSelectedPeriod = (emp: Employee) => {
    if (!selectedPeriodRange) return { vacationRanges: emp.vacationRanges || [], vacationDays: emp.vacationDays || [] };
    const { start, end } = selectedPeriodRange;
    return {
      vacationRanges: (emp.vacationRanges || []).filter(r => startOfDay(new Date(r.startDate)) <= end && startOfDay(new Date(r.endDate)) >= start),
      vacationDays: (emp.vacationDays || []).filter(d => { const dd = startOfDay(new Date(d)); return dd >= start && dd <= end; }),
    };
  };

  /** Shift preferences of an employee that overlap the selected period (or all of them, if no period is selected). */
  const preferencesForSelectedPeriod = (emp: Employee): ShiftPreference[] => {
    if (!selectedPeriodRange) return emp.preferences || [];
    const { start, end } = selectedPeriodRange;
    return (emp.preferences || []).filter(p => startOfDay(new Date(p.startDate)) <= end && startOfDay(new Date(p.endDate)) >= start);
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
    <div className="p-3 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center mb-6 gap-3 sm:gap-4">
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-800">Mitarbeiterverwaltung</h2>
          {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
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
          )}
        </div>

        {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              if (showAddForm) {
                resetForm();
              } else {
                // Reset form to blank state before opening
                setFormData({
                  name: '',
                  email: '',
                  department: departments[0]?.id || '',
                  isOver55: false,
                  allowedShiftTypes: ['fruehschicht', 'verschieben', 'nachtbereitschaft'],
                  vacationDays: [],
                  vacationRanges: [],
                  preferences: []
                });
                setEditingId(null);
                setShowAddForm(true);
              }
            }}
            className="flex items-center gap-2 bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors"
          >
            {showAddForm ? <X size={20} /> : <UserPlus size={20} />}
            {showAddForm ? 'Abbrechen' : 'Mitarbeiter hinzufügen'}
          </button>
        </div>
        )}
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
        <form ref={formRef} onSubmit={handleSubmit} className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h3 className="text-lg font-semibold mb-4">
            {editingId ? 'Mitarbeiter bearbeiten' : 'Neuer Mitarbeiter'}
          </h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
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
              <label className="block text-sm font-medium text-gray-700 mb-1">E-Mail</label>
              <input
                type="email"
                value={formData.email || ''}
                onChange={e => setFormData({ ...formData, email: e.target.value || undefined })}
                placeholder="max@example.de"
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
          
          <div className="mb-4">
            <label className="flex items-center gap-2 mb-3">
              <input
                type="checkbox"
                checked={!!formData.isOver55}
                onChange={e => setFormData({ ...formData, isOver55: e.target.checked })}
                className="w-4 h-4 text-amber-600 border-gray-300 rounded focus:ring-amber-500"
              />
              <span className="text-sm font-medium text-gray-700">Ü55 Mitarbeiter</span>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Eintrittsdatum</label>
              <input
                type="date"
                value={formData.hireDate ? formatDateForInput(formData.hireDate) : ''}
                onChange={e => setFormData({ ...formData, hireDate: e.target.value ? parseDateInput(e.target.value) : undefined })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <p className="text-xs text-gray-400 mt-1">Leer = bereits vor jeder Planungsperiode beschäftigt</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Austrittsdatum</label>
              <input
                type="date"
                value={formData.terminationDate ? formatDateForInput(formData.terminationDate) : ''}
                onChange={e => setFormData({ ...formData, terminationDate: e.target.value ? parseDateInput(e.target.value) : undefined })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <p className="text-xs text-gray-400 mt-1">Leer = weiterhin beschäftigt. Bereits zugewiesene Schichten danach werden im Kalender ausgegraut und als Warnung angezeigt.</p>
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Erlaubte Schichttypen</label>
            <div className="flex flex-wrap gap-4">
              {(['fruehschicht', 'verschieben', 'nachtbereitschaft'] as ShiftType[]).map(st => (
                <label key={st} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={(formData.allowedShiftTypes || []).includes(st)}
                    onChange={e => {
                      const current = formData.allowedShiftTypes || [];
                      setFormData({
                        ...formData,
                        allowedShiftTypes: e.target.checked
                          ? [...current, st]
                          : current.filter(t => t !== st)
                      });
                    }}
                    className="w-4 h-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                  />
                  <span className="text-sm font-medium text-gray-700">{SHIFT_LABELS[st]}</span>
                </label>
              ))}
            </div>
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

            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
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

            <div className="mt-2 text-xs text-gray-500">Einzelner Tag: denselben Tag zweimal anklicken.</div>
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
            <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
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

          {/* Portal-Zugang section – only when editing an existing employee who has an email */}
          {editingId && formData.email && (
            <div className="mb-6 border border-indigo-200 rounded-lg overflow-hidden">
              <div className="bg-indigo-50 px-4 py-3 flex items-center gap-2 border-b border-indigo-200">
                <Mail size={16} className="text-indigo-600" />
                <h4 className="font-semibold text-indigo-900 text-sm">Portal-Zugang</h4>
              </div>
              <div className="p-4 space-y-3">
                {credentialInfo[editingId] ? (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <div className="text-xs text-gray-500 mb-1">Benutzername</div>
                        <div className="font-mono text-sm bg-gray-50 px-3 py-2 rounded border border-gray-200">{credentialInfo[editingId].username}</div>
                      </div>
                      <div className="flex-shrink-0">
                        <div className="text-xs text-gray-500 mb-1">Status</div>
                        <span className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium ${
                          credentialInfo[editingId].mustChangePassword
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-green-100 text-green-800'
                        }`}>
                          {credentialInfo[editingId].mustChangePassword ? 'Passwort nicht gesetzt' : 'Aktiv'}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                      <button
                        type="button"
                        onClick={() => handleResend(editingId)}
                        disabled={invitingId === editingId}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
                      >
                        <RefreshCw size={14} className={invitingId === editingId ? 'animate-spin' : ''} />
                        {invitingId === editingId ? 'Wird gesendet…' : 'Neue Zugangsdaten senden'}
                      </button>
                      {formData.portalStatus === 'submitted' && (
                        <button
                          type="button"
                          onClick={() => handleResetStatus(editingId)}
                          className="inline-flex items-center gap-2 px-4 py-2 text-sm border border-amber-400 text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100 transition-colors ml-8"
                        >
                          Zurück in Entwurf
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-gray-600">Dieser Mitarbeiter hat noch keinen Portal-Zugang. Senden Sie eine Einladung per E-Mail.</p>
                    <button
                      type="button"
                      onClick={() => handleInvite(editingId)}
                      disabled={invitingId === editingId}
                      className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 shadow-sm"
                    >
                      <Send size={14} className={invitingId === editingId ? 'animate-pulse' : ''} />
                      {invitingId === editingId ? 'Wird gesendet…' : 'Einladung per E-Mail senden'}
                    </button>
                  </>
                )}
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

      {/* Toast notification */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all ${
          toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toast.type === 'success' ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
          {toast.text}
          <button onClick={() => setToast(null)} className="ml-2 hover:opacity-80"><X size={16} /></button>
        </div>
      )}
      
      {/* Employee List */}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
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
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-700">Planungsperiode:</label>
            <select
              value={selectedPeriodId}
              onChange={e => setSelectedPeriodId(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="all">Alle Zeiträume</option>
              {planningPeriods.map(p => (
                <option key={p.id} value={p.id}>{periodLabel(p)}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="text-sm text-gray-600">
          Angezeigt: {(selectedDepartment === 'all' ? employees : employees.filter(emp => emp.department === selectedDepartment))
            .filter(emp => !selectedPeriodRange || getEmployeeActiveWeight(emp, selectedPeriodRange.start, selectedPeriodRange.end) > 0).length}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        { (selectedDepartment === 'all' ? employees : employees.filter(emp => emp.department === selectedDepartment))
            .filter(emp => !selectedPeriodRange || getEmployeeActiveWeight(emp, selectedPeriodRange.start, selectedPeriodRange.end) > 0)
            .map(employee => {
          const dept = departments.find(d => d.id === employee.department);
          return (
            <div key={employee.id} className="bg-white p-4 rounded-lg shadow-md hover:shadow-lg transition-shadow">
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h3 className="font-semibold text-lg text-gray-800">{employee.name}</h3>
                  <p className="text-sm text-gray-600">{dept?.name}</p>
                </div>
                {canEdit && (
                <div className="flex gap-2">
                  <button
                    onClick={() => handleEdit(employee)}
                    className="p-2 text-primary-600 hover:bg-primary-50 rounded-md transition-colors"
                  >
                    <Edit2 size={16} />
                  </button>
                  <button
                    onClick={() => { setDeleteTarget(employee); setDeleteNameInput(''); }}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-md transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                )}
              </div>
              
              <div className="space-y-1 text-sm">
                <div className="flex flex-wrap gap-2">
                  {employee.isOver55 && (
                    <span className="px-2 py-1 bg-amber-100 text-amber-800 rounded-md text-xs font-semibold">Ü55</span>
                  )}
                  {(employee.allowedShiftTypes && employee.allowedShiftTypes.length < 3) && (
                    <span className="px-2 py-1 bg-amber-100 text-amber-800 rounded-md text-xs">
                      Nur: {employee.allowedShiftTypes.map(t => SHIFT_LABELS[t]).join(', ')}
                    </span>
                  )}
                  {employee.portalStatus === 'invited' && (
                    <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded-md text-xs">Eingeladen</span>
                  )}
                  {employee.portalStatus === 'draft' && (
                    <span className="px-2 py-1 bg-yellow-100 text-yellow-800 rounded-md text-xs">Entwurf</span>
                  )}
                  {employee.portalStatus === 'submitted' && (
                    <span className="px-2 py-1 bg-emerald-100 text-emerald-800 rounded-md text-xs">Eingereicht</span>
                  )}
                  {employee.hireDate && (
                    <span className="px-2 py-1 bg-gray-100 text-gray-700 rounded-md text-xs">
                      Eintritt: {formatDate(employee.hireDate)}
                    </span>
                  )}
                  {employee.terminationDate && (
                    <span className={`px-2 py-1 rounded-md text-xs font-semibold ${
                      new Date(employee.terminationDate) < new Date()
                        ? 'bg-gray-200 text-gray-600'
                        : 'bg-orange-100 text-orange-800'
                    }`}>
                      Austritt: {formatDate(employee.terminationDate)}
                    </span>
                  )}
                </div>



                {(() => {
                  const { vacationRanges: periodVacationRanges, vacationDays: periodVacationDays } = vacationForSelectedPeriod(employee);
                  if (periodVacationDays.length === 0 && periodVacationRanges.length === 0) return null;
                  return (
                    <div className="text-gray-600">
                      <span className="font-medium">Urlaub{selectedPeriod ? ` (${periodLabel(selectedPeriod)})` : ''}:</span>
                      <span className="ml-2 font-semibold">{calcTotalVacationDays({ vacationRanges: periodVacationRanges, vacationDays: periodVacationDays })} Tag(e)</span>
                      <div className="text-sm mt-1">
                        {periodVacationRanges.length > 0 && (
                          <div className="mt-1 space-y-1">
                            {periodVacationRanges.map((r, i) => (
                              <div key={i} className="text-xs text-gray-600">{new Date(r.startDate).toLocaleDateString('de-DE')} — {new Date(r.endDate).toLocaleDateString('de-DE')}</div>
                            ))}
                          </div>
                        )}
                        {periodVacationDays.length > 0 && (
                          <div className="mt-1 text-xs text-gray-600">(Einzeltage: {periodVacationDays.length})</div>
                        )}
                      </div>
                    </div>
                  );
                })()}
                
                {preferencesForSelectedPeriod(employee).length > 0 && (
                  <p className="text-gray-600">
                    <span className="font-medium">Präferenzen{selectedPeriod ? ` (${periodLabel(selectedPeriod)})` : ''}:</span> {preferencesForSelectedPeriod(employee).length}
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

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-red-700 mb-3">Mitarbeiter löschen</h3>
            <p className="text-gray-600 mb-4">
              Möchten Sie <strong>{deleteTarget.name}</strong> wirklich unwiderruflich löschen?
            </p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Geben Sie den Namen <span className="font-semibold text-red-600">{deleteTarget.name}</span> zur Bestätigung ein:
              </label>
              <input
                type="text"
                value={deleteNameInput}
                onChange={e => setDeleteNameInput(e.target.value)}
                placeholder={deleteTarget.name}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-red-500"
                onKeyDown={e => {
                  if (e.key === 'Enter' && deleteNameInput === deleteTarget.name) {
                    deleteEmployee(deleteTarget.id);
                    setDeleteTarget(null);
                    setDeleteNameInput('');
                  }
                }}
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { setDeleteTarget(null); setDeleteNameInput(''); }}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Abbrechen
              </button>
              <button
                onClick={() => {
                  if (deleteNameInput === deleteTarget.name) {
                    deleteEmployee(deleteTarget.id);
                    setDeleteTarget(null);
                    setDeleteNameInput('');
                  }
                }}
                disabled={deleteNameInput !== deleteTarget.name}
                className={`px-4 py-2 rounded-md text-white font-medium ${deleteNameInput === deleteTarget.name ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-400 cursor-not-allowed'}`}
              >
                Endgültig löschen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
