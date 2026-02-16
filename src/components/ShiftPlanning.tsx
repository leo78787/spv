import { useState } from 'react';
import { Calendar, Users, AlertCircle, Sparkles } from 'lucide-react';
import { useStore } from '../store';
import { generateAutomaticShiftPlan } from '../utils/scheduler';
import { SHIFT_LABELS } from '../types';

export function ShiftPlanning() {
  const { employees, shiftPlan, createShiftPlan, updateShiftAssignment } = useStore();
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
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
        const assignments = generateAutomaticShiftPlan(employees, selectedYear);
        
        // Remove any existing plan for the selected year, then store new assignments
        createShiftPlan(selectedYear);
        assignments.forEach(assignment => updateShiftAssignment(assignment));

        setGenerationResult({
          success: true,
          message: `Schichtplan erfolgreich generiert!`,
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

  const currentYearAssignments = shiftPlan?.assignments.filter((assignment) => {
    const assignmentYear = new Date(assignment.startDate).getFullYear();
    return assignmentYear === selectedYear;
  }) || [];

  const assignmentsByType = {
    nachtbereitschaft: currentYearAssignments.filter((a) => a.shiftType === 'nachtbereitschaft').length,
    verschieben: currentYearAssignments.filter((a) => a.shiftType === 'verschieben').length,
    fruehschicht: currentYearAssignments.filter((a) => a.shiftType === 'fruehschicht').length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Automatische Schichtplanung</h2>
            <p className="text-gray-600">
              Generieren Sie den kompletten Schichtplan für das Jahr mit einem Klick
            </p>
          </div>
          <Calendar className="h-12 w-12 text-primary-600" />
        </div>
      </div>

      {/* Year Selection & Generate */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Jahr auswählen
            </label>
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
            Aktueller Schichtplan für {selectedYear}
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
            <span><strong>Nachtschichten</strong> werden zuerst verteilt - <strong>exakt 2 Personen</strong> pro Woche (Sa-Sa)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">2.</span>
            <span><strong>Verschobene Schichten</strong> werden als nächstes verteilt - <strong>exakt 4 Personen</strong> pro Woche (Mo-Fr)</span>
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
