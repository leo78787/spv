import React, { useState, useEffect } from 'react';
import { useStore, getAuthToken } from '../store';
import { ShiftType, ShiftAssignment, SHIFT_LABELS, SHIFT_REQUIREMENTS, Department } from '../types';
import { getMonthName, getBerlinHolidays } from '../utils/helpers';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, Filter, Edit2, X, Download, Send, Lock, Unlock, AlertTriangle } from 'lucide-react';
import ViolationPipeline from './ViolationPipeline';
import { isBlockedFromFruehschichtDueToAdjacency, isBlockedFromNachtAfterVerschieben, isBlockedFromConsecutiveNacht, isBlockedFromConsecutiveFruehschicht, isBlockedFromVerschiebenDueToAdjacentFruehschicht, isBlockedFromVerschiebenAfterNacht, isBlockedFromConsecutiveVerschieben, hasAvoidancePreference, getAvailableEmployeesSorted, DEFAULT_SCHEDULER_CONFIG, canWorkOnDate } from '../utils/scheduler';
import { LabelModal } from './LabelModal';
import * as XLSX from 'xlsx-js-style';

// Module-level variable to persist the selected month across tab switches
let _persistedMonth: number | null = null;

import { 
  startOfMonth, 
  endOfMonth,
  eachDayOfInterval,
  format,
  isSameDay,
  getDay,
  addDays,
  startOfDay,
  endOfDay,
  isWithinInterval,
  getISOWeek,
  startOfWeek
} from 'date-fns';

export function CalendarView() {
  const { 
    employees, 
    departments, 
    currentYear, 
    setCurrentYear,
    shiftPlan,
    customHolidays,
    updateShiftAssignment,
    acknowledgeViolation,
    labels,
    calendarLabels,
  } = useStore();

  const [showPipeline, setShowPipeline] = useState(false);
  
  const [currentMonth, setCurrentMonth] = useState(_persistedMonth ?? new Date().getMonth());

  // Keep module-level variable in sync so the month survives tab switches
  useEffect(() => { _persistedMonth = currentMonth; }, [currentMonth]);
  const [selectedDepartment, setSelectedDepartment] = useState<string>('all');
  const [editingShift, setEditingShift] = useState<{
    assignment: ShiftAssignment;
    date: Date;
  } | null>(null);

  // Day for which the "pick a shift type" dropdown is shown under the ! badge
  const [mismatchPickerDay, setMismatchPickerDay] = useState<Date | null>(null);

  // State for in-modal override confirmation (replaces browser confirm)
  const [overrideConfirm, setOverrideConfirm] = useState<{
    employeeId: string;
    reasons: string[];
  } | null>(null);

  // State for label modal
  const [labelModalData, setLabelModalData] = useState<{
    employeeId: string;
    employeeName: string;
    date: Date;
  } | null>(null);

  // Plan release state
  const [planReleased, setPlanReleased] = useState(false);
  const [releasing, setReleasing] = useState(false);

  useEffect(() => {
    const token = getAuthToken();
    if (!token) return;
    fetch('/api/plan/release', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setPlanReleased(!!d.released)).catch(() => {});
  }, []);

  const togglePlanRelease = async () => {
    const token = getAuthToken();
    if (!token) return;
    setReleasing(true);
    try {
      const resp = await fetch('/api/plan/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ released: !planReleased }),
      });
      if (resp.ok) setPlanReleased(!planReleased);
    } catch {}
    setReleasing(false);
  };
  
  const handlePreviousMonth = () => {
    setCurrentMonth(prev => {
      if (prev === 0) {
        setCurrentYear(currentYear - 1);
        return 11;
      }
      return prev - 1;
    });
  };
  
  const handleNextMonth = () => {
    setCurrentMonth(prev => {
      if (prev === 11) {
        setCurrentYear(currentYear + 1);
        return 0;
      }
      return prev + 1;
    });
  };
  
  const getDepartmentName = (deptId: string) => {
    return departments.find(d => d.id === deptId)?.name || 'Unbekannt';
  };
  
  // Get all days in the current month
  const getDaysInMonth = () => {
    const monthStart = startOfMonth(new Date(currentYear, currentMonth, 1));
    const monthEnd = endOfMonth(new Date(currentYear, currentMonth, 1));
    return eachDayOfInterval({ start: monthStart, end: monthEnd });
  };
  
  // Filter employees by department
  const filteredEmployees = selectedDepartment === 'all'
    ? employees
    : employees.filter(emp => emp.department === selectedDepartment);
  
  // Get shifts for a specific employee on a specific day
  const getShiftsForEmployeeOnDay = (employeeId: string, date: Date): ShiftType[] => {
    if (!shiftPlan) return [];
    
    const shifts: ShiftType[] = [];
    
    shiftPlan.assignments.forEach(assignment => {
      if (!assignment.employees.includes(employeeId)) return;
      
      const assignmentStart = startOfDay(new Date(assignment.startDate));
      const assignmentEnd = startOfDay(new Date(assignment.endDate));
      const dayNorm = startOfDay(date);
      
      // Check if date falls within assignment period (normalized to day precision)
      if (dayNorm >= assignmentStart && dayNorm <= assignmentEnd) {
        shifts.push(assignment.shiftType);
      }
    });
    
    return shifts;
  };
  
  // Get assignment for a specific shift type and date
  const getAssignmentForDate = (shiftType: ShiftType, date: Date): ShiftAssignment | null => {
    if (!shiftPlan) return null;
    
    const assignment = shiftPlan.assignments.find(a => {
      if (a.shiftType !== shiftType) return false;
      
      const start = startOfDay(new Date(a.startDate));
      const end = startOfDay(new Date(a.endDate));
      const dayNorm = startOfDay(date);
      
      return dayNorm >= start && dayNorm <= end;
    });
    
    return assignment || null;
  };

  // Helper: check if a date falls into employee's vacation (single days or ranges)
  const isDateInVacation = (employeeId: string, date: Date) => {
    const emp = employees.find(e => e.id === employeeId);
    if (!emp) return false;

    // normalize date
    const d = startOfDay(date);

    // single-day vacation check
    const single = (emp.vacationDays || []).some(v => startOfDay(new Date(v)).getTime() === d.getTime());
    if (single) return true;

    // range check (inclusive)
    const inRange = (emp.vacationRanges || []).some(r => {
      const s = startOfDay(new Date(r.startDate));
      const e = endOfDay(new Date(r.endDate));
      return isWithinInterval(d, { start: s, end: e });
    });

    return inRange;
  };
  
  // Handle clicking on a shift to edit it
  const handleShiftClick = (_employeeId: string, date: Date, shiftType: ShiftType) => {
    const assignment = getAssignmentForDate(shiftType, date);
    if (assignment) {
      setEditingShift({ assignment, date });
    }
  };
  
  // Toggle employee in shift assignment
  // perform toggle (assign/unassign) for an employee on the open assignment
  const applyAssignmentChange = (employeeId: string) => {
    if (!editingShift) return;
    const currentEmployees = editingShift.assignment.employees;
    const isAssigned = currentEmployees.includes(employeeId);

    const updatedEmployees = isAssigned
      ? currentEmployees.filter(id => id !== employeeId)
      : [...currentEmployees, employeeId];

    const updatedAssignment: ShiftAssignment = {
      ...editingShift.assignment,
      employees: updatedEmployees
    };

    updateShiftAssignment(updatedAssignment);
    setEditingShift({ ...editingShift, assignment: updatedAssignment });
  };

  const handleToggleEmployee = (employeeId: string) => {
    if (!editingShift) return;

    const currentEmployees = editingShift.assignment.employees;
    const isAssigned = currentEmployees.includes(employeeId);

    // Unassign immediately
    if (isAssigned) {
      applyAssignmentChange(employeeId);
      return;
    }

    // Check rules before assigning
    const empObj = employees.find(e => e.id === employeeId);
    if (!empObj) return;

    const config = shiftPlan?.schedulerConfig ?? DEFAULT_SCHEDULER_CONFIG;
    const rules = config.rules;
    const shiftType = editingShift.assignment.shiftType;
    const allAssignments = shiftPlan?.assignments || [];
    const assignmentStart = new Date(editingShift.assignment.startDate);
    const assignmentEnd = new Date(editingShift.assignment.endDate);

    // Vacation always blocks (no toggle) — hard block, no override
    const isEmpOnVacation = (empObj.vacationDays || []).some(vacDay => {
      const vac = startOfDay(new Date(vacDay));
      return isWithinInterval(vac, { start: startOfDay(assignmentStart), end: endOfDay(assignmentEnd) });
    }) || (empObj.vacationRanges || []).some(r => {
      const s = startOfDay(new Date(r.startDate));
      const e = endOfDay(new Date(r.endDate));
      return s <= endOfDay(assignmentEnd) && e >= startOfDay(assignmentStart);
    });
    if (isEmpOnVacation) return;

    // ── SINGLE SOURCE OF TRUTH: use scheduler to determine eligibility ──
    const otherAssignments = allAssignments.filter(a => a.id !== editingShift.assignment.id);
    const schedulerResult = getAvailableEmployeesSorted(
      [empObj],
      shiftType,
      assignmentStart,
      assignmentEnd,
      otherAssignments,
      config,
    );
    const isBlocked = schedulerResult.length === 0;

    if (isBlocked) {
      // Compute specific reasons for the override dialog
      const assignmentDays = eachDayOfInterval({ start: startOfDay(assignmentStart), end: assignmentEnd });
      const reasons: string[] = [];

      // Adjacency checks — gated by rule toggles
      if (rules.noFruehschichtAdjacentToVerschieben) {
        if (shiftType === 'fruehschicht' && isBlockedFromFruehschichtDueToAdjacency(empObj, editingShift.date, allAssignments)) {
          reasons.push('Keine Wochenend‑Frühschicht — angrenzende verschobene Schicht');
        }
        if (shiftType === 'verschieben' && isBlockedFromVerschiebenDueToAdjacentFruehschicht(empObj, assignmentStart, assignmentEnd, allAssignments)) {
          reasons.push('Konflikt: Frühschicht am angrenzenden Wochenende');
        }
      }
      if (rules.noNachtAfterVerschieben && shiftType === 'nachtbereitschaft'
          && isBlockedFromNachtAfterVerschieben(empObj, assignmentStart, allAssignments)) {
        reasons.push('Keine Nachtwoche direkt nach Verschieben-Woche');
      }
      if (rules.noVerschiebenAfterNacht && shiftType === 'verschieben'
          && isBlockedFromVerschiebenAfterNacht(empObj, assignmentStart, allAssignments)) {
        reasons.push('Kein Verschieben direkt nach Nacht-Woche');
      }
      if (rules.noConsecutiveVerschieben && shiftType === 'verschieben'
          && isBlockedFromConsecutiveVerschieben(empObj, assignmentStart, allAssignments)) {
        reasons.push('Keine zwei aufeinanderfolgenden Verschieben-Wochen');
      }
      if (rules.noConsecutiveNacht && shiftType === 'nachtbereitschaft'
          && isBlockedFromConsecutiveNacht(empObj, assignmentStart, allAssignments)) {
        reasons.push('Keine zwei aufeinanderfolgenden Nachtwochen');
      }
      if (rules.noConsecutiveFruehschicht && shiftType === 'fruehschicht'
          && isBlockedFromConsecutiveFruehschicht(empObj, assignmentStart, allAssignments)) {
        reasons.push('Keine zwei aufeinanderfolgenden Frühschichten');
      }

      // Qualification
      if (rules.over55AndNoL2OnlyVerschieben && shiftType !== 'verschieben' && (empObj.isOver55 || !empObj.hasL2)) {
        if (empObj.isOver55 && !empObj.hasL2) {
          reasons.push('Ü55 und kein L2 — nur verschobene Schichten erlaubt');
        } else if (empObj.isOver55) {
          reasons.push('Ü55 — nur verschobene Schichten erlaubt');
        } else {
          reasons.push('Keine L2 — nur verschobene Schichten erlaubt');
        }
      }

      // Vacation boundary
      if (rules.noWeekendAroundVacation && assignmentDays.some(d => !canWorkOnDate(empObj, d, true))) {
        reasons.push('Kein Wochenenddienst um Urlaub herum');
      }

      // Avoidance
      if (rules.respectAvoidancePreferences && assignmentDays.some(d => hasAvoidancePreference(empObj, shiftType as ShiftType, d))) {
        reasons.push('Mitarbeiter vermeidet diese Schichtart');
      }

      // Overlapping
      if (otherAssignments.some(a => {
        if (!a.employees.includes(empObj.id)) return false;
        const aS = new Date(a.startDate); const aE = new Date(a.endDate);
        return aS <= assignmentEnd && aE >= assignmentStart;
      })) {
        reasons.push('Mitarbeiter hat bereits eine andere Schicht in diesem Zeitraum');
      }

      if (reasons.length === 0) reasons.push('Regelverstoß durch aktive Scheduler-Regeln');

      setOverrideConfirm({ employeeId, reasons });
      return;
    }

    // No block — assign
    applyAssignmentChange(employeeId);
  };
  

  
  // Get background color for shift type
  const getShiftColor = (shiftType: ShiftType) => {
    switch (shiftType) {
      case 'fruehschicht':
        return 'bg-blue-500 text-white';
      case 'verschieben':
        return 'bg-purple-500 text-white';
      case 'nachtbereitschaft':
        return 'bg-indigo-600 text-white';
      default:
        return 'bg-gray-100';
    }
  };
  
  // Get short label for shift type
  const getShiftLabel = (shiftType: ShiftType) => {
    switch (shiftType) {
      case 'fruehschicht':
        return 'F';
      case 'verschieben':
        return 'V';
      case 'nachtbereitschaft':
        return 'N';
      default:
        return '';
    }
  };

  // --- Export helpers (JSON + XLSX) ---
  const downloadPlanJSON = () => {
    if (!shiftPlan) return;
    const payload = { shiftPlan, employees, departments, labels, calendarLabels };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const start = shiftPlan.startMonth !== undefined ? `${shiftPlan.startMonth + 1}` : 'full';
    a.download = `schichtplan_${shiftPlan.year}_${start}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadPlanXLSX = () => {
    if (!shiftPlan) return;
    const wb = XLSX.utils.book_new();
    const startMonth = shiftPlan.startMonth ?? 0;
    const monthsCount = shiftPlan.months ?? 12;

    // ----- helper styles (xlsx-js-style format) -----
    const mkFill = (rgb: string) => ({ patternType: 'solid' as const, fgColor: { rgb } });
    const mkBorder = (style: string, rgb: string) => ({ style, color: { rgb } });
    const centerAlign = { horizontal: 'center', vertical: 'center' };
    const leftAlign   = { horizontal: 'left',   vertical: 'center' };

    // Group employees by department (preserving departments order)
    const grouped: { dept: Department | null; emps: typeof employees }[] = [];
    const assignedDeptIds = new Set(employees.map(e => e.department));
    for (const dept of departments) {
      if (!assignedDeptIds.has(dept.id)) continue;
      const emps = employees.filter(e => e.department === dept.id);
      if (emps.length > 0) grouped.push({ dept, emps });
    }
    const noDeptEmps = employees.filter(e => !departments.some(d => d.id === e.department));
    if (noDeptEmps.length > 0) grouped.push({ dept: null, emps: noDeptEmps });

    for (let m = 0; m < monthsCount; m++) {
      const absoluteMonth = startMonth + m;
      const year = shiftPlan.year + Math.floor(absoluteMonth / 12);
      const monthIndex = absoluteMonth % 12;
      const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
      const monthLabel = `${getMonthName(monthIndex)} ${year}`;

      // 3 fixed header rows
      const rowMonth: any[] = [''];
      const rowDays:  any[] = [''];
      const rowWeeks: any[] = ['Mitarbeiter'];
      for (let d = 1; d <= daysInMonth; d++) {
        rowMonth.push(d === 1 ? monthLabel : '');
        rowDays.push(String(d));
        rowWeeks.push(`KW ${getISOWeek(new Date(year, monthIndex, d))}`);
      }

      // Build data rows (dept headers + employee rows) and a styleMap keyed by sheet row index
      const dataRows: any[][] = [];
      // sheetRowStyles: rowIndex (0-based in sheet) → Map of colIndex → cell style
      const cellStyles: Map<string, any> = new Map(); // key: "r,c"

      let sheetRow = 3; // first data row after 3 header rows

      for (const { dept, emps } of grouped) {
        // Department header row
        const deptName = dept?.name ?? 'Sonstige';
        const deptRow: any[] = [deptName, ...Array(daysInMonth).fill('')];
        dataRows.push(deptRow);
        for (let c = 0; c <= daysInMonth; c++) {
          cellStyles.set(`${sheetRow},${c}`, {
            fill: mkFill('3B4A5C'),
            font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
            alignment: c === 0 ? leftAlign : centerAlign,
            border: {
              bottom: mkBorder('medium', '1E293B'),
              right: c === 0 ? mkBorder('medium', '1E293B') : mkBorder('thin', '4B5563'),
            },
          });
        }
        sheetRow++;

        for (const emp of emps) {
          const row: any[] = [emp.name];
          // Style for name cell (col A)
          cellStyles.set(`${sheetRow},0`, {
            fill: mkFill('F9FAFB'),
            alignment: leftAlign,
            border: { right: mkBorder('medium', 'E5E7EB') },
          });

          for (let d = 1; d <= daysInMonth; d++) {
            const date = new Date(year, monthIndex, d);
            const iso  = format(date, 'yyyy-MM-dd');

            // vacation
            const isVac = isDateInVacation(emp.id, date);
            if (isVac) {
              row.push('U');
              cellStyles.set(`${sheetRow},${d}`, {
                fill: mkFill('DDDDDD'),
                alignment: centerAlign,
                border: {
                  top:    mkBorder('thin', 'E5E7EB'),
                  bottom: mkBorder('thin', 'E5E7EB'),
                  left:   mkBorder('thin', 'E5E7EB'),
                  right:  mkBorder('thin', 'E5E7EB'),
                },
              });
              continue;
            }

            // shifts + labels
            const shifts = getShiftsForEmployeeOnDay(emp.id, date);
            const cellLabels = calendarLabels
              .filter(cl => cl.employeeId === emp.id && cl.date === iso)
              .map(cl => labels.find(l => l.id === cl.labelId))
              .filter(Boolean) as any[];

            const parts: string[] = [];
            if (shifts.length > 0)     parts.push(...shifts.map(s => getShiftLabel(s)));
            if (cellLabels.length > 0) parts.push(...cellLabels.map((l: any) => l.letter));
            const cellValue = parts.join(', ');
            row.push(cellValue);

            // determine fill color for content cells (labels/shifts)
            let fillRgb: string | null = null;
            if (cellLabels.length > 0 && (cellLabels[0].color || '').startsWith('#')) {
              fillRgb = (cellLabels[0].color as string).replace('#', '').toUpperCase();
            } else if (cellValue.includes('F')) {
              fillRgb = 'FFF2CC';
            } else if (cellValue.includes('V')) {
              fillRgb = 'DDEEFF';
            } else if (cellValue.includes('N')) {
              fillRgb = 'DDFFDD';
            }

            // weekend / holiday highlighting (only when the cell is otherwise empty)
            const isEmptyCell = !cellValue || cellValue.trim() === '';
            const isHoliday = !!holidayMap[iso];
            const dow = getDay(date);
            const isWeekend = dow === 0 || dow === 6;

            const HOLIDAY_FILL = 'FFF1F2';
            const WEEKEND_FILL = 'EEF2FF';

            const style: any = {
              alignment: centerAlign,
              border: {
                top:    mkBorder('thin', 'E5E7EB'),
                bottom: mkBorder('thin', 'E5E7EB'),
                left:   mkBorder('thin', 'E5E7EB'),
                right:  mkBorder('thin', 'E5E7EB'),
              },
            };

            if (fillRgb) {
              // explicit label/shift color wins
              style.fill = mkFill(fillRgb);
            } else if (isEmptyCell && isHoliday) {
              style.fill = mkFill(HOLIDAY_FILL);
            } else if (isEmptyCell && isWeekend) {
              style.fill = mkFill(WEEKEND_FILL);
            }

            cellStyles.set(`${sheetRow},${d}`, style);
          }

          dataRows.push(row);
          sheetRow++;
        }
      }

      // Assemble full AOA and create sheet
      const aoa = [rowMonth, rowDays, rowWeeks, ...dataRows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);

      // ---- Merges ----
      const lastCol = daysInMonth;
      ws['!merges'] = [];
      // Merge month label across day columns
      ws['!merges'].push({ s: { r: 0, c: 1 }, e: { r: 0, c: lastCol } });
      // Merge consecutive equal KW values in row 2
      let weekMergeStart = 1;
      let currentWeekLabel = rowWeeks[1];
      for (let i = 1; i <= daysInMonth; i++) {
        const wk = rowWeeks[i];
        const isLast = i === daysInMonth;
        if (wk !== currentWeekLabel || isLast) {
          const end = (isLast && wk === currentWeekLabel) ? i : i - 1;
          ws['!merges'].push({ s: { r: 2, c: weekMergeStart }, e: { r: 2, c: end } });
          // write the week label into the top-left cell of the merge
          const ref = XLSX.utils.encode_cell({ r: 2, c: weekMergeStart });
          ws[ref] = ws[ref] || { t: 's', v: currentWeekLabel };
          currentWeekLabel = wk;
          weekMergeStart = i;
        }
      }

      // ---- Apply header row styles (rows 0-2) ----
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      for (let R = 0; R <= 2; R++) {
        for (let C = range.s.c; C <= range.e.c; C++) {
          const ref = XLSX.utils.encode_cell({ r: R, c: C });
          if (!ws[ref]) ws[ref] = { t: 's', v: '' };
          ws[ref].s = {
            fill: mkFill('F3F4F6'),
            alignment: (R === 2 || R === 1 || C !== 0) ? centerAlign : leftAlign,
            border: { bottom: mkBorder('medium', 'CCCCCC') },
          };
        }
      }
      // Row 0 col A has no content but should match header style
      const a1 = XLSX.utils.encode_cell({ r: 0, c: 0 });
      if (ws[a1]) ws[a1].s = { fill: mkFill('F3F4F6'), alignment: leftAlign };

      // ---- Apply data-cell styles ----
      for (const [key, style] of cellStyles) {
        const [r, c] = key.split(',').map(Number);
        const ref = XLSX.utils.encode_cell({ r, c });
        if (!ws[ref]) ws[ref] = { t: 's', v: '' };
        ws[ref].s = style;
      }

      // ---- Column widths ----
      ws['!cols'] = [{ wch: 22 }, ...Array.from({ length: daysInMonth }, () => ({ wch: 4.5 }))];

      const sheetName = `${getMonthName(monthIndex)} ${year}`;
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }

    const fname = `schichtplan_${shiftPlan.year}_${startMonth + 1}.xlsx`;
    XLSX.writeFile(wb, fname);
  };
  
  const days = getDaysInMonth();
  const weekDayLabelsMon = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

  // Berlin holidays for the visible year + custom holidays from store (custom overrides/additions)
  const berlinHolidays = getBerlinHolidays(currentYear);
  // customHolidays with disabled=true hide the builtin holiday on that date
  const customHolidayMap = Object.fromEntries((customHolidays || []).filter((h: any) => !h.disabled).map((h: any) => [h.date, h.name]));
  const holidayMap: Record<string,string> = { ...berlinHolidays, ...customHolidayMap };
  
  if (!shiftPlan) {
    return (
      <div className="p-6">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
          <CalendarIcon className="mx-auto mb-3 text-yellow-600" size={48} />
          <h3 className="text-lg font-semibold text-yellow-800 mb-2">Kein Schichtplan vorhanden</h3>
          <p className="text-yellow-700">Bitte erstellen Sie zuerst einen Schichtplan in der Planung.</p>
        </div>
      </div>
    );
  }
  
  return (
    <div className="p-6">
      <div className="mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-gray-800">Schichtplan Kalender</h2>
          <div className="flex items-center gap-4">
            <button
              onClick={handlePreviousMonth}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <ChevronLeft size={24} />
            </button>
            <h3 className="text-xl font-semibold min-w-[200px] text-center">
              {getMonthName(currentMonth)} {currentYear}
            </h3>
            <button
              onClick={handleNextMonth}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <ChevronRight size={24} />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => downloadPlanJSON()}
              className="px-3 py-1 border border-gray-200 rounded-md hover:bg-gray-50 flex items-center gap-2 text-sm"
              title="Schichtplan (.json) herunterladen"
            >
              <Download size={14} /> Plan (.json)
            </button>
            <button
              onClick={() => downloadPlanXLSX()}
              className="px-3 py-1 border border-gray-200 rounded-md hover:bg-gray-50 flex items-center gap-2 text-sm"
              title="Schichtplan (.xlsx) herunterladen"
            >
              <Download size={14} /> Excel (.xlsx)
            </button>
            <button
              onClick={togglePlanRelease}
              disabled={releasing}
              className={`px-3 py-1 rounded-md flex items-center gap-2 text-sm font-medium transition-colors ${
                planReleased
                  ? 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700'
              }`}
              title={planReleased ? 'Freigabe aufheben' : 'Plan an Mitarbeitende freigeben'}
            >
              {planReleased ? <><Unlock size={14} /> Freigabe aufheben</> : <><Lock size={14} /> Freigeben</>}
            </button>

            {/* Violation pipeline badge */}
            {(shiftPlan?.violations?.length ?? 0) > 0 && (
              <button
                onClick={() => setShowPipeline(v => !v)}
                className="px-3 py-1 rounded-md flex items-center gap-2 text-sm font-medium bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200 transition-colors"
                title="Regelprobleme bei der Generierung anzeigen"
              >
                <AlertTriangle size={14} />
                {shiftPlan!.violations!.length} {shiftPlan!.violations!.length === 1 ? 'Problem' : 'Probleme'}
              </button>
            )}
          </div>
        </div>
        
        {/* Department Filter */}
        <div className="flex items-center gap-4 mb-4">
          <div className="flex items-center gap-2">
            <Filter size={20} className="text-gray-600" />
            <label className="text-sm font-medium text-gray-700">Abteilung:</label>
          </div>
          <select
            value={selectedDepartment}
            onChange={e => setSelectedDepartment(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="all">Alle Abteilungen</option>
            {departments.map(dept => (
              <option key={dept.id} value={dept.id}>{dept.name}</option>
            ))}
          </select>
        </div>
        
        {/* Legend */}
        <div className="flex gap-4 text-sm mb-4">
          <div className="flex items-center gap-2">
            <div className={`w-6 h-6 ${getShiftColor('fruehschicht')} rounded flex items-center justify-center font-semibold`}>
              F
            </div>
            <span>Frühschicht</span>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-6 h-6 ${getShiftColor('verschieben')} rounded flex items-center justify-center font-semibold`}>
              V
            </div>
            <span>Verschobene Schicht</span>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-6 h-6 ${getShiftColor('nachtbereitschaft')} rounded flex items-center justify-center font-semibold`}>
              N
            </div>
            <span>Nachtbereitschaft</span>
          </div>
        </div>
      </div>
      
      {filteredEmployees.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
          <p className="text-gray-600">Keine Mitarbeiter in dieser Abteilung.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-md overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-gray-100">
                  <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b-2 border-gray-300 sticky left-0 bg-gray-100 z-20 min-w-[150px]">
                    Mitarbeiter
                  </th>
                  {days.map((day, index) => {
                    const dayOfWeek = getDay(day); // 0=So .. 6=Sa
                    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                    const iso = format(day, 'yyyy-MM-dd');
                    const holidayName = holidayMap[iso];
                    const dowIndexMonFirst = (dayOfWeek + 6) % 7; // map 1->0 (Mo), 0->6 (So)

                    // detect assignment coverage mismatches (too few / too many assigned)
                    const assignmentsCovering = (shiftPlan?.assignments || []).filter(a => {
                      const aStart = startOfDay(new Date(a.startDate));
                      const aEnd = startOfDay(new Date(a.endDate));
                      const dayNorm = startOfDay(day);
                      return dayNorm >= aStart && dayNorm <= aEnd;
                    });

                    const mismatches = assignmentsCovering.map(a => {
                      // Use the config stored with the plan so warnings reflect the actual target counts
                      const required =
                        shiftPlan?.schedulerConfig?.shiftCounts[a.shiftType as keyof typeof shiftPlan.schedulerConfig.shiftCounts]
                        ?? SHIFT_REQUIREMENTS[a.shiftType]?.count
                        ?? 0;
                      const actual = (a.employees || []).length;
                      const diff = required - actual; // positive => missing, negative => excess
                      return { assignment: a, required, actual, diff };
                    }).filter(m => m.diff !== 0);

                    // Detect completely missing shift types (no assignment exists at all)
                    if (shiftPlan && (shiftPlan.assignments?.length ?? 0) > 0) {
                      const expectedTypes: ShiftType[] = (dayOfWeek >= 1 && dayOfWeek <= 5)
                        ? ['verschieben', 'nachtbereitschaft']
                        : ['fruehschicht', 'nachtbereitschaft'];
                      for (const st of expectedTypes) {
                        const covered = assignmentsCovering.some(a => a.shiftType === st);
                        if (!covered) {
                          const required = shiftPlan?.schedulerConfig?.shiftCounts[st] ?? SHIFT_REQUIREMENTS[st]?.count ?? 0;
                          if (required > 0) {
                            // Compute proper period dates for the missing shift type
                            let pStart: Date;
                            let pEnd: Date;
                            if (st === 'verschieben') {
                              pStart = startOfWeek(day, { weekStartsOn: 1 }); // Monday
                              pEnd = addDays(pStart, 4);                       // Friday
                            } else {
                              pStart = startOfWeek(day, { weekStartsOn: 6 }); // nearest Saturday
                              pEnd = st === 'nachtbereitschaft' ? addDays(pStart, 6) : addDays(pStart, 1);
                            }
                            // Stable deterministic ID so re-renders stay consistent
                            const synthId = `synth-${st}-${format(pStart, 'yyyy-MM-dd')}`;
                            mismatches.push({
                              assignment: { id: synthId, shiftType: st, startDate: pStart, endDate: pEnd, employees: [], confirmed: false } as ShiftAssignment,
                              required,
                              actual: 0,
                              diff: required,
                            });
                          }
                        }
                      }
                    }

                    const hasMismatch = mismatches.length > 0;

                    return (
                      <th 
                        key={index} 
                        className={`px-2 py-2 text-center font-semibold text-gray-700 border-b-2 border-gray-300 min-w-[50px] ${
                          isWeekend ? 'bg-blue-100' : ''
                        } ${holidayName ? 'bg-rose-100' : ''}`}
                      >
                        <div className="text-xs">{weekDayLabelsMon[dowIndexMonFirst]}</div>
                        <div className="text-sm">{format(day, 'd')}</div>

                        {/* Mismatch indicator: single ! badge opens a per-shift-type picker dropdown */}
                        {hasMismatch && (
                          <div className="mt-1 flex items-center justify-center relative">
                            <button
                              title={mismatches.map(m => {
                                const lbl = m.assignment.shiftType === 'fruehschicht' ? 'Frühschicht' : m.assignment.shiftType === 'verschieben' ? 'Tagdienst' : 'Nachtbereitschaft';
                                return `${lbl}: ${m.diff > 0 ? `fehlend ${m.diff}` : `zu viel ${-m.diff}`}`;
                              }).join('\n')}
                              onClick={(e) => {
                                e.stopPropagation();
                                setMismatchPickerDay(prev => prev && isSameDay(prev, day) ? null : day);
                              }}
                              className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-800 text-xs rounded border border-amber-100 hover:bg-amber-100"
                            >
                              <span className="font-semibold">!</span>
                              <span>{mismatches.reduce((acc, m) => acc + Math.abs(m.diff), 0)}</span>
                            </button>

                            {/* Dropdown: one row per affected shift type */}
                            {mismatchPickerDay && isSameDay(mismatchPickerDay, day) && (
                              <div
                                className="absolute top-full left-1/2 -translate-x-1/2 z-50 mt-1 bg-white rounded-lg shadow-xl border border-gray-200 min-w-[200px] py-1"
                                onClick={e => e.stopPropagation()}
                              >
                                <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
                                  Schicht bearbeiten
                                </div>
                                {mismatches.map((m, mi) => {
                                  const a = m.assignment;
                                  const label = a.shiftType === 'fruehschicht' ? 'Frühschicht' : a.shiftType === 'verschieben' ? 'Tagdienst' : 'Nachtbereitschaft';
                                  const isShort = m.diff > 0;
                                  return (
                                    <button
                                      key={mi}
                                      className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-left hover:bg-gray-50 transition-colors"
                                      onClick={() => {
                                        setEditingShift({ assignment: a as ShiftAssignment, date: day });
                                        setMismatchPickerDay(null);
                                      }}
                                    >
                                      <span className="font-medium text-gray-800">{label}</span>
                                      <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${
                                        isShort
                                          ? 'bg-amber-100 text-amber-800'
                                          : 'bg-rose-100 text-rose-700'
                                      }`}>
                                        {isShort ? `−${m.diff}` : `+${-m.diff}`}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // group filtered employees by department (sorted)
                  const groups: Array<{ id: string; name: string; employees: typeof filteredEmployees }> = [];

                  if (selectedDepartment === 'all') {
                    const deptMap = new Map<string, { id: string; name: string; employees: typeof filteredEmployees }>();
                    departments.forEach(d => deptMap.set(d.id, { id: d.id, name: d.name, employees: [] as any }));

                    const unknownGroup = { id: 'unknown', name: 'Unbekannt', employees: [] as any };

                    filteredEmployees.forEach(emp => {
                      const g = deptMap.get(emp.department);
                      if (g) g.employees.push(emp);
                      else unknownGroup.employees.push(emp);
                    });

                    deptMap.forEach(g => {
                      if (g.employees.length > 0) {
                        g.employees.sort((a, b) => a.name.localeCompare(b.name, 'de'));
                        groups.push(g);
                      }
                    });

                    if (unknownGroup.employees.length > 0) {
                      unknownGroup.employees.sort((a: any, b: any) => a.name.localeCompare(b.name, 'de'));
                      groups.push(unknownGroup);
                    }

                    // sort groups by department name
                    groups.sort((a, b) => a.name.localeCompare(b.name, 'de'));
                  } else {
                    const dept = departments.find(d => d.id === selectedDepartment);
                    const name = dept ? dept.name : 'Unbekannt';
                    const emps = filteredEmployees.slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
                    groups.push({ id: selectedDepartment, name, employees: emps as any });
                  }

                  // render grouped rows with department header
                  let rowCounter = 0;
                  return groups.map(group => (
                    <React.Fragment key={`grp-${group.id}`}>
                      <tr className="bg-gray-50">
                        <td className="sticky left-0 z-30 px-3 py-3 font-semibold text-gray-800 border-t-4 border-b-2 border-gray-200 bg-gradient-to-r from-white via-gray-50 to-white">
                          {group.name}
                        </td>
                        <td colSpan={days.length} className="border-t-4 border-b-2 border-gray-200 bg-gradient-to-r from-white via-gray-50 to-white" />
                      </tr>

                      {group.employees.map((employee: any) => {
                        const rowClass = rowCounter % 2 === 0 ? 'bg-white' : 'bg-gray-50';
                        rowCounter++;
                        return (
                          <tr key={employee.id} className={rowClass}>
                            <td className="px-3 py-2 border-b border-gray-200 sticky left-0 z-10 bg-inherit">
                              <div className="font-medium text-gray-800 text-sm">{employee.name}</div>
                              <div className="text-xs text-gray-600">{getDepartmentName(employee.department)}</div>
                              <div className="flex gap-1 mt-1">
                                {employee.isOver55 && (
                                  <span className="px-1 py-0.5 bg-amber-100 text-amber-800 rounded text-xs">Ü55</span>
                                )}
                                {employee.hasL2 && (
                                  <span className="px-1 py-0.5 bg-green-100 text-green-800 rounded text-xs">L2</span>
                                )}
                              </div>
                            </td>

                            {days.map((day, dayIndex) => {
                              const shifts = getShiftsForEmployeeOnDay(employee.id, day);
                              const dayOfWeek = getDay(day);
                              const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                              const isVacation = isDateInVacation(employee.id, day);
                              const iso = format(day, 'yyyy-MM-dd');
                              const holidayName = holidayMap[iso];
                              
                              // Get labels for this cell
                              const cellLabels = calendarLabels
                                .filter(cl => cl.employeeId === employee.id && cl.date === iso)
                                .map(cl => labels.find(l => l.id === cl.labelId))
                                .filter(Boolean);

                              return (
                                <td 
                                  key={dayIndex} 
                                  className={`border-b border-gray-200 p-1 ${isWeekend ? 'bg-blue-100/40' : ''} ${holidayName ? 'bg-rose-100/30' : ''}`}
                                >
                                  <div className="flex flex-col gap-0.5 min-h-[40px]">
                                    {isVacation ? (
                                      <div className="bg-orange-200 text-orange-800 text-xs px-1 py-0.5 rounded text-center font-medium">U</div>
                                    ) : (
                                      <>
                                        {/* Shifts */}
                                        {shifts.length > 0 && shifts.map((shift, shiftIndex) => (
                                          <div 
                                            key={shiftIndex}
                                            onClick={() => handleShiftClick(employee.id, day, shift)}
                                            className={`${getShiftColor(shift)} text-xs px-1 py-0.5 rounded text-center font-semibold cursor-pointer hover:opacity-80 transition-opacity flex items-center justify-center gap-0.5`}
                                            title={`${shift} - Klicken zum Bearbeiten`}
                                          >
                                            {getShiftLabel(shift)}
                                            <Edit2 size={8} className="opacity-60" />
                                          </div>
                                        ))}
                                        
                                        {/* Labels */}
                                        {cellLabels.length > 0 && cellLabels.map((label: any) => (
                                          <div
                                            key={label.id}
                                            onClick={() => setLabelModalData({ employeeId: employee.id, employeeName: employee.name, date: day })}
                                            className="text-xs px-1 py-0.5 rounded text-center font-semibold cursor-pointer hover:opacity-80 transition-opacity text-white flex items-center justify-center gap-0.5"
                                            style={{ backgroundColor: label.color }}
                                            title={`${label.name}${label.text ? ': ' + label.text : ''} - Klicken zum Bearbeiten`}
                                          >
                                            {label.letter}
                                            <Edit2 size={8} className="opacity-60" />
                                          </div>
                                        ))}
                                        
                                        {/* Empty placeholder */}
                                        {shifts.length === 0 && cellLabels.length === 0 && (
                                          <div 
                                            onClick={() => setLabelModalData({ employeeId: employee.id, employeeName: employee.name, date: day })}
                                            className="text-xs text-gray-300 text-center py-0.5 cursor-pointer hover:bg-gray-100 rounded transition-colors"
                                            title="Label hinzufügen"
                                          >
                                            -
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}

                      {/* subtle spacer after group to increase horizontal separation */}
                      <tr>
                        <td className="sticky left-0 z-20 bg-gray-50 h-2" />
                        <td colSpan={days.length} className="h-2 bg-gray-50" />
                      </tr>
                    </React.Fragment>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}
      
      {/* Statistics */}
      {filteredEmployees.length > 0 && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white rounded-lg shadow-md p-4">
            <h3 className="font-semibold text-gray-800 mb-2">Gesamtstatistik</h3>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Mitarbeiter:</span>
                <span className="font-semibold">{filteredEmployees.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Tage im Monat:</span>
                <span className="font-semibold">{days.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Zuweisungen:</span>
                <span className="font-semibold">{shiftPlan.assignments.length}</span>
              </div>
            </div>
          </div>
          
          <div className="bg-white rounded-lg shadow-md p-4">
            <h3 className="font-semibold text-gray-800 mb-2">Legende</h3>
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 bg-blue-500 rounded"></div>
                <span className="text-gray-600">F = Frühschicht</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 bg-purple-500 rounded"></div>
                <span className="text-gray-600">V = Verschobene Schicht</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 bg-indigo-600 rounded"></div>
                <span className="text-gray-600">N = Nachtbereitschaft</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 bg-orange-200 rounded"></div>
                <span className="text-gray-600">U = Urlaub</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 bg-rose-200 rounded"></div>
                <span className="text-gray-600">Feiertag (Berlin)</span>
              </div>
            </div>
          </div>
          
          <div className="bg-white rounded-lg shadow-md p-4">
            <h3 className="font-semibold text-gray-800 mb-2">Hinweis</h3>
            <p className="text-sm text-gray-600">
              Wochenenden sind blau hinterlegt. Mehrere Schichten pro Tag werden untereinander angezeigt.
            </p>
          </div>
        </div>
      )}
      
      {/* Edit Shift Modal */}
      {/* Backdrop to close the mismatch picker when clicking outside */}
      {mismatchPickerDay && (
        <div className="fixed inset-0 z-40" onClick={() => setMismatchPickerDay(null)} />
      )}

      {editingShift && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-gray-200 p-6 flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Schicht bearbeiten</h2>
                <p className="text-sm text-gray-600 mt-1">
                  {SHIFT_LABELS[editingShift.assignment.shiftType]} •{' '}
                  {format(new Date(editingShift.assignment.startDate), 'dd.MM.yyyy')} -{' '}
                  {format(new Date(editingShift.assignment.endDate), 'dd.MM.yyyy')}
                </p>
              </div>
              <button
                onClick={() => setEditingShift(null)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X size={24} className="text-gray-500" />
              </button>
            </div>
            
            <div className="p-6">
              <h3 className="font-semibold text-gray-900 mb-4">Mitarbeiter zuweisen/entfernen</h3>

              {/* In-modal override confirmation (replaces browser confirm) */}
              {overrideConfirm && (
                <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="font-semibold text-yellow-800">Warnung — Regelverletzung</div>
                      <div className="text-sm text-gray-700 mt-1">
                        {`Diese Zuweisung verstößt gegen: ${overrideConfirm.reasons.join(', ')}.`}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">Sie können die Regel ignorieren und die Zuweisung trotzdem durchführen.</div>
                    </div>
                    <div className="flex-shrink-0 flex items-center gap-2">
                      <button
                        onClick={() => setOverrideConfirm(null)}
                        className="px-3 py-1 border rounded-md text-sm"
                      >Abbrechen</button>
                      <button
                        onClick={() => {
                          applyAssignmentChange(overrideConfirm.employeeId);
                          setOverrideConfirm(null);
                        }}
                        className="px-3 py-1 bg-primary-600 text-white rounded-md text-sm"
                      >Trotzdem zuweisen</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Grouped, more readable employee selector: available / violators / excluded */}
              <div className="max-h-[60vh] overflow-auto pr-6">
                {(() => {
                  const assignmentStart = startOfDay(new Date(editingShift.assignment.startDate));
                  const assignmentEnd = endOfDay(new Date(editingShift.assignment.endDate));
                  const allAssignments = shiftPlan?.assignments || [];
                  const shiftType = editingShift.assignment.shiftType;
                  const rules = shiftPlan?.schedulerConfig?.rules ?? DEFAULT_SCHEDULER_CONFIG.rules;
                  const config = shiftPlan?.schedulerConfig ?? DEFAULT_SCHEDULER_CONFIG;

                  // Canonical list of OTHER assignments (excluding the one being edited)
                  const otherAssignments = allAssignments.filter(a => a.id !== editingShift.assignment.id);

                  // ── Use scheduler as single source of truth for eligibility ──
                  const schedulerEligibleIds = new Set(
                    getAvailableEmployeesSorted(
                      employees,
                      shiftType,
                      new Date(editingShift.assignment.startDate),
                      new Date(editingShift.assignment.endDate),
                      otherAssignments,
                      config,
                    ).map(e => e.id)
                  );

                  // enrich employees with metadata used for sorting/display
                  const enriched = employees.map(emp => {
                    const isAssigned = editingShift.assignment.employees.includes(emp.id);

                    const isOnVacation = (emp.vacationDays || []).some(v => {
                      const vac = startOfDay(new Date(v));
                      return isWithinInterval(vac, { start: assignmentStart, end: assignmentEnd });
                    }) || (emp.vacationRanges || []).some(r => {
                      const s = startOfDay(new Date(r.startDate));
                      const e = endOfDay(new Date(r.endDate));
                      return s <= assignmentEnd && e >= assignmentStart;
                    });

                    // Individual blocking checks — only for display badges, NOT for isEligible
                    const blockedFruehVerschAdj = rules.noFruehschichtAdjacentToVerschieben && (
                      shiftType === 'fruehschicht'
                        ? isBlockedFromFruehschichtDueToAdjacency(emp, editingShift.date, allAssignments)
                        : shiftType === 'verschieben'
                          ? isBlockedFromVerschiebenDueToAdjacentFruehschicht(emp, assignmentStart, new Date(editingShift.assignment.endDate), allAssignments)
                          : false
                    );
                    const blockedNachtAfterVerschieben = rules.noNachtAfterVerschieben
                      && shiftType === 'nachtbereitschaft'
                      && isBlockedFromNachtAfterVerschieben(emp, assignmentStart, allAssignments);
                    const blockedVerschiebenAfterNacht = rules.noVerschiebenAfterNacht
                      && shiftType === 'verschieben'
                      && isBlockedFromVerschiebenAfterNacht(emp, assignmentStart, allAssignments);
                    const blockedConsecVerschieben = rules.noConsecutiveVerschieben
                      && shiftType === 'verschieben'
                      && isBlockedFromConsecutiveVerschieben(emp, assignmentStart, allAssignments);
                    const blockedConsecNacht = rules.noConsecutiveNacht
                      && shiftType === 'nachtbereitschaft'
                      && isBlockedFromConsecutiveNacht(emp, assignmentStart, allAssignments);
                    const blockedConsecFrueh = rules.noConsecutiveFruehschicht
                      && shiftType === 'fruehschicht'
                      && isBlockedFromConsecutiveFruehschicht(emp, assignmentStart, allAssignments);

                    const blockedByAdjacency = blockedFruehVerschAdj || blockedNachtAfterVerschieben
                      || blockedVerschiebenAfterNacht || blockedConsecVerschieben
                      || blockedConsecNacht || blockedConsecFrueh;

                    const blockedByQualification = rules.over55AndNoL2OnlyVerschieben
                      && shiftType !== 'verschieben' && (emp.isOver55 || !emp.hasL2);

                    const assignmentDaysList = eachDayOfInterval({ start: assignmentStart, end: new Date(editingShift.assignment.endDate) });
                    const blockedByVacationBoundary = !isOnVacation
                      && rules.noWeekendAroundVacation
                      && assignmentDaysList.some(d => !canWorkOnDate(emp, d, true));

                    const blockedByAvoidance = rules.respectAvoidancePreferences
                      && assignmentDaysList.some(d => hasAvoidancePreference(emp, shiftType as ShiftType, d));

                    const adjacencyLabel = blockedFruehVerschAdj
                      ? (shiftType === 'fruehschicht' ? 'Gesperrt: angrenz. Schicht' : 'Gesperrt: angrenz. Frühschicht')
                      : blockedNachtAfterVerschieben ? 'Keine Nacht nach Verschieben'
                      : blockedVerschiebenAfterNacht ? 'Kein Verschieben nach Nacht'
                      : blockedConsecVerschieben    ? 'Aufeinandf. Verschieben'
                      : blockedConsecNacht          ? 'Aufeinandf. Nacht'
                      : blockedConsecFrueh          ? 'Aufeinandf. Frühschicht'
                      : '';

                    const hasOtherOverlapping = otherAssignments.some(a => {
                      if (!a.employees.includes(emp.id)) return false;
                      const aStart = new Date(a.startDate);
                      const aEnd = new Date(a.endDate);
                      return aStart <= assignmentEnd && aEnd >= assignmentStart;
                    });

                    const shiftCount = allAssignments.filter(a =>
                      a.shiftType === shiftType &&
                      a.employees.includes(emp.id)
                    ).length;

                    // ── SINGLE SOURCE OF TRUTH: scheduler determines eligibility ──
                    const isEligible = schedulerEligibleIds.has(emp.id);

                    const departmentHasCoverage = allAssignments.some(a => {
                      if (a.shiftType !== shiftType) return false;
                      const aStart = new Date(a.startDate);
                      const aEnd = new Date(a.endDate);
                      const overlaps = aStart <= assignmentEnd && aEnd >= assignmentStart;
                      return overlaps && a.employees.some(empId => employees.find(e => e.id === empId)?.department === emp.department);
                    });

                    return {
                      emp,
                      isAssigned,
                      isOnVacation,
                      blockedByVacationBoundary,
                      blockedByAdjacency,
                      adjacencyLabel,
                      blockedByQualification,
                      blockedByAvoidance,
                      hasOtherOverlapping,
                      shiftCount,
                      isEligible,
                      needsDept: !departmentHasCoverage,
                      recommended: false
                    };
                  });

                  // compute recommendation pool and min shift count
                  const recommendationPool = enriched.filter(e => e.isEligible && e.needsDept).length > 0
                    ? enriched.filter(e => e.isEligible && e.needsDept)
                    : enriched.filter(e => e.isEligible);

                  const minShiftCount = recommendationPool.length > 0 ? Math.min(...recommendationPool.map(e => e.shiftCount)) : 0;

                  // annotate recommended flag
                  enriched.forEach(e => { (e as any).recommended = e.isEligible && e.shiftCount === minShiftCount && recommendationPool.some(r => r.emp.id === e.emp.id); });

                  // sort the enriched list (keeps recommended at top within eligible)
                  enriched.sort((a, b) => {
                    const score = (x: any) => (x.recommended ? 0 : x.isAssigned ? 1 : x.isEligible ? 2 : x.blockedByQualification || x.blockedByAdjacency || x.hasOtherOverlapping || x.blockedByAvoidance || x.blockedByVacationBoundary ? 3 : 4);
                    const sa = score(a), sb = score(b);
                    if (sa !== sb) return sa - sb;
                    if (a.recommended !== b.recommended) return (a.recommended ? -1 : 1);
                    if (a.shiftCount !== b.shiftCount) return a.shiftCount - b.shiftCount;
                    return a.emp.name.localeCompare(b.emp.name, 'de');
                  });

                  // split into three clear groups for display
                  const available = enriched.filter(e => e.isEligible);
                  const violators = enriched.filter(e => !e.isOnVacation && !e.isEligible);
                  const excluded = enriched.filter(e => e.isOnVacation);

                  const renderCard = (item: any) => {
                    const { emp, isAssigned, isOnVacation, blockedByVacationBoundary, blockedByAdjacency, adjacencyLabel, blockedByQualification, blockedByAvoidance, hasOtherOverlapping, shiftCount, isEligible, needsDept } = item;
                    const hasLowShiftCount = item.recommended;

                    return (
                      <div
                        key={emp.id}
                        onClick={() => !isOnVacation && handleToggleEmployee(emp.id)}
                        className={`p-3 rounded-lg border-2 transition-all ${
                          isOnVacation
                            ? 'bg-gray-100 border-gray-300 cursor-not-allowed opacity-60'
                            : (blockedByAdjacency || blockedByQualification || hasOtherOverlapping || blockedByVacationBoundary || blockedByAvoidance)
                            ? 'bg-yellow-50 border-yellow-200 cursor-pointer opacity-90'
                            : isAssigned
                            ? 'bg-primary-50 border-primary-500 cursor-pointer hover:bg-primary-100'
                            : 'bg-white border-gray-200 cursor-pointer hover:border-primary-300 hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="font-medium text-gray-900">{emp.name}</div>
                            <div className="text-sm text-gray-600">{getDepartmentName(emp.department)}</div>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {emp.isOver55 && (<span className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded text-xs">Ü55</span>)}
                              {emp.hasL2 && (<span className="px-2 py-0.5 bg-green-100 text-green-800 rounded text-xs">L2</span>)}
                              {isOnVacation && (<span className="px-2 py-0.5 bg-orange-200 text-orange-800 rounded text-xs">Im Urlaub</span>)}
                              {blockedByVacationBoundary && !isOnVacation && (<span className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded text-xs">Kein WE um Urlaub</span>)}
                              {blockedByAdjacency && adjacencyLabel && (<span className="px-2 py-0.5 bg-red-100 text-red-800 rounded text-xs">{adjacencyLabel}</span>)}
                              {blockedByQualification && (<span className="px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded text-xs">Nur versch.</span>)}
                              {blockedByAvoidance && (<span className="px-2 py-0.5 bg-purple-100 text-purple-800 rounded text-xs">Vermeidet diese Schicht</span>)}

                              {hasOtherOverlapping && !isAssigned && (<span className="px-2 py-0.5 bg-red-100 text-red-800 rounded text-xs">Andere Schicht vorhanden</span>)}

                              {isEligible && needsDept && !hasOtherOverlapping && (<span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded text-xs font-medium">Abteilung verfügbar</span>)}

                              {isEligible && (<span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs">{shiftCount} {editingShift.assignment.shiftType === 'fruehschicht' ? 'Früh' : editingShift.assignment.shiftType === 'verschieben' ? 'Versch.' : 'Nacht'}</span>)}

                              {hasLowShiftCount && (employees.filter(e => e.id !== emp.id).length > 0) && (<span className="px-2 py-0.5 bg-indigo-100 text-indigo-800 rounded text-xs font-medium">⭐ Empfohlen</span>)}
                            </div>
                          </div>
                          <div>
                            {isAssigned && !isOnVacation && (<div className="bg-primary-600 text-white px-3 py-1 rounded-full text-sm font-medium">Zugewiesen</div>)}
                          </div>
                        </div>
                      </div>
                    );
                  };

                // render grouped columns
                return (
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <section>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className="text-sm font-semibold">Verfügbare Mitarbeiter</div>
                          <div className="text-xs text-gray-500">Direkt zuweisbar</div>
                        </div>
                        <div className="text-xs text-gray-400">{available.length}</div>
                      </div>
                      <div className="space-y-3">
                        {available.length > 0 ? available.map(item => renderCard(item)) : <div className="text-xs text-gray-400">Keine verfügbaren Mitarbeiter.</div>}
                      </div>
                    </section>

                    <section>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className="text-sm font-semibold">Regelverletzer (override möglich)</div>
                          <div className="text-xs text-gray-500">Können zugewiesen werden — Warnung sichtbar</div>
                        </div>
                        <div className="text-xs text-gray-400">{violators.length}</div>
                      </div>
                      <div className="space-y-3">
                        {violators.length > 0 ? violators.map(item => renderCard(item)) : <div className="text-xs text-gray-400">Keine Regelverletzer.</div>}
                      </div>
                    </section>

                    <section>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className="text-sm font-semibold">Nicht verfügbar</div>
                          <div className="text-xs text-gray-500">Im Urlaub oder ausgeschlossen</div>
                        </div>
                        <div className="text-xs text-gray-400">{excluded.length}</div>
                      </div>
                      <div className="space-y-3">
                        {excluded.length > 0 ? excluded.map(item => renderCard(item)) : <div className="text-xs text-gray-400">Keine ausgeschlossenen Mitarbeiter.</div>}
                      </div>
                    </section>
                  </div>
                );

                })()}
              </div>
              
              <div className="mt-6 flex justify-end items-center pt-4 border-t">
                <div className="flex gap-3">
                  <button
                    onClick={() => setEditingShift(null)}
                    className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                  >
                    Abbrechen
                  </button>
                  <button
                    onClick={() => setEditingShift(null)}
                    className="px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 transition-colors"
                  >
                    Fertig
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Label Modal */}
      {labelModalData && (
        <LabelModal
          employeeId={labelModalData.employeeId}
          employeeName={labelModalData.employeeName}
          date={labelModalData.date}
          onClose={() => setLabelModalData(null)}
        />
      )}

      {/* Violation Pipeline */}
      {showPipeline && (shiftPlan?.violations?.length ?? 0) > 0 && (
        <ViolationPipeline
          violations={shiftPlan!.violations!}
          employees={employees}
          onAcknowledge={(id) => acknowledgeViolation(id)}
          onClose={() => setShowPipeline(false)}
          onView={(v) => {
            // Jump to the month of the violation
            const vDate = new Date(v.startDate);
            const targetMonth = vDate.getMonth();
            const targetYear = vDate.getFullYear();
            if (targetYear !== currentYear) setCurrentYear(targetYear);
            setCurrentMonth(targetMonth);
            setShowPipeline(false);
          }}
        />
      )}
    </div>
  );
}
