// Core data types for the shift planning application

export type ShiftType = 'fruehschicht' | 'verschieben' | 'nachtbereitschaft';

// ---------------------------------------------------------------------------
// Scheduler configuration (also stored in ShiftPlan for calendar warnings)
// ---------------------------------------------------------------------------

export interface SchedulerRules {
  /** No weekend work adjacent to vacation days */
  noWeekendAroundVacation: boolean;
  /** Frühschicht blocked on weekends directly adjacent to a verschieben week */
  noFruehschichtAdjacentToVerschieben: boolean;
  /** No Nacht in the 7 days following a verschieben week */
  noNachtAfterVerschieben: boolean;
  /** No Verschieben in the 7 days following a Nacht week (symmetric rule) */
  noVerschiebenAfterNacht: boolean;
  /** No two consecutive Verschieben weeks for the same employee */
  noConsecutiveVerschieben: boolean;
  /** Ü55 and employees without L2 may only work verschieben */
  over55AndNoL2OnlyVerschieben: boolean;
  /** Reserve slots in verschieben specifically for Ü55 employees */
  reserveOver55SlotsForVerschieben: boolean;
  /** Respect avoidance preferences */
  respectAvoidancePreferences: boolean;
  /** Prefer department diversity when selecting employees */
  departmentDiversity: boolean;
}

export interface SchedulerConfig {
  shiftCounts: {
    verschieben: number;
    nachtbereitschaft: number;
    fruehschicht: number;
  };
  /** How many of the verschieben slots are reserved for Ü55 employees */
  over55VerschiebenSlots: number;
  rules: SchedulerRules;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  shiftCounts: {
    verschieben: 5,
    nachtbereitschaft: 2,
    fruehschicht: 3,
  },
  over55VerschiebenSlots: 2,
  rules: {
    noWeekendAroundVacation: true,
    noFruehschichtAdjacentToVerschieben: true,
    noNachtAfterVerschieben: true,
    noVerschiebenAfterNacht: true,
    noConsecutiveVerschieben: true,
    over55AndNoL2OnlyVerschieben: true,
    reserveOver55SlotsForVerschieben: true,
    respectAvoidancePreferences: true,
    departmentDiversity: true,
  },
};

export interface VacationRange {
  startDate: Date;
  endDate: Date;
}

export interface Employee {
  id: string;
  name: string;
  email?: string;
  department: string;
  isOver55: boolean;
  hasL2: boolean;
  vacationDays: Date[]; // single-day entries for backward compatibility
  vacationRanges?: VacationRange[]; // new: multi‑day ranges
  preferences: ShiftPreference[];
  /** Employee portal status: 'none' | 'invited' | 'draft' | 'submitted' */
  portalStatus?: 'none' | 'invited' | 'draft' | 'submitted';
}

export interface Holiday {
  id: string;
  date: string; // ISO yyyy-MM-dd
  name: string;
  disabled?: boolean; // if true, hide this date (used to suppress built-in holidays)
}

export interface ShiftPreference {
  shiftType: ShiftType;
  startDate: Date;
  endDate: Date;
  preferred: boolean; // true = wants this shift, false = doesn't want this shift
}

export interface ShiftAssignment {
  id: string;
  shiftType: ShiftType;
  startDate: Date;
  endDate: Date;
  employees: string[]; // employee IDs
  confirmed: boolean;
}

export interface ShiftSuggestion {
  shiftType: ShiftType;
  startDate: Date;
  endDate: Date;
  suggestedEmployees: SuggestedEmployee[];
}

export interface SuggestedEmployee {
  employeeId: string;
  score: number;
  reasons: string[];
}

export interface Department {
  id: string;
  name: string;
}

/** A shift period that could not be fully staffed during auto-generation */
export interface SchedulerViolation {
  id: string;
  shiftType: ShiftType;
  startDate: Date;
  endDate: Date;
  required: number;         // how many employees were required
  assigned: number;         // how many could actually be assigned
  assignedEmployeeIds: string[];
  blockedRules: string[];   // human-readable rule names that caused the shortage
}

export interface ShiftPlan {
  year: number;                // start year for the plan (backwards compatible)
  startMonth?: number;         // 0 = Januar — optional, present when plan had start month selected
  months?: number;             // number of months included in the plan (typically 12)
  schedulerConfig?: SchedulerConfig; // config used when generating this plan
  violations?: SchedulerViolation[]; // unresolved staffing violations from last generation
  assignments: ShiftAssignment[];
  /** Describes which algorithm or method produced this plan (e.g. "generiert", "fairness-optimiert", "importiert"). */
  algorithm?: string;
}

// Label types for calendar markings (e.g., training, meetings, etc.)
export interface Label {
  id: string;
  name: string;                // e.g., "Schulung"
  letter: string;              // e.g., "S" - single character abbreviation
  color: string;               // hex color e.g., "#3b82f6"
  text?: string;               // optional additional text
  visibleToEmployee?: boolean; // whether this label is visible in the employee portal
}

export interface CalendarLabel {
  id: string;
  employeeId: string;
  date: string;                // ISO date string YYYY-MM-DD
  labelId: string;             // references Label.id
}

export type ViewTab = 'employees' | 'departments' | 'planning' | 'calendar' | 'kpis';

// Shift requirements
export const SHIFT_REQUIREMENTS: Record<ShiftType, { count: number; duration: string; days: string }> = {
  fruehschicht: { count: 3, duration: 'weekend', days: 'Sa-So' },
  verschieben: { count: 5, duration: 'weekdays', days: 'Mo-Fr' },
  nachtbereitschaft: { count: 2, duration: 'weekly', days: 'Sa-Sa' }
};

export const SHIFT_LABELS: Record<ShiftType, string> = {
  fruehschicht: 'Frühschicht (Wochenende)',
  verschieben: 'Verschobene Schicht',
  nachtbereitschaft: 'Nachtbereitschaft'
};
