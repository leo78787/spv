import { create } from 'zustand';
import { Employee, Department, ShiftAssignment, ShiftPlan, Holiday, Label, CalendarLabel, SchedulerConfig, SchedulerViolation } from './types';

interface AppState {
  employees: Employee[];
  departments: Department[];
  currentYear: number;
  shiftPlan: ShiftPlan | null;
  customHolidays: Holiday[];
  labels: Label[];
  calendarLabels: CalendarLabel[];
  
  // Employee actions
  addEmployee: (employee: Employee) => void;
  updateEmployee: (id: string, employee: Partial<Employee>) => void;
  deleteEmployee: (id: string) => void;
  
  // Department actions
  addDepartment: (department: Department) => void;
  updateDepartment: (id: string, updates: Partial<Department>) => void;
  deleteDepartment: (id: string) => void;
  
  // Holiday actions
  addCustomHoliday: (holiday: Holiday) => void;
  updateCustomHoliday: (id: string, updates: Partial<Holiday>) => void;
  deleteCustomHoliday: (id: string) => void;

  // Label actions
  addLabel: (label: Label) => void;
  updateLabel: (id: string, updates: Partial<Label>) => void;
  deleteLabel: (id: string) => void;

  // Calendar label actions
  addCalendarLabel: (calendarLabel: CalendarLabel) => void;
  deleteCalendarLabel: (id: string) => void;

  // Shift plan actions
  setCurrentYear: (year: number) => void;
  createShiftPlan: (year: number, startMonth?: number, months?: number, schedulerConfig?: SchedulerConfig, violations?: SchedulerViolation[]) => void;
  setShiftPlan: (plan: ShiftPlan | null) => void;
  updateShiftAssignment: (assignment: ShiftAssignment) => void;
  deleteShiftAssignment: (id: string) => void;
  confirmShiftAssignment: (id: string) => void;
  acknowledgeViolation: (id: string) => void;
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
    customHolidays: saved?.customHolidays || [],
    labels: saved?.labels || [],
    calendarLabels: saved?.calendarLabels || [],
    
    addEmployee: (employee: Employee) => set((state) => {
      const newState = {
        ...state,
        employees: [...state.employees, employee]
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),

    // Holiday actions (user configurable)
    addCustomHoliday: (holiday: Holiday) => set((state) => {
      const newState = { ...state, customHolidays: [...state.customHolidays, holiday] };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),

    updateCustomHoliday: (id: string, updates: Partial<Holiday>) => set((state) => {
      const newState = { ...state, customHolidays: state.customHolidays.map(h => h.id === id ? { ...h, ...updates } : h) };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),

    deleteCustomHoliday: (id: string) => set((state) => {
      const newState = { ...state, customHolidays: state.customHolidays.filter(h => h.id !== id) };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),

    // Label actions
    addLabel: (label: Label) => set((state) => {
      const newState = { ...state, labels: [...state.labels, label] };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),

    updateLabel: (id: string, updates: Partial<Label>) => set((state) => {
      const newState = { 
        ...state, 
        labels: state.labels.map(l => l.id === id ? { ...l, ...updates } : l) 
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),

    deleteLabel: (id: string) => set((state) => {
      const newState = { 
        ...state, 
        labels: state.labels.filter(l => l.id !== id),
        // Also remove all calendar labels that reference this label
        calendarLabels: state.calendarLabels.filter(cl => cl.labelId !== id)
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),

    // Calendar label actions
    addCalendarLabel: (calendarLabel: CalendarLabel) => set((state) => {
      const newState = { ...state, calendarLabels: [...state.calendarLabels, calendarLabel] };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),

    deleteCalendarLabel: (id: string) => set((state) => {
      const newState = { ...state, calendarLabels: state.calendarLabels.filter(cl => cl.id !== id) };
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
    
    createShiftPlan: (year: number, startMonth = 0, months = 12, schedulerConfig?: SchedulerConfig, violations?: SchedulerViolation[]) => set((state) => {
      const newState = {
        ...state,
        // When creating a fresh plan we remove any calendar label assignments
        // so old per-day annotations do not carry over to the new schedule.
        calendarLabels: [],
        shiftPlan: { year, startMonth, months, schedulerConfig, violations: violations ?? [], assignments: [] }
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),

    acknowledgeViolation: (id: string) => set((state) => {
      if (!state.shiftPlan) return state;
      const newState = {
        ...state,
        shiftPlan: {
          ...state.shiftPlan,
          violations: (state.shiftPlan.violations ?? []).filter(v => v.id !== id)
        }
      };
      saveToLocalStorage('schichtplan-storage', newState);
      return newState;
    }),

    // Replace entire shiftPlan (used for JSON import)
    setShiftPlan: (plan: ShiftPlan | null) => set((state) => {
      const newState = { ...state, shiftPlan: plan };
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
