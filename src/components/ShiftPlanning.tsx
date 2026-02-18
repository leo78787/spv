import React, { useState } from 'react';
import { Calendar, Users, AlertCircle, Sparkles, Download } from 'lucide-react';
import { useStore } from '../store';
import { generateAutomaticShiftPlan } from '../utils/scheduler';
import { SHIFT_LABELS } from '../types';
import { getMonthName, generateId, reviveImportedPlan } from '../utils/helpers';

export function ShiftPlanning() {
  const { employees, departments, shiftPlan, createShiftPlan, addEmployee, addDepartment, setShiftPlan, updateShiftAssignment, addLabel, addCalendarLabel } = useStore();
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number>(0); // 0 = Januar
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationResult, setGenerationResult] = useState<{
    success: boolean;
    message: string;
    assignmentCount: number;
  } | null>(null);

  const handleGenerateFullPlan = () => {
    if (employees.length === 0) {
      setGenerationResult({
        success: false,
        message: 'Keine Mitarbeiter vorhanden. Bitte fügen Sie zuerst Mitarbeiter hinzu.',
        assignmentCount: 0
      });
      return;
    }

    setIsGenerating(true);
    setGenerationResult(null);

    // Simulate async operation for better UX
    setTimeout(() => {
      try {
        const assignments = generateAutomaticShiftPlan(employees, selectedYear, selectedMonth, 12);
        
        // Remove any existing plan for the selected start year/month, then store new assignments
        createShiftPlan(selectedYear, selectedMonth, 12);
        assignments.forEach(assignment => updateShiftAssignment(assignment));

        const end = new Date(selectedYear, selectedMonth + 12, 0); // last day of 12-month period

        setGenerationResult({
          success: true,
          message: `Schichtplan erfolgreich generiert für ${getMonthName(selectedMonth)} ${selectedYear} — ${getMonthName(end.getMonth())} ${end.getFullYear()}`,
          assignmentCount: assignments.length
        });
      } catch (error) {
        setGenerationResult({
          success: false,
          message: 'Fehler beim Generieren des Schichtplans.',
          assignmentCount: 0
        });
      } finally {
        setIsGenerating(false);
      }
    }, 500);
  };

  const planStart = new Date(selectedYear, selectedMonth, 1);
  const planEnd = new Date(selectedYear, selectedMonth + 12, 0); // last day of the 12-month range

  const currentYearAssignments = shiftPlan?.assignments.filter((assignment) => {
    const aStart = new Date(assignment.startDate);
    return aStart >= planStart && aStart <= planEnd;
  }) || [];

  const assignmentsByType = {
    nachtbereitschaft: currentYearAssignments.filter((a) => a.shiftType === 'nachtbereitschaft').length,
    verschieben: currentYearAssignments.filter((a) => a.shiftType === 'verschieben').length,
    fruehschicht: currentYearAssignments.filter((a) => a.shiftType === 'fruehschicht').length,
  };

  const planFileRef = React.useRef<HTMLInputElement | null>(null);

  const onPlanFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;

    try {
      const text = await f.text();
      const parsed = JSON.parse(text);
      const revived = reviveImportedPlan(parsed);
      if (!revived) {
        alert('Ungültige Plan‑Datei. Bitte eine zuvor exportierte Schichtplan‑JSON verwenden.');
        return;
      }

      // departments: create if missing (match by name, case-insensitive)
      const deptMap: Record<string, string> = {};
      revived.departments.forEach((d: any) => {
        const existing = departments.find(x => x.name.toLowerCase().trim() === d.name.toLowerCase().trim());
        if (existing) deptMap[d.id] = existing.id;
        else {
          const newDept = { id: `dept-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, name: d.name };
          addDepartment(newDept);
          deptMap[d.id] = newDept.id;
        }
      });

      // employees: add missing, map imported id -> actual id (match by name)
      const empMap: Record<string, string> = {};
      revived.employees.forEach((ie: any) => {
        const existingEmp = employees.find(e => e.name.toLowerCase().trim() === ie.name.toLowerCase().trim());
        if (existingEmp) {
          empMap[ie.id] = existingEmp.id;
        } else {
          const newEmp = {
            id: generateId(),
            name: ie.name,
            department: deptMap[ie.department] || departments[0]?.id || '',
            isOver55: !!ie.isOver55,
            hasL2: !!ie.hasL2,
            vacationDays: (ie.vacationDays || []).map((d: any) => new Date(d)),
            vacationRanges: (ie.vacationRanges || []).map((r: any) => ({ startDate: new Date(r.startDate), endDate: new Date(r.endDate) })),
            preferences: (ie.preferences || []).map((p: any) => ({ ...p, startDate: new Date(p.startDate), endDate: new Date(p.endDate) }))
          } as any;
          addEmployee(newEmp);
          empMap[ie.id] = newEmp.id;
        }
      });

      // assignments: remap employee ids and ensure dates are Date objects
      const importedPlan = revived.shiftPlan;
      const mappedAssignments = (importedPlan.assignments || []).map((a: any) => ({
        ...a,
        startDate: new Date(a.startDate),
        endDate: new Date(a.endDate),
        employees: (a.employees || []).map((id: string) => empMap[id] || id)
      }));

      const finalPlan = { ...importedPlan, assignments: mappedAssignments };

      setShiftPlan(finalPlan as any);
      
      // Import labels if present
      if (revived.labels && Array.isArray(revived.labels)) {
        revived.labels.forEach((label: any) => {
          addLabel({
            id: label.id || `label-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            name: label.name || '',
            letter: label.letter || '',
            color: label.color || '#3b82f6',
            text: label.text || ''
          });
        });
      }
      
      // Import calendar labels if present (remap employee IDs)
      if (revived.calendarLabels && Array.isArray(revived.calendarLabels)) {
        revived.calendarLabels.forEach((cl: any) => {
          addCalendarLabel({
            id: cl.id || `clabel-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            employeeId: empMap[cl.employeeId] || cl.employeeId,
            date: cl.date,
            labelId: cl.labelId
          });
        });
      }
      
      alert(`Schichtplan importiert: ${mappedAssignments.length} Zuweisungen, ${revived.employees.length} Mitarbeiter, ${revived.departments.length} Abteilungen (neu hinzugefügt falls nötig).`);
    } catch (err) {
      console.error(err);
      alert('Fehler beim Einlesen der Datei. Bitte prüfen Sie das Format.');
    } finally {
      if (planFileRef.current) planFileRef.current.value = '';
    }
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Automatische Schichtplanung</h2>
            <p className="text-gray-600">
              Generieren Sie den kompletten Schichtplan für das Jahr mit einem Klick
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Calendar className="h-12 w-12 text-primary-600" />
            <div>
              <button onClick={() => planFileRef.current?.click()} className="text-sm px-3 py-1 border border-gray-200 rounded-md hover:bg-gray-50 flex items-center gap-2">
                <Download size={14} /> Plan importieren (.json)
              </button>
              <input ref={planFileRef} type="file" accept="application/json,.json" onChange={onPlanFileChange} className="hidden" />
            </div>
          </div>
        </div>
      </div>

      {/* Year Selection & Generate */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Startjahr</label>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
                className="w-full md:w-64 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {[2024, 2025, 2026, 2027, 2028].map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Startmonat</label>
              <select
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(Number(e.target.value))}
                className="w-full md:w-48 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {Array.from({ length: 12 }).map((_, i) => (
                  <option key={i} value={i}>{getMonthName(i)}</option>
                ))}
              </select>
            </div>
          </div>

          <button
            onClick={handleGenerateFullPlan}
            disabled={isGenerating || employees.length === 0}
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:bg-gray-300 disabled:cursor-not-allowed font-medium text-lg"
          >
            <Sparkles className="h-5 w-5" />
            {isGenerating ? 'Generiere Schichtplan...' : 'Schichtplan generieren'}
          </button>

          {employees.length === 0 && (
            <div className="flex items-start gap-2 text-amber-600 bg-amber-50 p-3 rounded-md">
              <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <p className="text-sm">
                Bitte fügen Sie zuerst Mitarbeiter hinzu, bevor Sie einen Schichtplan generieren.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Generation Result */}
      {generationResult && (
        <div className={`rounded-lg p-6 ${
          generationResult.success 
            ? 'bg-green-50 border border-green-200' 
            : 'bg-red-50 border border-red-200'
        }`}>
          <div className="flex items-start gap-3">
            <div className={`flex-shrink-0 ${
              generationResult.success ? 'text-green-600' : 'text-red-600'
            }`}>
              {generationResult.success ? (
                <Sparkles className="h-6 w-6" />
              ) : (
                <AlertCircle className="h-6 w-6" />
              )}
            </div>
            <div>
              <h3 className={`font-medium mb-1 ${
                generationResult.success ? 'text-green-900' : 'text-red-900'
              }`}>
                {generationResult.message}
              </h3>
              {generationResult.success && (
                <p className="text-green-700 text-sm">
                  {generationResult.assignmentCount} Schichtzuweisungen wurden erstellt.
                  Sie können diese jetzt im Kalender ansehen und bearbeiten.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Current Plan Overview */}
      {currentYearAssignments.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Users className="h-5 w-5" />
            Aktueller Schichtplan für {getMonthName(selectedMonth)} {selectedYear} — {getMonthName(planEnd.getMonth())} {planEnd.getFullYear()}
          </h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-indigo-50 rounded-lg p-4">
              <div className="text-indigo-900 font-medium mb-1">
                {SHIFT_LABELS.nachtbereitschaft}
              </div>
              <div className="text-2xl font-bold text-indigo-700">
                {assignmentsByType.nachtbereitschaft}
              </div>
              <div className="text-sm text-indigo-600">Schichten</div>
            </div>

            <div className="bg-purple-50 rounded-lg p-4">
              <div className="text-purple-900 font-medium mb-1">
                {SHIFT_LABELS.verschieben}
              </div>
              <div className="text-2xl font-bold text-purple-700">
                {assignmentsByType.verschieben}
              </div>
              <div className="text-sm text-purple-600">Schichten</div>
            </div>

            <div className="bg-blue-50 rounded-lg p-4">
              <div className="text-blue-900 font-medium mb-1">
                {SHIFT_LABELS.fruehschicht}
              </div>
              <div className="text-2xl font-bold text-blue-700">
                {assignmentsByType.fruehschicht}
              </div>
              <div className="text-sm text-blue-600">Schichten</div>
            </div>
          </div>

          <div className="mt-4 p-3 bg-blue-50 rounded-md">
            <p className="text-sm text-blue-800">
              💡 <strong>Tipp:</strong> Wechseln Sie zum Kalender-Reiter, um die Schichtzuweisungen anzusehen und bei Bedarf anzupassen.
            </p>
          </div>
        </div>
      )}

      {/* Information Box */}
      <div className="bg-gray-50 rounded-lg p-6 border border-gray-200">
        <h3 className="font-semibold text-gray-900 mb-3">ℹ️ So funktioniert die automatische Planung</h3>
        <ul className="space-y-2 text-sm text-gray-700">
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">1.</span>
            <span><strong>Verschobene Schichten</strong> werden zuerst verteilt - <strong>exakt 4 Personen</strong> pro Woche (Mo-Fr); dadurch wird verhindert, dass danach direkt eine Nachtwoche folgt.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">2.</span>
            <span><strong>Nachtschichten</strong> werden danach verteilt - <strong>exakt 2 Personen</strong> pro Woche (Sa-Sa)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">3.</span>
            <span><strong>Wochenendschichten</strong> werden zuletzt verteilt - <strong>exakt 3 Personen</strong> pro Wochenende (Sa-So)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span><strong>Jeder Mitarbeiter bekommt maximal eine Schicht pro Tag</strong></span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Mitarbeiter im Urlaub werden automatisch übersprungen</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Nachtschichtwoche → keine `Frühschicht` direkt am folgenden Wochenende</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Nach einer `Verschobene Schicht`-Woche darf nicht direkt im Anschluss eine `Nachtbereitschaft` folgen</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Mitarbeiter Ü55 und Mitarbeiter ohne L2-Zertifikat dürfen nur <strong>verschobene Schichten</strong> (Mo–Fr) erhalten</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Vermeidungspräferenzen werden berücksichtigt</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span><strong>Wichtig:</strong> Kein Wochenenddienst vor oder nach Urlaub</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Mitarbeiter mit einer <strong>verschobenen Schicht</strong> dürfen keine Wochenend-<strong>Frühschicht</strong> am davor/danachliegenden Wochenende erhalten</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Abteilungen werden möglichst gleichmäßig verteilt</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Mitarbeiter ohne Schicht bleiben für diese Zeit frei</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
