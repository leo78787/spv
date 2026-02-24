import React, { useState } from 'react';
import { useStore } from '../store';
import { Department } from '../types';
import { generateId } from '../utils/helpers';
import { Building2, Plus, Edit2, Trash2, Save, X } from 'lucide-react';

export function DepartmentManagement() {
  const { departments, employees, addDepartment, updateDepartment, deleteDepartment } = useStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formData, setFormData] = useState<{ name: string }>({ name: '' });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.name.trim()) return;
    
    if (editingId) {
      updateDepartment(editingId, { name: formData.name });
      setEditingId(null);
    } else {
      const newDepartment: Department = {
        id: generateId(),
        name: formData.name,
      };
      addDepartment(newDepartment);
    }
    
    resetForm();
  };
  
  const resetForm = () => {
    setFormData({ name: '' });
    setShowAddForm(false);
    setEditingId(null);
  };
  
  const handleEdit = (dept: Department) => {
    setFormData({ name: dept.name });
    setEditingId(dept.id);
    setShowAddForm(true);
  };
  
  const handleDelete = (id: string) => {
    const employeesInDept = employees.filter(emp => emp.department === id);
    
    if (employeesInDept.length > 0) {
      alert(`Diese Abteilung kann nicht gelöscht werden, da ${employeesInDept.length} Mitarbeiter zugeordnet sind.`);
      return;
    }
    
    if (confirm('Möchten Sie diese Abteilung wirklich löschen?')) {
      deleteDepartment(id);
    }
  };
  
  const getEmployeeCount = (deptId: string) => {
    return employees.filter(emp => emp.department === deptId).length;
  };
  
  return (
    <div className="p-3 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
        <h2 className="text-xl sm:text-2xl font-bold text-gray-800">Abteilungsverwaltung</h2>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-2 bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors"
        >
          {showAddForm ? <X size={20} /> : <Plus size={20} />}
          {showAddForm ? 'Abbrechen' : 'Abteilung hinzufügen'}
        </button>
      </div>
      
      {showAddForm && (
        <form onSubmit={handleSubmit} className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h3 className="text-lg font-semibold mb-4">
            {editingId ? 'Abteilung bearbeiten' : 'Neue Abteilung'}
          </h3>
          
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Abteilungsname *
            </label>
            <input
              type="text"
              required
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
              placeholder="z.B. Abteilung A"
            />
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
      
      {/* Department List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {departments.map(dept => {
          const employeeCount = getEmployeeCount(dept.id);
          
          return (
            <div key={dept.id} className="bg-white p-5 rounded-lg shadow-md hover:shadow-lg transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-primary-100 rounded-lg">
                    <Building2 className="text-primary-600" size={24} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg text-gray-800">{dept.name}</h3>
                    <p className="text-sm text-gray-600">
                      {employeeCount} Mitarbeiter
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleEdit(dept)}
                    className="p-2 text-primary-600 hover:bg-primary-50 rounded-md transition-colors"
                    title="Bearbeiten"
                  >
                    <Edit2 size={16} />
                  </button>
                  <button
                    onClick={() => handleDelete(dept.id)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-md transition-colors"
                    title="Löschen"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              
              {employeeCount > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-200">
                  <div className="text-xs text-gray-500">
                    Zugewiesene Mitarbeiter:
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {employees
                      .filter(emp => emp.department === dept.id)
                      .slice(0, 3)
                      .map(emp => (
                        <span key={emp.id} className="px-2 py-1 bg-gray-100 text-gray-700 rounded text-xs">
                          {emp.name}
                        </span>
                      ))}
                    {employeeCount > 3 && (
                      <span className="px-2 py-1 bg-gray-100 text-gray-700 rounded text-xs">
                        +{employeeCount - 3} weitere
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      
      {departments.length === 0 && !showAddForm && (
        <div className="text-center py-12 text-gray-500">
          <Building2 className="mx-auto mb-3" size={48} />
          <p>Noch keine Abteilungen angelegt.</p>
          <p className="text-sm">Klicken Sie auf "Abteilung hinzufügen" um zu beginnen.</p>
        </div>
      )}
    </div>
  );
}
