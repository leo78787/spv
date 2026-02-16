import React, { useState } from 'react';
import { useStore } from '../store';
import { ShiftType, SHIFT_LABELS, ShiftPreference } from '../types';

import { Filter, Users2 } from 'lucide-react';

export function EmployeeShiftMatrix() {
  const { employees, departments, updateEmployee } = useStore();
  const [selectedDepartment, setSelectedDepartment] = useState<string>('all');
  
  const shiftTypes: ShiftType[] = ['fruehschicht', 'verschieben', 'nachtbereitschaft'];
  
  const filteredEmployees = selectedDepartment === 'all' 
    ? employees 
    : employees.filter(emp => emp.department === selectedDepartment);
  
  const getPreferenceForShift = (employeeId: string, shiftType: ShiftType): ShiftPreference | null => {
    const employee = employees.find(e => e.id === employeeId);
    if (!employee) return null;
    
    // Return the most recent preference for this shift type
    const preferences = employee.preferences.filter(p => p.shiftType === shiftType);
    return preferences.length > 0 ? preferences[preferences.length - 1] : null;
  };
  
  const togglePreference = (employeeId: string, shiftType: ShiftType) => {
    const employee = employees.find(e => e.id === employeeId);
    if (!employee) return;
    
    const existingPrefIndex = employee.preferences.findIndex(p => p.shiftType === shiftType);
    let newPreferences = [...employee.preferences];
    
    if (existingPrefIndex >= 0) {
      const currentPref = newPreferences[existingPrefIndex];
      if (currentPref.preferred) {
        // Change to not preferred
        newPreferences[existingPrefIndex] = { ...currentPref, preferred: false };
      } else {
        // Remove preference
        newPreferences.splice(existingPrefIndex, 1);
      }
    } else {
      // Add new preferred preference
      const now = new Date();
      const yearEnd = new Date(now.getFullYear(), 11, 31);
      newPreferences.push({
        shiftType,
        startDate: now,
        endDate: yearEnd,
        preferred: true
      });
    }
    
    updateEmployee(employeeId, { preferences: newPreferences });
  };
  
  const getCellColor = (pref: ShiftPreference | null) => {
    if (!pref) return 'bg-gray-50 hover:bg-gray-100';
    return pref.preferred 
      ? 'bg-green-100 hover:bg-green-200 border-green-300' 
      : 'bg-red-100 hover:bg-red-200 border-red-300';
  };
  
  const getCellIcon = (pref: ShiftPreference | null) => {
    if (!pref) return '○';
    return pref.preferred ? '✓' : '✗';
  };
  
  const getCellLabel = (pref: ShiftPreference | null) => {
    if (!pref) return 'Neutral';
    return pref.preferred ? 'Bevorzugt' : 'Vermeiden';
  };
  
  const getDepartmentName = (deptId: string) => {
    return departments.find(d => d.id === deptId)?.name || 'Unbekannt';
  };
  
  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800 mb-4">Mitarbeiter-Schicht Matrix</h2>
        <p className="text-gray-600 mb-4">
          Klicken Sie auf die Zellen um Präferenzen zu ändern: Neutral → Bevorzugt → Vermeiden → Neutral
        </p>
        
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
          <div className="text-sm text-gray-600">
            ({filteredEmployees.length} Mitarbeiter)
          </div>
        </div>
        
        {/* Legend */}
        <div className="flex gap-4 text-sm mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gray-100 border border-gray-300 rounded flex items-center justify-center">○</div>
            <span>Neutral</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-green-100 border border-green-300 rounded flex items-center justify-center">✓</div>
            <span>Bevorzugt</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-red-100 border border-red-300 rounded flex items-center justify-center">✗</div>
            <span>Vermeiden</span>
          </div>
        </div>
      </div>
      
      {filteredEmployees.length === 0 ? (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
          <Users2 className="mx-auto mb-3 text-yellow-600" size={48} />
          <h3 className="text-lg font-semibold text-yellow-800 mb-2">Keine Mitarbeiter vorhanden</h3>
          <p className="text-yellow-700">
            {selectedDepartment === 'all' 
              ? 'Bitte fügen Sie zuerst Mitarbeiter hinzu.'
              : 'Keine Mitarbeiter in dieser Abteilung.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-md overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-gray-100">
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 border-b-2 border-gray-300 sticky left-0 bg-gray-100 z-10 min-w-[200px]">
                    Mitarbeiter
                  </th>
                  {shiftTypes.map(shiftType => (
                    <th key={shiftType} className="px-4 py-3 text-center font-semibold text-gray-700 border-b-2 border-gray-300 min-w-[150px]">
                      <div>{SHIFT_LABELS[shiftType]}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredEmployees.map((employee, index) => (
                  <tr 
                    key={employee.id} 
                    className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                  >
                    <td className="px-4 py-3 border-b border-gray-200 sticky left-0 z-10 bg-inherit">
                      <div className="font-medium text-gray-800">{employee.name}</div>
                      <div className="text-sm text-gray-600">{getDepartmentName(employee.department)}</div>
                      <div className="text-xs text-gray-500 mt-1 flex gap-2">
                        {employee.isOver55 && (
                          <span className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded">Ü55</span>
                        )}
                        {employee.hasL2 && (
                          <span className="px-2 py-0.5 bg-green-100 text-green-800 rounded">L2</span>
                        )}
                      </div>
                    </td>
                    {shiftTypes.map(shiftType => {
                      const pref = getPreferenceForShift(employee.id, shiftType);
                      return (
                        <td 
                          key={shiftType} 
                          className="border-b border-gray-200 p-2"
                        >
                          <button
                            onClick={() => togglePreference(employee.id, shiftType)}
                            className={`w-full h-16 rounded-md border-2 transition-all flex flex-col items-center justify-center ${getCellColor(pref)}`}
                            title={`Klicken um ${getCellLabel(pref)} zu ändern`}
                          >
                            <div className="text-2xl mb-1">{getCellIcon(pref)}</div>
                            <div className="text-xs font-medium">{getCellLabel(pref)}</div>
                          </button>
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
        <div className="mt-6 bg-white rounded-lg shadow-md p-6">
          <h3 className="text-lg font-semibold mb-4">Präferenz-Übersicht</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {shiftTypes.map(shiftType => {
              const preferred = filteredEmployees.filter(emp => {
                const pref = getPreferenceForShift(emp.id, shiftType);
                return pref?.preferred === true;
              }).length;
              
              const avoiding = filteredEmployees.filter(emp => {
                const pref = getPreferenceForShift(emp.id, shiftType);
                return pref?.preferred === false;
              }).length;
              
              const neutral = filteredEmployees.length - preferred - avoiding;
              
              return (
                <div key={shiftType} className="bg-gray-50 p-4 rounded-lg">
                  <h4 className="font-semibold text-gray-800 mb-3">
                    {SHIFT_LABELS[shiftType]}
                  </h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-green-700">Bevorzugt:</span>
                      <span className="font-semibold">{preferred}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Neutral:</span>
                      <span className="font-semibold">{neutral}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-red-700">Vermeiden:</span>
                      <span className="font-semibold">{avoiding}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
