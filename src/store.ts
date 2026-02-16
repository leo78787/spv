import { create } from 'zustand';
import { Employee, Department, ShiftAssignment, ShiftPlan } from './types';

interface AppState {
  employees: Employee[];
  departments: Department[];
  currentYear: number;
  shiftPlan: ShiftPlan | null;
  
  // Employee actions
  addEmployee: (employee: Employee) => void;
  updateEmployee: (id: string, employee: Partial<Employee>) => void;
  deleteEmployee: (id: string) => void;
  
  // Department actions
  addDepartment: (department: Department) => void;
  updateDepartment: (id: string, updates: Partial<Department>) => void;
  deleteDepartment: (id: string) => void;
  
  // Shift plan actions
  setCurrentYear: (year: number) => void;
  createShiftPlan: (year: number) => void;
  updateShiftAssignment: (assignment: ShiftAssignment) => void;
  deleteShiftAssignment: (id: string) => void;
  confirmShiftAssignment: (id: string) => void;
}

const saveToLocalStorage = (key: string, state: any) => {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch (error) {
    console.error('Error saving to localStorage:', error);
  }
};

const loadFromLocalStorage = (key: string) => {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item, (_key, value) => {
      // Convert date strings back to Date objects
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
        return new Date(value);
      }
      return value;
    }) : null;
  } catch (error) {
    console.error('Error loading from localStorage:', error);
    return null;
  }
};

export const useStore = create<AppState>((set) => {
  const saved = loadFromLocalStorage('schichtplan-storage');
  
  const initialState = {
    employees: saved?.employees || [],
    departments: saved?.departments || [
      { id: 'dept-1', name: 'Abteilung A' },
      { id: 'dept-2', name: 'Abteilung B' },
      { id: 'dept-3', name: 'Abteilung C' },
    ],
    currentYear: saved?.currentYear || new Date().getFullYear(),
    shiftPlan: saved?.shiftPlan || null,
    
    addEmployee: (employee: Employee) => set((state) => {
      const newState = {
        ...state,
        employees: [...state.employees, employee]
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),
    
    updateEmployee: (id: string, updates: Partial<Employee>) => set((state) => {
      const newState = {
        ...state,
        employees: state.employees.map(emp => 
          emp.id === id ? { ...emp, ...updates } : emp
        )
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),
    
    deleteEmployee: (id: string) => set((state) => {
      const newState = {
        ...state,
        employees: state.employees.filter(emp => emp.id !== id)
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),
    
    addDepartment: (department: Department) => set((state) => {
      const newState = {
        ...state,
        departments: [...state.departments, department]
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),
    
    updateDepartment: (id: string, updates: Partial<Department>) => set((state) => {
      const newState = {
        ...state,
        departments: state.departments.map(dept =>
          dept.id === id ? { ...dept, ...updates } : dept
        )
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),
    
    deleteDepartment: (id: string) => set((state) => {
      const newState = {
        ...state,
        departments: state.departments.filter(dept => dept.id !== id)
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),
    
    setCurrentYear: (year: number) => set((state) => {
      const newState = { ...state, currentYear: year };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),
    
    createShiftPlan: (year: number) => set((state) => {
      const newState = {
        ...state,
        shiftPlan: { year, assignments: [] }
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),
    
    updateShiftAssignment: (assignment: ShiftAssignment) => set((state) => {
      if (!state.shiftPlan) return state;
      
      const existingIndex = state.shiftPlan.assignments.findIndex(a => a.id === assignment.id);
      
      let newState;
      if (existingIndex >= 0) {
        const newAssignments = [...state.shiftPlan.assignments];
        newAssignments[existingIndex] = assignment;
        newState = {
          ...state,
          shiftPlan: { ...state.shiftPlan, assignments: newAssignments }
        };
      } else {
        newState = {
          ...state,
          shiftPlan: {
            ...state.shiftPlan,
            assignments: [...state.shiftPlan.assignments, assignment]
          }
        };
      }
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),
    
    deleteShiftAssignment: (id: string) => set((state) => {
      if (!state.shiftPlan) return state;
      const newState = {
        ...state,
        shiftPlan: {
          ...state.shiftPlan,
          assignments: state.shiftPlan.assignments.filter(a => a.id !== id)
        }
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),
    
    confirmShiftAssignment: (id: string) => set((state) => {
      if (!state.shiftPlan) return state;
      const newState = {
        ...state,
        shiftPlan: {
          ...state.shiftPlan,
          assignments: state.shiftPlan.assignments.map(a =>
            a.id === id ? { ...a, confirmed: true } : a
          )
        }
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),
  };
  
  return initialState;
});
