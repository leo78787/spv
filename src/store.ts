import { create } from 'zustand';
import { Employee, Department, ShiftAssignment, PlanningPeriod, Holiday, Label, CalendarLabel, SchedulerConfig, DEFAULT_SCHEDULER_CONFIG, SwapSettings, DEFAULT_SWAP_SETTINGS, TabVisibility, DEFAULT_TAB_VISIBILITY } from './types';

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

/** Re-confirm a destructive/administrative action with the currently logged-in admin's or Leitung's own password. */
export async function verifyAdminPassword(password: string): Promise<boolean> {
  const token = getAuthToken();
  if (!token) return false;
  try {
    const resp = await fetch('/api/admin/verify-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ password }),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!data.valid;
  } catch {
    return false;
  }
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
        planningPeriods: state.planningPeriods,
        customHolidays: state.customHolidays,
        labels: state.labels,
        calendarLabels: state.calendarLabels,
        swapSettings: state.swapSettings,
        tabVisibility: state.tabVisibility,
        betrachterTabVisibility: state.betrachterTabVisibility,
        defaultSchedulerConfig: state.defaultSchedulerConfig,
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
    if (resp.status === 401) {
      // Session token no longer valid (e.g. the server was restarted and
      // in-memory sessions were lost) — drop back to the login screen
      // instead of silently getting stuck on stale/empty data.
      clearAuthToken();
      useStore.setState({ sessionExpired: true });
      return;
    }
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
      planningPeriods: revived.planningPeriods ?? [],
      customHolidays: revived.customHolidays ?? [],
      labels: revived.labels ?? [],
      calendarLabels: revived.calendarLabels ?? [],
      swapSettings: revived.swapSettings ?? DEFAULT_SWAP_SETTINGS,
      tabVisibility: revived.tabVisibility ?? DEFAULT_TAB_VISIBILITY,
      betrachterTabVisibility: revived.betrachterTabVisibility ?? DEFAULT_TAB_VISIBILITY,
      defaultSchedulerConfig: revived.defaultSchedulerConfig ?? DEFAULT_SCHEDULER_CONFIG,
    });
  } catch (err) {
    console.error('Error loading from server:', err);
  }
}

interface AppState {
  employees: Employee[];
  departments: Department[];
  currentYear: number;
  planningPeriods: PlanningPeriod[];
  customHolidays: Holiday[];
  labels: Label[];
  calendarLabels: CalendarLabel[];
  swapSettings: SwapSettings;
  tabVisibility: TabVisibility;
  /** Separate, independently configurable tab visibility for the read-only Betrachter role. */
  betrachterTabVisibility: TabVisibility;
  /** Organization-wide standard planning rules — new planning periods default to a copy of this (see server POST /api/periods). Edited/saved via PlanningRulesEditor's "Als Standard speichern" action. */
  defaultSchedulerConfig: SchedulerConfig;

  // Current admin session info (role-based UI, e.g. default department filter for Leitung)
  adminRole: 'admin' | 'leitung' | 'betrachter' | 'forderung' | null;
  organizationName: string | null;
  /** This session's own AdminUser id/name (null for the legacy fallback session, if any still exist). Used e.g. by the vacation calendar to tell "my entries" apart from others'. */
  myAdminUserId: string | null;
  myName: string | null;
  defaultDepartmentId: string | null;
  /** Permission areas the current session may mutate. Full list for admin, granted subset for leitung, empty for betrachter. */
  permissions: string[];
  /** Org-wide max tab set for this session's role (Admin-controlled) — tabVisibility for admin/leitung, betrachterTabVisibility for betrachter. */
  orgTabVisibility: TabVisibility;
  /** This account's own personal show/hide preference (Leitung/Betrachter self-service), within orgTabVisibility. */
  personalTabVisibility: Record<string, boolean>;
  /** orgTabVisibility AND personalTabVisibility — what App.tsx actually renders. */
  effectiveTabVisibility: TabVisibility;
  loadAdminMe: () => Promise<void>;
  /** Self-service: Leitung/Betrachter updates their own personal tab preference. */
  saveMyTabVisibility: (vis: Record<string, boolean>) => Promise<void>;
  // Set by loadFromServer()/loadAdminMe() when the server rejects the stored
  // token (401) — App.tsx watches this to drop back to the login screen.
  sessionExpired: boolean;

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

  // Batch import
  batchImport: (newDepartments: Department[], newEmployees: Employee[]) => void;

  // Swap settings
  setSwapSettings: (settings: SwapSettings) => void;

  // Tab visibility
  setTabVisibility: (vis: TabVisibility) => void;
  setBetrachterTabVisibility: (vis: TabVisibility) => void;

  /** Save the given config as the organization's standard planning rules — new periods will default to it. */
  setDefaultSchedulerConfig: (config: SchedulerConfig) => void;

  // Calendar month-navigation cursor (independent of planning periods)
  setCurrentYear: (year: number) => void;

  // ── Planning periods ──────────────────────────────────────────────
  // Create/update/delete/release/lock go through dedicated REST endpoints
  // (for server-side overlap validation and release-email side effects),
  // then update local state from the server's response.
  loadPlanningPeriods: () => Promise<void>;
  createPlanningPeriod: (input: { name?: string; year: number; startMonth: number; months: number; schedulerConfig?: SchedulerConfig }) => Promise<{ period: PlanningPeriod; overlapWarning: string | null } | null>;
  updatePlanningPeriod: (id: string, input: { name?: string; year?: number; startMonth?: number; months?: number; schedulerConfig?: SchedulerConfig }) => Promise<{ period: PlanningPeriod; overlapWarning: string | null } | null>;
  deletePlanningPeriod: (id: string) => Promise<boolean>;
  setPeriodReleased: (id: string, released: boolean) => Promise<boolean>;
  setPeriodLocked: (id: string, locked: boolean) => Promise<boolean>;
  /** Replace a period's contents locally after /api/generate or an optimiser endpoint already persisted it server-side. */
  applyGeneratedPeriod: (period: PlanningPeriod) => void;
  /** Merge arbitrary content (assignments/violations/algorithm/schedulerConfig) into an existing period and autosave — used by JSON import. */
  importPeriodContent: (periodId: string, updates: Partial<PlanningPeriod>) => void;
  /** Clear a period's generated assignments/violations/algorithm (keeps its date range/name) and autosave. */
  clearPeriodAssignments: (periodId: string) => void;

  // Per-assignment edits within a period (simple local mutation + autosave, like before)
  updateShiftAssignment: (periodId: string, assignment: ShiftAssignment) => void;
  deleteShiftAssignment: (periodId: string, id: string) => void;
  confirmShiftAssignment: (periodId: string, id: string) => void;
  acknowledgeViolation: (periodId: string, id: string) => void;
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
    planningPeriods: [] as PlanningPeriod[],
    customHolidays: [] as Holiday[],
    labels: [] as Label[],
    calendarLabels: [] as CalendarLabel[],
    swapSettings: DEFAULT_SWAP_SETTINGS,
    tabVisibility: DEFAULT_TAB_VISIBILITY,
    betrachterTabVisibility: DEFAULT_TAB_VISIBILITY,
    defaultSchedulerConfig: DEFAULT_SCHEDULER_CONFIG,

    adminRole: null as 'admin' | 'leitung' | 'betrachter' | 'forderung' | null,
    organizationName: null as string | null,
    myAdminUserId: null as string | null,
    myName: null as string | null,
    defaultDepartmentId: null as string | null,
    permissions: [] as string[],
    orgTabVisibility: DEFAULT_TAB_VISIBILITY,
    personalTabVisibility: {} as Record<string, boolean>,
    effectiveTabVisibility: DEFAULT_TAB_VISIBILITY,
    sessionExpired: false,
    loadAdminMe: async () => {
      const token = getAuthToken();
      if (!token) return;
      try {
        const resp = await fetch('/api/admin/me', { headers: { Authorization: `Bearer ${token}` } });
        if (resp.status === 401) {
          clearAuthToken();
          useStore.setState({ sessionExpired: true });
          return;
        }
        if (!resp.ok) return;
        const data = await resp.json();
        set((state) => ({
          ...state,
          adminRole: data.role ?? null,
          organizationName: data.organizationName ?? null,
          myAdminUserId: data.adminUserId ?? null,
          myName: data.name ?? null,
          defaultDepartmentId: data.defaultDepartmentId ?? null,
          permissions: data.permissions ?? [],
          tabVisibility: data.tabVisibility ?? state.tabVisibility,
          betrachterTabVisibility: data.betrachterTabVisibility ?? state.betrachterTabVisibility,
          orgTabVisibility: data.orgTabVisibility ?? state.orgTabVisibility,
          personalTabVisibility: data.personalTabVisibility ?? state.personalTabVisibility,
          effectiveTabVisibility: data.effectiveTabVisibility ?? state.effectiveTabVisibility,
        }));
      } catch (err) {
        console.error('Error loading admin session info:', err);
      }
    },

    saveMyTabVisibility: async (vis: Record<string, boolean>) => {
      const token = getAuthToken();
      if (!token) return;
      try {
        const resp = await fetch('/api/admin/my-tab-visibility', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ personalTabVisibility: vis }),
        });
        if (!resp.ok) return;
        await useStore.getState().loadAdminMe();
      } catch (err) {
        console.error('Error saving personal tab visibility:', err);
      }
    },

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

    // Swap settings
    setSwapSettings: (settings: SwapSettings) => set((state) => {
      const newState = { ...state, swapSettings: settings };
      saveToServer(newState);
      return newState;
    }),

    // Tab visibility
    setTabVisibility: (vis: TabVisibility) => set((state) => {
      const newState = { ...state, tabVisibility: vis };
      saveToServer(newState);
      return newState;
    }),

    setBetrachterTabVisibility: (vis: TabVisibility) => set((state) => {
      const newState = { ...state, betrachterTabVisibility: vis };
      saveToServer(newState);
      return newState;
    }),

    setDefaultSchedulerConfig: (config: SchedulerConfig) => set((state) => {
      const newState = { ...state, defaultSchedulerConfig: config };
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

    batchImport: (newDepartments: Department[], newEmployees: Employee[]) => set((state) => {
      const newState = {
        ...state,
        departments: [...state.departments, ...newDepartments],
        employees: [...state.employees, ...newEmployees],
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

    // ── Planning periods ────────────────────────────────────────────
    loadPlanningPeriods: async () => {
      const token = getAuthToken();
      if (!token) return;
      try {
        const resp = await fetch('/api/state', { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) return;
        const raw = await resp.json();
        const revived = reviveDatesInState(raw);
        set((state) => ({ ...state, planningPeriods: revived.planningPeriods ?? [] }));
      } catch (err) {
        console.error('Error loading planning periods:', err);
      }
    },

    createPlanningPeriod: async (input: { name?: string; year: number; startMonth: number; months: number; schedulerConfig?: SchedulerConfig }) => {
      const token = getAuthToken();
      if (!token) return null;
      try {
        const resp = await fetch('/api/periods', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(input, dateNoonReplacer),
        });
        const data = await resp.json();
        if (!resp.ok) { console.error('createPlanningPeriod failed:', data?.error); return null; }
        const period = reviveDatesInState(data.period) as PlanningPeriod;
        set((state) => ({ ...state, planningPeriods: [...state.planningPeriods, period] }));
        return { period, overlapWarning: data.overlapWarning ?? null };
      } catch (err) {
        console.error('Error creating planning period:', err);
        return null;
      }
    },

    updatePlanningPeriod: async (id: string, input: { name?: string; year?: number; startMonth?: number; months?: number; schedulerConfig?: SchedulerConfig }) => {
      const token = getAuthToken();
      if (!token) return null;
      try {
        const resp = await fetch(`/api/periods/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(input, dateNoonReplacer),
        });
        const data = await resp.json();
        if (!resp.ok) { console.error('updatePlanningPeriod failed:', data?.error); return null; }
        const period = reviveDatesInState(data.period) as PlanningPeriod;
        set((state) => ({ ...state, planningPeriods: state.planningPeriods.map(p => p.id === id ? period : p) }));
        return { period, overlapWarning: data.overlapWarning ?? null };
      } catch (err) {
        console.error('Error updating planning period:', err);
        return null;
      }
    },

    deletePlanningPeriod: async (id: string) => {
      const token = getAuthToken();
      if (!token) return false;
      try {
        const resp = await fetch(`/api/periods/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) return false;
        set((state) => ({ ...state, planningPeriods: state.planningPeriods.filter(p => p.id !== id) }));
        return true;
      } catch (err) {
        console.error('Error deleting planning period:', err);
        return false;
      }
    },

    setPeriodReleased: async (id: string, released: boolean) => {
      const token = getAuthToken();
      if (!token) return false;
      try {
        const resp = await fetch(`/api/periods/${id}/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ released }),
        });
        const data = await resp.json();
        if (!resp.ok) { console.error('setPeriodReleased failed:', data?.error); return false; }
        const period = reviveDatesInState(data.period) as PlanningPeriod;
        set((state) => ({ ...state, planningPeriods: state.planningPeriods.map(p => p.id === id ? period : p) }));
        return true;
      } catch (err) {
        console.error('Error releasing planning period:', err);
        return false;
      }
    },

    setPeriodLocked: async (id: string, locked: boolean) => {
      const token = getAuthToken();
      if (!token) return false;
      try {
        const resp = await fetch(`/api/periods/${id}/lock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ locked }),
        });
        const data = await resp.json();
        if (!resp.ok) { console.error('setPeriodLocked failed:', data?.error); return false; }
        const period = reviveDatesInState(data.period) as PlanningPeriod;
        set((state) => ({ ...state, planningPeriods: state.planningPeriods.map(p => p.id === id ? period : p) }));
        return true;
      } catch (err) {
        console.error('Error locking planning period:', err);
        return false;
      }
    },

    applyGeneratedPeriod: (period: PlanningPeriod) => set((state) => ({
      ...state,
      planningPeriods: state.planningPeriods.map(p => p.id === period.id ? period : p),
    })),

    importPeriodContent: (periodId: string, updates: Partial<PlanningPeriod>) => set((state) => {
      const period = state.planningPeriods.find(p => p.id === periodId);
      if (!period) return state;
      const newState = {
        ...state,
        planningPeriods: state.planningPeriods.map(p => p.id === periodId ? { ...p, ...updates } : p),
      };
      saveToServer(newState);
      return newState;
    }),

    clearPeriodAssignments: (periodId: string) => set((state) => {
      const period = state.planningPeriods.find(p => p.id === periodId);
      if (!period) return state;
      const newState = {
        ...state,
        planningPeriods: state.planningPeriods.map(p =>
          p.id === periodId ? { ...p, assignments: [], violations: [], algorithm: undefined } : p
        ),
      };
      saveToServer(newState);
      return newState;
    }),

    acknowledgeViolation: (periodId: string, id: string) => set((state) => {
      const period = state.planningPeriods.find(p => p.id === periodId);
      if (!period) return state;
      const newState = {
        ...state,
        planningPeriods: state.planningPeriods.map(p =>
          p.id === periodId ? { ...p, violations: (p.violations ?? []).filter(v => v.id !== id) } : p
        ),
      };
      saveToServer(newState);
      return newState;
    }),

    updateShiftAssignment: (periodId: string, assignment: ShiftAssignment) => set((state) => {
      const period = state.planningPeriods.find(p => p.id === periodId);
      if (!period) return state;

      const existingIndex = period.assignments.findIndex(a => a.id === assignment.id);
      const newAssignments = existingIndex >= 0
        ? period.assignments.map((a, i) => i === existingIndex ? assignment : a)
        : [...period.assignments, assignment];

      const newState = {
        ...state,
        planningPeriods: state.planningPeriods.map(p =>
          p.id === periodId ? { ...p, assignments: newAssignments } : p
        ),
      };
      saveToServer(newState);
      return newState;
    }),
    
    deleteShiftAssignment: (periodId: string, id: string) => set((state) => {
      const period = state.planningPeriods.find(p => p.id === periodId);
      if (!period) return state;
      const newState = {
        ...state,
        planningPeriods: state.planningPeriods.map(p =>
          p.id === periodId ? { ...p, assignments: p.assignments.filter(a => a.id !== id) } : p
        ),
      };
      saveToServer(newState);
      return newState;
    }),
    
    confirmShiftAssignment: (periodId: string, id: string) => set((state) => {
      const period = state.planningPeriods.find(p => p.id === periodId);
      if (!period) return state;
      const newState = {
        ...state,
        planningPeriods: state.planningPeriods.map(p =>
          p.id === periodId
            ? { ...p, assignments: p.assignments.map(a => a.id === id ? { ...a, confirmed: true } : a) }
            : p
        ),
      };
      saveToServer(newState);
      return newState;
    }),
  };
  
  return initialState;
});
