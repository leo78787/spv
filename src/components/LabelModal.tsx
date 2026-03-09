import { useState } from 'react';
import { X, Plus, Edit2, Trash2, Check } from 'lucide-react';
import { useStore } from '../store';
import { Label } from '../types';
import { format } from 'date-fns';

interface LabelModalProps {
  employeeId: string;
  employeeName: string;
  date: Date;
  onClose: () => void;
}

export function LabelModal({ employeeId, employeeName, date, onClose }: LabelModalProps) {
  const { labels, calendarLabels, addLabel, updateLabel, deleteLabel, addCalendarLabel, deleteCalendarLabel } = useStore();
  
  const [mode, setMode] = useState<'select' | 'create' | 'edit'>('select');
  const [editingLabel, setEditingLabel] = useState<Label | null>(null);
  
  // Form state for creating/editing labels
  const [formData, setFormData] = useState({
    name: '',
    letter: '',
    color: '#3b82f6',
    text: '',
    visibleToEmployee: true,
  });

  const dateStr = format(date, 'yyyy-MM-dd'); // YYYY-MM-DD (consistent with CalendarView)
  
  // Get labels already assigned to this cell
  const assignedLabelIds = calendarLabels
    .filter(cl => cl.employeeId === employeeId && cl.date === dateStr)
    .map(cl => cl.labelId);

  const handleCreateLabel = () => {
    if (!formData.name.trim() || !formData.letter.trim()) return;
    
    const newLabel: Label = {
      id: `label-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: formData.name.trim(),
      letter: formData.letter.trim().charAt(0).toUpperCase(),
      color: formData.color,
      text: formData.text.trim(),
      visibleToEmployee: formData.visibleToEmployee,
    };
    
    addLabel(newLabel);
    
    // Auto-assign the newly created label
    const calendarLabel = {
      id: `clabel-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      employeeId,
      date: dateStr,
      labelId: newLabel.id
    };
    addCalendarLabel(calendarLabel);
    
    // Reset form
    setFormData({ name: '', letter: '', color: '#3b82f6', text: '', visibleToEmployee: true });
    setMode('select');
  };

  const handleUpdateLabel = () => {
    if (!editingLabel || !formData.name.trim() || !formData.letter.trim()) return;
    
    updateLabel(editingLabel.id, {
      name: formData.name.trim(),
      letter: formData.letter.trim().charAt(0).toUpperCase(),
      color: formData.color,
      text: formData.text.trim(),
      visibleToEmployee: formData.visibleToEmployee,
    });
    
    setEditingLabel(null);
    setFormData({ name: '', letter: '', color: '#3b82f6', text: '', visibleToEmployee: true });
    setMode('select');
  };

  const handleDeleteLabel = (labelId: string) => {
    if (window.confirm('Label wirklich löschen? Alle Zuweisungen werden entfernt.')) {
      deleteLabel(labelId);
    }
  };

  const handleToggleLabelAssignment = (labelId: string) => {
    const existing = calendarLabels.find(
      cl => cl.employeeId === employeeId && cl.date === dateStr && cl.labelId === labelId
    );
    
    if (existing) {
      deleteCalendarLabel(existing.id);
    } else {
      const calendarLabel = {
        id: `clabel-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        employeeId,
        date: dateStr,
        labelId
      };
      addCalendarLabel(calendarLabel);
    }
  };

  const startEdit = (label: Label) => {
    setEditingLabel(label);
    setFormData({
      name: label.name,
      letter: label.letter,
      color: label.color,
      text: label.text || '',
      visibleToEmployee: label.visibleToEmployee !== false,
    });
    setMode('edit');
  };

  const cancelEdit = () => {
    setEditingLabel(null);
    setFormData({ name: '', letter: '', color: '#3b82f6', text: '', visibleToEmployee: true });
    setMode('select');
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Labels verwalten</h2>
            <p className="text-sm text-gray-600 mt-1">
              {employeeName} – {date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto flex-1">
          {mode === 'select' && (
            <>
              {/* Existing labels */}
              <div className="mb-6">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Verfügbare Labels</h3>
                {labels.length === 0 ? (
                  <p className="text-sm text-gray-500 italic">Keine Labels vorhanden</p>
                ) : (
                  <div className="space-y-2">
                    {labels.map(label => {
                      const isAssigned = assignedLabelIds.includes(label.id);
                      return (
                        <div
                          key={label.id}
                          className="flex items-center justify-between p-3 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                        >
                          <div className="flex items-center gap-3 flex-1">
                            <button
                              onClick={() => handleToggleLabelAssignment(label.id)}
                              className={`flex items-center gap-3 flex-1 text-left ${
                                isAssigned ? 'opacity-100' : 'opacity-60'
                              }`}
                            >
                              <div
                                className="w-8 h-8 rounded flex items-center justify-center text-white font-bold text-sm"
                                style={{ backgroundColor: label.color }}
                              >
                                {label.letter}
                              </div>
                              <div className="flex-1">
                                <div className="font-medium text-gray-900">{label.name}</div>
                                {label.text && <div className="text-xs text-gray-500">{label.text}</div>}
                              </div>
                              {isAssigned && <Check className="w-5 h-5 text-green-600" />}
                            </button>
                          </div>
                          <div className="flex items-center gap-1 ml-2">
                            <button
                              onClick={() => startEdit(label)}
                              className="p-1.5 text-gray-400 hover:text-blue-600 transition-colors"
                              title="Bearbeiten"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDeleteLabel(label.id)}
                              className="p-1.5 text-gray-400 hover:text-red-600 transition-colors"
                              title="Löschen"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Create new label button */}
              <button
                onClick={() => setMode('create')}
                className="w-full flex items-center justify-center gap-2 p-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors"
              >
                <Plus className="w-5 h-5" />
                <span className="font-medium">Neues Label erstellen</span>
              </button>
            </>
          )}

          {(mode === 'create' || mode === 'edit') && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="z.B. Schulung"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Buchstabe * (wird im Kalender angezeigt)
                </label>
                <input
                  type="text"
                  value={formData.letter}
                  onChange={(e) => setFormData({ ...formData, letter: e.target.value.charAt(0).toUpperCase() })}
                  placeholder="S"
                  maxLength={1}
                  className="w-20 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-center font-bold text-lg"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Farbe
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={formData.color}
                    onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                    className="w-16 h-10 rounded cursor-pointer"
                  />
                  <input
                    type="text"
                    value={formData.color}
                    onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Zusatztext (optional)
                </label>
                <input
                  type="text"
                  value={formData.text}
                  onChange={(e) => setFormData({ ...formData, text: e.target.value })}
                  placeholder="z.B. Erste-Hilfe-Kurs"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>



              {/* Preview */}
              <div className="p-4 bg-gray-50 rounded-lg">
                <p className="text-xs text-gray-600 mb-2 font-medium">Vorschau:</p>
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded flex items-center justify-center text-white font-bold"
                    style={{ backgroundColor: formData.color }}
                  >
                    {formData.letter || '?'}
                  </div>
                  <div>
                    <div className="font-medium text-gray-900">{formData.name || 'Name'}</div>
                    {formData.text && <div className="text-xs text-gray-500">{formData.text}</div>}
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={cancelEdit}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Abbrechen
                </button>
                <button
                  onClick={mode === 'create' ? handleCreateLabel : handleUpdateLabel}
                  disabled={!formData.name.trim() || !formData.letter.trim()}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  {mode === 'create' ? 'Erstellen & Zuweisen' : 'Speichern'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
