import React, { useState } from 'react';
import { AlertTriangle, X, ChevronLeft, ChevronRight, CheckCircle, Eye } from 'lucide-react';
import { SchedulerViolation, Employee, ShiftType } from '../types';

interface ViolationPipelineProps {
  violations: SchedulerViolation[];
  employees: Employee[];
  onAcknowledge: (id: string) => void;
  onClose: () => void;
  /** Optional callback to navigate to the violation in the calendar */
  onView?: (violation: SchedulerViolation) => void;
}

const shiftTypeLabel: Record<ShiftType, string> = {
  verschieben: 'Versetzter Dienst',
  nachtbereitschaft: 'Nachtbereitschaft',
  fruehschicht: 'Frühschicht',
};

const shiftTypeBg: Record<ShiftType, string> = {
  verschieben: 'bg-purple-100 text-purple-800',
  nachtbereitschaft: 'bg-blue-100 text-blue-800',
  fruehschicht: 'bg-orange-100 text-orange-800',
};

function formatDate(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export default function ViolationPipeline({
  violations,
  employees,
  onAcknowledge,
  onClose,
  onView,
}: ViolationPipelineProps) {
  const [index, setIndex] = useState(0);

  if (violations.length === 0) return null;

  const currentIndex = Math.min(index, violations.length - 1);
  const violation = violations[currentIndex];

  const assignedNames = violation.assignedEmployeeIds
    .map(id => employees.find(e => e.id === id)?.name ?? id)
    .join(', ');

  const handleAcknowledge = () => {
    onAcknowledge(violation.id);
    // Don't advance index — after removal the list shrinks, so same index shows next item
    // If this was the last item the parent will hide the panel (violations.length becomes 0)
    setIndex(prev => (prev >= violations.length - 1 ? Math.max(0, violations.length - 2) : prev));
  };

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[420px] shadow-2xl flex flex-col bg-white border-l border-gray-200">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 bg-amber-50 border-b border-amber-200">
        <div className="flex items-center gap-2">
          <AlertTriangle className="text-amber-500" size={20} />
          <span className="font-semibold text-amber-800">
            Regelprobleme bei der Generierung
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-700 transition-colors"
          title="Pipeline schließen"
        >
          <X size={20} />
        </button>
      </div>

      {/* Counter */}
      <div className="flex items-center justify-between px-5 py-2 bg-gray-50 border-b border-gray-100 text-sm text-gray-500">
        <span>Problem {currentIndex + 1} von {violations.length}</span>
        <div className="flex gap-1">
          <button
            disabled={currentIndex === 0}
            onClick={() => setIndex(i => i - 1)}
            className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            disabled={currentIndex >= violations.length - 1}
            onClick={() => setIndex(i => i + 1)}
            className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Violation detail */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
        {/* Shift type badge + date range */}
        <div>
          <span
            className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${shiftTypeBg[violation.shiftType]}`}
          >
            {shiftTypeLabel[violation.shiftType]}
          </span>
          <p className="mt-2 text-gray-700">
            <span className="font-medium">Zeitraum:</span>{' '}
            {formatDate(violation.startDate)} – {formatDate(violation.endDate)}
          </p>
        </div>

        {/* Staffing summary */}
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
          <p className="text-red-700 font-medium text-sm">
            Personalmangel: {violation.assigned} von {violation.required} Mitarbeitenden zugewiesen
          </p>
          <p className="text-red-600 text-sm mt-1">
            {violation.required - violation.assigned} Stelle
            {violation.required - violation.assigned !== 1 ? 'n' : ''} konnten nicht besetzt werden.
          </p>
        </div>

        {/* Who was assigned */}
        {violation.assigned > 0 && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-1">Zugewiesene Mitarbeitende:</p>
            <p className="text-sm text-gray-600">{assignedNames}</p>
          </div>
        )}

        {/* Active rules that may have caused the shortage */}
        {violation.blockedRules.length > 0 && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Aktive Regeln (mögliche Ursachen):</p>
            <ul className="space-y-1">
              {violation.blockedRules.map(rule => (
                <li
                  key={rule}
                  className="flex items-start gap-2 text-sm text-gray-600"
                >
                  <span className="mt-0.5 w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                  {rule}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="px-5 py-4 border-t border-gray-200 bg-gray-50 space-y-2">
        {onView && (
          <button
            onClick={() => onView(violation)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium"
          >
            <Eye size={17} />
            Anschauen
          </button>
        )}
        <button
          onClick={handleAcknowledge}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
        >
          <CheckCircle size={17} />
          Zur Kenntnis nehmen
        </button>
        <button
          onClick={onClose}
          className="w-full px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors text-sm"
        >
          Pipeline schließen (Problem bleibt bestehen)
        </button>
      </div>
    </div>
  );
}
