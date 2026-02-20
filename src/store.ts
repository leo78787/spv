import { create } from 'zustand';
import { Employee, Department, ShiftAssignment, ShiftPlan, Holiday, Label, CalendarLabel, SchedulerConfig, SchedulerViolation } from './types';

// ═══════════════════════════════════════════════════════════════════════
// Auth token helpers (stored in localStorage — only the token, not data)
// ═══════════════════════════════════════════════════════════════════════

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem('spm-auth-token');
  } catch { return null; }
}

export function setAuthToken(token: string) {
  localStorage.setItem('spm-auth-token', token);
}

export function clearAuthToken() {
  localStorage.removeItem('spm-auth-token');
}

// ═══════════════════════════════════════════════════════════════════════
// Server persistence helpers (replace the old localStorage approach)
// ═══════════════════════════════════════════════════════════════════════

/**
 * JSON replacer that serialises every Date as noon-UTC ISO string
 * (YYYY-MM-DDT12:00:00.000Z) using LOCAL date components.
 * This avoids off-by-one errors when dates cross a UTC day boundary.
 */
function dateNoonReplacer(this: any, key: string, value: any): any {
  const raw = this[key];
  if (raw instanceof Date) {
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, '0');
    const d = String(raw.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}T12:00:00.000Z`;
  }
  return value;
}

/** Fire-and-forget save to the server (optimistic update). */
const saveToServer = async (state: any) => {
  const token = getAuthToken();
  if (!token) return;
  try {
    await fetch('/api/state', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        employees: state.employees,
        departments: state.departments,
        currentYear: state.currentYear,
        shiftPlan: state.shiftPlan,
        customHolidays: state.customHolidays,
        labels: state.labels,
        calendarLabels: state.calendarLabels,
      }, dateNoonReplacer),
    });
  } catch (err) {
    console.error('Error saving to server:', err);
  }
};

/** Revive ISO date strings back to Date objects. */
function reviveDatesInState(obj: any): any {
  if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj)) {
    return new Date(obj);
  }
  if (Array.isArray(obj)) return obj.map(reviveDatesInState);
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const key of Object.keys(obj)) {
      out[key] = reviveDatesInState(obj[key]);
    }
    return out;
  }
  return obj;
}

/**
 * Load application state from the server.
 * Called once after login / on app mount.
 */
export async function loadFromServer(): Promise<void> {
  const token = getAuthToken();
  if (!token) return;
  try {
    const resp = await fetch('/api/state', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return;
    const raw = await resp.json();
    const revived = reviveDatesInState(raw);
    useStore.setState({
      employees: revived.employees ?? [],
      departments: revived.departments ?? [
        { id: 'dept-1', name: 'Abteilung A' },
        { id: 'dept-2', name: 'Abteilung B' },
        { id: 'dept-3', name: 'Abteilung C' },
      ],
      currentYear: revived.currentYear ?? new Date().getFullYear(),
      shiftPlan: revived.shiftPlan ?? null,
      customHolidays: revived.customHolidays ?? [],
      labels: revived.labels ?? [],
      calendarLabels: revived.calendarLabels ?? [],
    });
  } catch (err) {
    console.error('Error loading from server:', err);
  }
}

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
  createShiftPlan: (year: number, startMonth?: number, months?: number, schedulerConfig?: SchedulerConfig, violations?: SchedulerViolation[], algorithm?: string) => void;
  setShiftPlan: (plan: ShiftPlan | null) => void;
  updateShiftAssignment: (assignment: ShiftAssignment) => void;
  deleteShiftAssignment: (id: string) => void;
  confirmShiftAssignment: (id: string) => void;
  acknowledgeViolation: (id: string) => void;
}

export const useStore = create<AppState>((set) => {
  // Start with defaults; loadFromServer() hydrates after login
  const initialState = {
    employees: [] as Employee[],
    departments: [
      { id: 'dept-1', name: 'Abteilung A' },
      { id: 'dept-2', name: 'Abteilung B' },
      { id: 'dept-3', name: 'Abteilung C' },
    ],
    currentYear: new Date().getFullYear(),
    shiftPlan: null as ShiftPlan | null,
    customHolidays: [] as Holiday[],
    labels: [] as Label[],
    calendarLabels: [] as CalendarLabel[],
    
    addEmployee: (employee: Employee) => set((state) => {
      const newState = {
        ...state,
        employees: [...state.employees, employee]
      };
      saveToServer(newState);
      return newState;
    }),

    // Holiday actions (user configurable)
    addCustomHoliday: (holiday: Holiday) => set((state) => {
      const newState = { ...state, customHolidays: [...state.customHolidays, holiday] };
      saveToServer(newState);
      return newState;
    }),

    updateCustomHoliday: (id: string, updates: Partial<Holiday>) => set((state) => {
      const newState = { ...state, customHolidays: state.customHolidays.map(h => h.id === id ? { ...h, ...updates } : h) };
      saveToServer(newState);
      return newState;
    }),

    deleteCustomHoliday: (id: string) => set((state) => {
      const newState = { ...state, customHolidays: state.customHolidays.filter(h => h.id !== id) };
      saveToServer(newState);
      return newState;
    }),

    // Label actions
    addLabel: (label: Label) => set((state) => {
      const newState = { ...state, labels: [...state.labels, label] };
      saveToServer(newState);
      return newState;
    }),

    updateLabel: (id: string, updates: Partial<Label>) => set((state) => {
      const newState = { 
        ...state, 
        labels: state.labels.map(l => l.id === id ? { ...l, ...updates } : l) 
      };
      saveToServer(newState);
      return newState;
    }),

    deleteLabel: (id: string) => set((state) => {
      const newState = { 
        ...state, 
        labels: state.labels.filter(l => l.id !== id),
        // Also remove all calendar labels that reference this label
        calendarLabels: state.calendarLabels.filter(cl => cl.labelId !== id)
      };
      saveToServer(newState);
      return newState;
    }),

    // Calendar label actions
    addCalendarLabel: (calendarLabel: CalendarLabel) => set((state) => {
      const newState = { ...state, calendarLabels: [...state.calendarLabels, calendarLabel] };
      saveToServer(newState);
      return newState;
    }),

    deleteCalendarLabel: (id: string) => set((state) => {
      const newState = { ...state, calendarLabels: state.calendarLabels.filter(cl => cl.id !== id) };
      saveToServer(newState);
      return newState;
    }),
    
    updateEmployee: (id: string, updates: Partial<Employee>) => set((state) => {
      const newState = {
        ...state,
        employees: state.employees.map(emp => 
          emp.id === id ? { ...emp, ...updates } : emp
        )
      };
      saveToServer(newState);
      return newState;
    }),
    
    deleteEmployee: (id: string) => set((state) => {
      const newState = {
        ...state,
        employees: state.employees.filter(emp => emp.id !== id)
      };
      saveToServer(newState);
      return newState;
    }),
    
    addDepartment: (department: Department) => set((state) => {
      const newState = {
        ...state,
        departments: [...state.departments, department]
      };
      saveToServer(newState);
      return newState;
    }),
    
    updateDepartment: (id: string, updates: Partial<Department>) => set((state) => {
      const newState = {
        ...state,
        departments: state.departments.map(dept =>
          dept.id === id ? { ...dept, ...updates } : dept
        )
      };
      saveToServer(newState);
      return newState;
    }),
    
    deleteDepartment: (id: string) => set((state) => {
      const newState = {
        ...state,
        departments: state.departments.filter(dept => dept.id !== id)
      };
      saveToServer(newState);
      return newState;
    }),
    
    setCurrentYear: (year: number) => set((state) => {
      const newState = { ...state, currentYear: year };
      saveToServer(newState);
      return newState;
    }),
    
    createShiftPlan: (year: number, startMonth = 0, months = 12, schedulerConfig?: SchedulerConfig, violations?: SchedulerViolation[], algorithm?: string) => set((state) => {
      const newState = {
        ...state,
        // When creating a fresh plan we remove any calendar label assignments
        // so old per-day annotations do not carry over to the new schedule.
        calendarLabels: [],
        shiftPlan: { year, startMonth, months, schedulerConfig, violations: violations ?? [], assignments: [], algorithm }
      };
      saveToServer(newState);
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
      saveToServer(newState);
      return newState;
    }),

    // Replace entire shiftPlan (used for JSON import)
    setShiftPlan: (plan: ShiftPlan | null) => set((state) => {
      const newState = { ...state, shiftPlan: plan, calendarLabels: plan ? [] : state.calendarLabels };
      saveToServer(newState);
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
      saveToServer(newState);
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
      saveToServer(newState);
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
      saveToServer(newState);
      return newState;
    }),
  };
  
  return initialState;
});
