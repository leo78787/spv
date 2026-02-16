import React, { useState } from 'react';
import { useStore } from '../store';
import { Employee, ShiftPreference, ShiftType, SHIFT_LABELS } from '../types';
import { generateId, parseDateInput, formatDateForInput } from '../utils/helpers';
import { UserPlus, Trash2, Edit2, Save, X } from 'lucide-react';

export function EmployeeManagement() {
  const { employees, departments, addEmployee, updateEmployee, deleteEmployee } = useStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  
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

  // Vacation ranges (multi-day)
  const addVacationRange = () => {
    const newRange = { startDate: new Date(), endDate: new Date() };
    setFormData(prev => ({
      ...prev,
      vacationRanges: [...(prev.vacationRanges || []), newRange]
    }));
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
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Mitarbeiterverwaltung</h2>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-2 bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors"
        >
          {showAddForm ? <X size={20} /> : <UserPlus size={20} />}
          {showAddForm ? 'Abbrechen' : 'Mitarbeiter hinzufügen'}
        </button>
      </div>
      
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
              <div>
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
                  <div className="flex-1 grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-gray-500">Von</label>
                      <input
                        type="date"
                        value={r.startDate instanceof Date ? formatDateForInput(r.startDate) : ''}
                        onChange={e => updateVacationRange(index, { startDate: parseDateInput(e.target.value) })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500">Bis</label>
                      <input
                        type="date"
                        value={r.endDate instanceof Date ? formatDateForInput(r.endDate) : ''}
                        onChange={e => updateVacationRange(index, { endDate: parseDateInput(e.target.value) })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    </div>
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
                  
                  <div className="grid grid-cols-2 gap-3 mb-2">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Von</label>
                      <input
                        type="date"
                        value={pref.startDate instanceof Date ? formatDateForInput(pref.startDate) : ''}
                        onChange={e => updatePreference(index, { startDate: parseDateInput(e.target.value) })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Bis</label>
                      <input
                        type="date"
                        value={pref.endDate instanceof Date ? formatDateForInput(pref.endDate) : ''}
                        onChange={e => updatePreference(index, { endDate: parseDateInput(e.target.value) })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    </div>
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
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {employees.map(employee => {
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
                    <div className="text-sm mt-1">
                      {employee.vacationDays.length > 0 && (
                        <div>{employee.vacationDays.length} Tag(e)</div>
                      )}
                      {employee.vacationRanges && employee.vacationRanges.length > 0 && (
                        <div className="mt-1 space-y-1">
                          {employee.vacationRanges.map((r, i) => (
                            <div key={i} className="text-xs text-gray-600">{new Date(r.startDate).toLocaleDateString('de-DE')} — {new Date(r.endDate).toLocaleDateString('de-DE')}</div>
                          ))}
                        </div>
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
