import { create } from 'zustand';
import { Employee, Department, ShiftAssignment, ShiftPlan, Holiday, Label, CalendarLabel, SchedulerConfig, SchedulerViolation, SwapSettings, DEFAULT_SWAP_SETTINGS, TabVisibility, DEFAULT_TAB_VISIBILITY } from './types';

// ═══════════════════════════════════════════════════════════════════════
// localStorage persistence helpers
// ═══════════════════════════════════════════════════════════════════════

const STORAGE_KEY = 'spm-local-state';

/**
 * JSON replacer that serialises every Date as noon-UTC ISO string
 * (YYYY-MM-DDT12:00:00.000Z) using LOCAL date components.
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

/** Save state to localStorage. */
function saveToLocalStorage(state: any) {
  try {
    const data = JSON.stringify({
      employees: state.employees,
      departments: state.departments,
      currentYear: state.currentYear,
      shiftPlan: state.shiftPlan,
      customHolidays: state.customHolidays,
      labels: state.labels,
      calendarLabels: state.calendarLabels,
      swapSettings: state.swapSettings,
      tabVisibility: state.tabVisibility,
    }, dateNoonReplacer);
    localStorage.setItem(STORAGE_KEY, data);
  } catch (err) {
    console.error('Error saving to localStorage:', err);
  }
}

/** Load state from localStorage. Returns null if no saved state. */
function loadFromLocalStorage(): any | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return reviveDatesInState(parsed);
  } catch (err) {
    console.error('Error loading from localStorage:', err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════

interface AppState {
  employees: Employee[];
  departments: Department[];
  currentYear: number;
  shiftPlan: ShiftPlan | null;
  customHolidays: Holiday[];
  labels: Label[];
  calendarLabels: CalendarLabel[];
  swapSettings: SwapSettings;
  tabVisibility: TabVisibility;
  
  addEmployee: (employee: Employee) => void;
  updateEmployee: (id: string, employee: Partial<Employee>) => void;
  deleteEmployee: (id: string) => void;
  
  addDepartment: (department: Department) => void;
  updateDepartment: (id: string, updates: Partial<Department>) => void;
  deleteDepartment: (id: string) => void;
  
  addCustomHoliday: (holiday: Holiday) => void;
  updateCustomHoliday: (id: string, updates: Partial<Holiday>) => void;
  deleteCustomHoliday: (id: string) => void;

  addLabel: (label: Label) => void;
  updateLabel: (id: string, updates: Partial<Label>) => void;
  deleteLabel: (id: string) => void;

  addCalendarLabel: (calendarLabel: CalendarLabel) => void;
  deleteCalendarLabel: (id: string) => void;

  batchImport: (newDepartments: Department[], newEmployees: Employee[]) => void;

  setSwapSettings: (settings: SwapSettings) => void;
  setTabVisibility: (vis: TabVisibility) => void;

  setCurrentYear: (year: number) => void;
  createShiftPlan: (year: number, startMonth?: number, months?: number, schedulerConfig?: SchedulerConfig, violations?: SchedulerViolation[], algorithm?: string) => void;
  setShiftPlan: (plan: ShiftPlan | null) => void;
  updateShiftAssignment: (assignment: ShiftAssignment) => void;
  deleteShiftAssignment: (id: string) => void;
  confirmShiftAssignment: (id: string) => void;
  acknowledgeViolation: (id: string) => void;
}

const saved = loadFromLocalStorage();

export const useStore = create<AppState>((set) => ({
  employees: saved?.employees ?? ([] as Employee[]),
  departments: saved?.departments ?? [
    { id: 'dept-1', name: 'Abteilung A' },
    { id: 'dept-2', name: 'Abteilung B' },
    { id: 'dept-3', name: 'Abteilung C' },
  ],
  currentYear: saved?.currentYear ?? new Date().getFullYear(),
  shiftPlan: saved?.shiftPlan ?? (null as ShiftPlan | null),
  customHolidays: saved?.customHolidays ?? ([] as Holiday[]),
  labels: saved?.labels ?? ([] as Label[]),
  calendarLabels: saved?.calendarLabels ?? ([] as CalendarLabel[]),
  swapSettings: saved?.swapSettings ?? DEFAULT_SWAP_SETTINGS,
  tabVisibility: saved?.tabVisibility ?? DEFAULT_TAB_VISIBILITY,
  
  addEmployee: (employee: Employee) => set((state) => {
    const newState = { ...state, employees: [...state.employees, employee] };
    saveToLocalStorage(newState);
    return newState;
  }),

  addCustomHoliday: (holiday: Holiday) => set((state) => {
    const newState = { ...state, customHolidays: [...state.customHolidays, holiday] };
    saveToLocalStorage(newState);
    return newState;
  }),

  updateCustomHoliday: (id: string, updates: Partial<Holiday>) => set((state) => {
    const newState = { ...state, customHolidays: state.customHolidays.map(h => h.id === id ? { ...h, ...updates } : h) };
    saveToLocalStorage(newState);
    return newState;
  }),

  deleteCustomHoliday: (id: string) => set((state) => {
    const newState = { ...state, customHolidays: state.customHolidays.filter(h => h.id !== id) };
    saveToLocalStorage(newState);
    return newState;
  }),

  addLabel: (label: Label) => set((state) => {
    const newState = { ...state, labels: [...state.labels, label] };
    saveToLocalStorage(newState);
    return newState;
  }),

  updateLabel: (id: string, updates: Partial<Label>) => set((state) => {
    const newState = { ...state, labels: state.labels.map(l => l.id === id ? { ...l, ...updates } : l) };
    saveToLocalStorage(newState);
    return newState;
  }),

  deleteLabel: (id: string) => set((state) => {
    const newState = { ...state, labels: state.labels.filter(l => l.id !== id), calendarLabels: state.calendarLabels.filter(cl => cl.labelId !== id) };
    saveToLocalStorage(newState);
    return newState;
  }),

  addCalendarLabel: (calendarLabel: CalendarLabel) => set((state) => {
    const newState = { ...state, calendarLabels: [...state.calendarLabels, calendarLabel] };
    saveToLocalStorage(newState);
    return newState;
  }),

  deleteCalendarLabel: (id: string) => set((state) => {
    const newState = { ...state, calendarLabels: state.calendarLabels.filter(cl => cl.id !== id) };
    saveToLocalStorage(newState);
    return newState;
  }),

  setSwapSettings: (settings: SwapSettings) => set((state) => {
    const newState = { ...state, swapSettings: settings };
    saveToLocalStorage(newState);
    return newState;
  }),

  setTabVisibility: (vis: TabVisibility) => set((state) => {
    const newState = { ...state, tabVisibility: vis };
    saveToLocalStorage(newState);
    return newState;
  }),
  
  updateEmployee: (id: string, updates: Partial<Employee>) => set((state) => {
    const newState = { ...state, employees: state.employees.map(emp => emp.id === id ? { ...emp, ...updates } : emp) };
    saveToLocalStorage(newState);
    return newState;
  }),
  
  deleteEmployee: (id: string) => set((state) => {
    const newState = { ...state, employees: state.employees.filter(emp => emp.id !== id) };
    saveToLocalStorage(newState);
    return newState;
  }),
  
  addDepartment: (department: Department) => set((state) => {
    const newState = { ...state, departments: [...state.departments, department] };
    saveToLocalStorage(newState);
    return newState;
  }),

  batchImport: (newDepartments: Department[], newEmployees: Employee[]) => set((state) => {
    const newState = { ...state, departments: [...state.departments, ...newDepartments], employees: [...state.employees, ...newEmployees] };
    saveToLocalStorage(newState);
    return newState;
  }),
  
  updateDepartment: (id: string, updates: Partial<Department>) => set((state) => {
    const newState = { ...state, departments: state.departments.map(dept => dept.id === id ? { ...dept, ...updates } : dept) };
    saveToLocalStorage(newState);
    return newState;
  }),
  
  deleteDepartment: (id: string) => set((state) => {
    const newState = { ...state, departments: state.departments.filter(dept => dept.id !== id) };
    saveToLocalStorage(newState);
    return newState;
  }),
  
  setCurrentYear: (year: number) => set((state) => {
    const newState = { ...state, currentYear: year };
    saveToLocalStorage(newState);
    return newState;
  }),
  
  createShiftPlan: (year: number, startMonth = 0, months = 12, schedulerConfig?: SchedulerConfig, violations?: SchedulerViolation[], algorithm?: string) => set((state) => {
    const newState = { ...state, calendarLabels: [], shiftPlan: { year, startMonth, months, schedulerConfig, violations: violations ?? [], assignments: [], algorithm } };
    saveToLocalStorage(newState);
    return newState;
  }),

  acknowledgeViolation: (id: string) => set((state) => {
    if (!state.shiftPlan) return state;
    const newState = { ...state, shiftPlan: { ...state.shiftPlan, violations: (state.shiftPlan.violations ?? []).filter(v => v.id !== id) } };
    saveToLocalStorage(newState);
    return newState;
  }),

  setShiftPlan: (plan: ShiftPlan | null) => set((state) => {
    const newState = { ...state, shiftPlan: plan, calendarLabels: plan ? [] : state.calendarLabels };
    saveToLocalStorage(newState);
    return newState;
  }),
  
  updateShiftAssignment: (assignment: ShiftAssignment) => set((state) => {
    if (!state.shiftPlan) return state;
    const existingIndex = state.shiftPlan.assignments.findIndex(a => a.id === assignment.id);
    let newState;
    if (existingIndex >= 0) {
      const newAssignments = [...state.shiftPlan.assignments];
      newAssignments[existingIndex] = assignment;
      newState = { ...state, shiftPlan: { ...state.shiftPlan, assignments: newAssignments } };
    } else {
      newState = { ...state, shiftPlan: { ...state.shiftPlan, assignments: [...state.shiftPlan.assignments, assignment] } };
    }
    saveToLocalStorage(newState);
    return newState;
  }),
  
  deleteShiftAssignment: (id: string) => set((state) => {
    if (!state.shiftPlan) return state;
    const newState = { ...state, shiftPlan: { ...state.shiftPlan, assignments: state.shiftPlan.assignments.filter(a => a.id !== id) } };
    saveToLocalStorage(newState);
    return newState;
  }),
  
  confirmShiftAssignment: (id: string) => set((state) => {
    if (!state.shiftPlan) return state;
    const newState = { ...state, shiftPlan: { ...state.shiftPlan, assignments: state.shiftPlan.assignments.map(a => a.id === id ? { ...a, confirmed: true } : a) } };
    saveToLocalStorage(newState);
    return newState;
  }),
}));
