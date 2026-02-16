import { useState } from 'react';
import { useStore } from '../store';
import { ShiftType, ShiftAssignment, SHIFT_LABELS } from '../types';
import { getMonthName } from '../utils/helpers';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, Filter, Edit2, X } from 'lucide-react';
import { isBlockedFromFruehschichtDueToAdjacency, isBlockedFromNachtAfterVerschieben } from '../utils/scheduler';
import { 
  startOfMonth, 
  endOfMonth,
  eachDayOfInterval,
  format,
  isSameDay,
  getDay,
  addDays
} from 'date-fns';

export function CalendarView() {
  const { 
    employees, 
    departments, 
    currentYear, 
    shiftPlan,
    updateShiftAssignment,
    deleteShiftAssignment
  } = useStore();
  
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth());
  const [selectedDepartment, setSelectedDepartment] = useState<string>('all');
  const [editingShift, setEditingShift] = useState<{
    assignment: ShiftAssignment;
    date: Date;
  } | null>(null);

  // State for in-modal override confirmation (replaces browser confirm)
  const [overrideConfirm, setOverrideConfirm] = useState<{
    employeeId: string;
    reasons: string[];
  } | null>(null);
  
  const handlePreviousMonth = () => {
    setCurrentMonth(prev => (prev === 0 ? 11 : prev - 1));
  };
  
  const handleNextMonth = () => {
    setCurrentMonth(prev => (prev === 11 ? 0 : prev + 1));
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
      
      const assignmentStart = new Date(assignment.startDate);
      const assignmentEnd = new Date(assignment.endDate);
      
      // Check if date falls within assignment period
      if (date >= assignmentStart && date <= assignmentEnd) {
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
      
      const start = new Date(a.startDate);
      const end = new Date(a.endDate);
      
      return date >= start && date <= end;
    });
    
    return assignment || null;
  };
  
  // Handle clicking on a shift to edit it
  const handleShiftClick = (_employeeId: string, date: Date, shiftType: ShiftType) => {
    const assignment = getAssignmentForDate(shiftType, date);
    if (assignment) {
      setEditingShift({ assignment, date });
    }
  };

  // Check if employee is blocked from being assigned in the editing context
  const isBlockedByAdjacentVerschieben = (empId: string) => {
    if (!shiftPlan || !editingShift) return false;

    // If editing a weekend early shift -> block employees who have 'verschieben'
    // immediately before or after that weekend.
    if (editingShift.assignment.shiftType === 'fruehschicht') {
      const saturday = new Date(editingShift.assignment.startDate);

      return shiftPlan.assignments.some(a => {
        if (a.shiftType !== 'verschieben') return false;
        if (!a.employees.includes(empId)) return false;

        const vStart = new Date(a.startDate);
        const vEnd = new Date(a.endDate);

        const saturdayBefore = addDays(vStart, -2);
        const saturdayAfter = addDays(vEnd, 1);

        return isSameDay(saturday, saturdayBefore) || isSameDay(saturday, saturdayAfter);
      });
    }

    // If editing a verschobene Schicht -> block employees who already have a weekend early
    // immediately before/after that verschobene period.
    if (editingShift.assignment.shiftType === 'verschieben') {
      const vStart = new Date(editingShift.assignment.startDate);
      const vEnd = new Date(editingShift.assignment.endDate);

      const saturdayBefore = addDays(vStart, -2);
      const saturdayAfter = addDays(vEnd, 1);

      return shiftPlan.assignments.some(a => {
        if (a.shiftType !== 'fruehschicht') return false;
        if (!a.employees.includes(empId)) return false;

        const frStart = new Date(a.startDate);
        return isSameDay(frStart, saturdayBefore) || isSameDay(frStart, saturdayAfter);
      });
    }

    return false;
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

    const blocked = editingShift.assignment.shiftType === 'fruehschicht'
      ? isBlockedFromFruehschichtDueToAdjacency(empObj, editingShift.date, shiftPlan?.assignments || [])
      : editingShift.assignment.shiftType === 'verschieben'
        ? isBlockedByAdjacentVerschieben(employeeId)
        : editingShift.assignment.shiftType === 'nachtbereitschaft'
          ? isBlockedFromNachtAfterVerschieben(empObj, new Date(editingShift.assignment.startDate), shiftPlan?.assignments || [])
          : false;

    const blockedByQualification = editingShift.assignment.shiftType !== 'verschieben' && (empObj.isOver55 || !empObj.hasL2);

    // Vacation always blocks
    const isEmpOnVacation = empObj.vacationDays.some(vacDay => {
      const vac = new Date(vacDay);
      const start = new Date(editingShift.assignment.startDate);
      const end = new Date(editingShift.assignment.endDate);
      return vac >= start && vac <= end;
    });
    if (isEmpOnVacation) return;

    if (blocked || blockedByQualification) {
      const reasons: string[] = [];

      // Specific adjacency reasons
      if (blocked) {
        if (editingShift.assignment.shiftType === 'fruehschicht') {
          // determine whether it's adjacency to verschieben or recent night-week
          const saturday = new Date(editingShift.assignment.startDate);
          const hasVerschAdj = (shiftPlan?.assignments || []).some(a => {
            if (a.shiftType !== 'verschieben') return false;
            if (!a.employees.includes(empObj.id)) return false;
            const vStart = new Date(a.startDate);
            const vEnd = new Date(a.endDate);
            const saturdayBefore = addDays(vStart, -2);
            const saturdayAfter = addDays(vEnd, 1);
            return isSameDay(saturday, saturdayBefore) || isSameDay(saturday, saturdayAfter);
          });
          const hasRecentNight = (shiftPlan?.assignments || []).some(a => {
            if (a.shiftType !== 'nachtbereitschaft') return false;
            if (!a.employees.includes(empObj.id)) return false;
            const end = new Date(a.endDate);
            return isSameDay(saturday, end) || isSameDay(saturday, addDays(end, 1));
          });

          if (hasVerschAdj) reasons.push('Keine Wochenend‑Frühschicht — angrenzende verschobene Schicht');
          else if (hasRecentNight) reasons.push('Keine Wochenend‑Frühschicht direkt nach Nachtwoche');
          else reasons.push('Zeitliche Nähe zu anderen Schichten');
        } else if (editingShift.assignment.shiftType === 'verschieben') {
          reasons.push('Konflikt: Frühschicht am angrenzenden Wochenende');
        } else if (editingShift.assignment.shiftType === 'nachtbereitschaft') {
          reasons.push('Keine Nachtwoche direkt nach einer Verschobenen (Mo–Fr) Woche');
        } else {
          reasons.push('Regelkonflikt (zeitliche Nähe)');
        }
      }

      // Qualification reasons (clear messages)
      if (blockedByQualification) {
        if (empObj.isOver55 && !empObj.hasL2) {
          reasons.push('Ü55 und kein L2 — nur verschobene Schichten erlaubt');
        } else if (empObj.isOver55) {
          reasons.push('Ü55 — nur verschobene Schichten erlaubt');
        } else if (!empObj.hasL2) {
          reasons.push('Keine L2 — nur verschobene Schichten erlaubt');
        } else {
          reasons.push('Qualifikationsregel verletzt');
        }
      }

      setOverrideConfirm({ employeeId, reasons });
      return; // wait for in-modal confirmation
    }

    // No block — assign
    applyAssignmentChange(employeeId);
  };
  
  // Delete entire shift assignment
  const handleDeleteShift = () => {
    if (!editingShift) return;
    
    if (confirm('Möchten Sie diese Schicht wirklich löschen?')) {
      deleteShiftAssignment(editingShift.assignment.id);
      setEditingShift(null);
    }
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
  
  const days = getDaysInMonth();
  const weekDayLabels = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  
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
          <div className="w-[100px]"></div>
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
                    const dayOfWeek = getDay(day);
                    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                    return (
                      <th 
                        key={index} 
                        className={`px-2 py-2 text-center font-semibold text-gray-700 border-b-2 border-gray-300 min-w-[50px] ${
                          isWeekend ? 'bg-blue-50' : ''
                        }`}
                      >
                        <div className="text-xs">{weekDayLabels[dayOfWeek]}</div>
                        <div className="text-sm">{format(day, 'd')}</div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {filteredEmployees.map((employee, empIndex) => (
                  <tr 
                    key={employee.id}
                    className={empIndex % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                  >
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
                      const isVacation = employee.vacationDays.some(vacDay => 
                        isSameDay(new Date(vacDay), day)
                      );
                      
                      return (
                        <td 
                          key={dayIndex} 
                          className={`border-b border-gray-200 p-1 ${isWeekend ? 'bg-blue-50/30' : ''}`}
                        >
                          <div className="flex flex-col gap-0.5 min-h-[40px]">
                            {isVacation ? (
                              <div className="bg-orange-200 text-orange-800 text-xs px-1 py-0.5 rounded text-center font-medium">
                                U
                              </div>
                            ) : shifts.length > 0 ? (
                              shifts.map((shift, shiftIndex) => (
                                <div 
                                  key={shiftIndex}
                                  onClick={() => handleShiftClick(employee.id, day, shift)}
                                  className={`${getShiftColor(shift)} text-xs px-1 py-0.5 rounded text-center font-semibold cursor-pointer hover:opacity-80 transition-opacity flex items-center justify-center gap-0.5`}
                                  title={`${shift} - Klicken zum Bearbeiten`}
                                >
                                  {getShiftLabel(shift)}
                                  <Edit2 size={8} className="opacity-60" />
                                </div>
                              ))
                            ) : (
                              <div className="text-xs text-gray-300 text-center py-0.5">-</div>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
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
      {editingShift && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
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

              <div className="space-y-2 max-h-96 overflow-y-auto">
                {employees.map(emp => {
                  const isAssigned = editingShift.assignment.employees.includes(emp.id);
                  const isOnVacation = emp.vacationDays.some(vacDay => {
                    const vac = new Date(vacDay);
                    const start = new Date(editingShift.assignment.startDate);
                    const end = new Date(editingShift.assignment.endDate);
                    return vac >= start && vac <= end;
                  });

                  const blockedByAdjacency = editingShift.assignment.shiftType === 'fruehschicht'
                    ? isBlockedFromFruehschichtDueToAdjacency(emp, editingShift.date, shiftPlan?.assignments || [])
                    : editingShift.assignment.shiftType === 'verschieben'
                      ? isBlockedByAdjacentVerschieben(emp.id)
                      : editingShift.assignment.shiftType === 'nachtbereitschaft'
                        ? isBlockedFromNachtAfterVerschieben(emp, new Date(editingShift.assignment.startDate), shiftPlan?.assignments || [])
                        : false;

                  // Qualification rule: Ü55 or no L2 may only be assigned to 'verschieben'
                  const blockedByQualification = editingShift.assignment.shiftType !== 'verschieben' && (emp.isOver55 || !emp.hasL2);

                  // Calculate recommendation indicators
                  const shiftCount = (shiftPlan?.assignments || []).filter(a => 
                    a.shiftType === editingShift.assignment.shiftType && 
                    a.employees.includes(emp.id)
                  ).length;

                  // Check if employee's department needs this shift in this period
                  const assignmentStart = new Date(editingShift.assignment.startDate);
                  const assignmentEnd = new Date(editingShift.assignment.endDate);
                  const deptHasShiftInPeriod = (shiftPlan?.assignments || []).some(a => {
                    if (a.id === editingShift.assignment.id) return false; // Exclude current assignment
                    if (a.shiftType !== editingShift.assignment.shiftType) return false;
                    const aStart = new Date(a.startDate);
                    const aEnd = new Date(a.endDate);
                    const overlaps = aStart <= assignmentEnd && aEnd >= assignmentStart;
                    return overlaps && a.employees.some(empId => {
                      const e = employees.find(e => e.id === empId);
                      return e?.department === emp.department;
                    });
                  });

                  // Determine if this is a good candidate (eligible + low shift count)
                  const shiftCountForEmployee = (employeeId: string) =>
                    (shiftPlan?.assignments || []).filter(a =>
                      a.shiftType === editingShift.assignment.shiftType &&
                      a.employees.includes(employeeId)
                    ).length;

                  const isEligible = !isOnVacation && !blockedByAdjacency && !blockedByQualification;

                  const eligibleEmployees = employees.filter(e => {
                    const vac = e.vacationDays.some(vacDay => {
                      const v = new Date(vacDay);
                      const start = new Date(editingShift.assignment.startDate);
                      const end = new Date(editingShift.assignment.endDate);
                      return v >= start && v <= end;
                    });
                    if (vac) return false;
                    const qual = editingShift.assignment.shiftType !== 'verschieben' && (e.isOver55 || !e.hasL2);
                    if (qual) return false;
                    const adj = editingShift.assignment.shiftType === 'fruehschicht'
                      ? isBlockedFromFruehschichtDueToAdjacency(e, editingShift.date, shiftPlan?.assignments || [])
                      : editingShift.assignment.shiftType === 'verschieben'
                        ? isBlockedByAdjacentVerschieben(e.id)
                        : editingShift.assignment.shiftType === 'nachtbereitschaft'
                          ? isBlockedFromNachtAfterVerschieben(e, new Date(editingShift.assignment.startDate), shiftPlan?.assignments || [])
                          : false;
                    return !adj;
                  });

                  // Helper: does department already have coverage for this shift type in the period?
                  const departmentHasCoverage = (deptId: string) => {
                    return (shiftPlan?.assignments || []).some(a => {
                      if (a.id === editingShift.assignment.id) return false; // exclude current assignment
                      if (a.shiftType !== editingShift.assignment.shiftType) return false;
                      const aStart = new Date(a.startDate);
                      const aEnd = new Date(a.endDate);
                      const overlaps = aStart <= assignmentEnd && aEnd >= assignmentStart;
                      return overlaps && a.employees.some(empId => {
                        const e = employees.find(x => x.id === empId);
                        return e?.department === deptId;
                      });
                    });
                  };

                  // Prefer candidates from departments that DO NOT yet have coverage in the period
                  const candidatesNoDeptCoverage = eligibleEmployees.filter(e => !departmentHasCoverage(e.department));
                  const recommendationPool = candidatesNoDeptCoverage.length > 0 ? candidatesNoDeptCoverage : eligibleEmployees;

                  const minShiftCount = recommendationPool.length > 0
                    ? Math.min(...recommendationPool.map(e => shiftCountForEmployee(e.id)))
                    : 0;

                  const hasLowShiftCount = isEligible && shiftCount === minShiftCount && recommendationPool.some(r => r.id === emp.id);

                  return (
                    <div
                      key={emp.id}
onClick={() => !isOnVacation && handleToggleEmployee(emp.id)}
                      className={`p-3 rounded-lg border-2 transition-all ${
                        isOnVacation
                          ? 'bg-gray-100 border-gray-300 cursor-not-allowed opacity-50'
                          : (blockedByAdjacency || blockedByQualification)
                          ? 'bg-yellow-50 border-yellow-200 cursor-pointer opacity-80'
                          : isAssigned
                          ? 'bg-primary-50 border-primary-500 cursor-pointer hover:bg-primary-100'
                          : 'bg-white border-gray-200 cursor-pointer hover:border-primary-300 hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-medium text-gray-900">{emp.name}</div>
                          <div className="text-sm text-gray-600">
                            {getDepartmentName(emp.department)}
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {emp.isOver55 && (
                              <span className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded text-xs">Ü55</span>
                            )}
                            {emp.hasL2 && (
                              <span className="px-2 py-0.5 bg-green-100 text-green-800 rounded text-xs">L2</span>
                            )}
                            {isOnVacation && (
                              <span className="px-2 py-0.5 bg-orange-200 text-orange-800 rounded text-xs">Im Urlaub</span>
                            )}
                            {blockedByAdjacency && (
                              <span className="px-2 py-0.5 bg-red-100 text-red-800 rounded text-xs">
                                {editingShift.assignment.shiftType === 'fruehschicht' ? 'Gesperrt: angrenzende Schicht' : editingShift.assignment.shiftType === 'verschieben' ? 'Konflikt: Wochenende' : 'Konflikt: zeitliche Nähe'}
                              </span>
                            )}
                            {blockedByQualification && (
                              <span className="px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded text-xs">Nur versch.</span>
                            )}
                            {/* Recommendation indicators */}
                            {isEligible && !deptHasShiftInPeriod && (
                              <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded text-xs font-medium">
                                🎯 Abteilung benötigt
                              </span>
                            )}
                            {isEligible && (
                              <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs">
                                {shiftCount} {editingShift.assignment.shiftType === 'fruehschicht' ? 'Früh' : editingShift.assignment.shiftType === 'verschieben' ? 'Versch.' : 'Nacht'}
                              </span>
                            )}
                            {hasLowShiftCount && eligibleEmployees.length > 1 && (
                              <span className="px-2 py-0.5 bg-indigo-100 text-indigo-800 rounded text-xs font-medium">
                                ⭐ Empfohlen
                              </span>
                            )}
                          </div>
                        </div>
                        <div>
                          {isAssigned && !isOnVacation && (
                            <div className="bg-primary-600 text-white px-3 py-1 rounded-full text-sm font-medium">
                              Zugewiesen
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              
              <div className="mt-6 flex justify-between items-center pt-4 border-t">
                <button
                  onClick={handleDeleteShift}
                  className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
                >
                  Schicht löschen
                </button>
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
    </div>
  );
}
