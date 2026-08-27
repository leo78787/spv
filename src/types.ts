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
  /** No two consecutive Nachtbereitschaft weeks for the same employee */
  noConsecutiveNacht: boolean;
  /** No two consecutive weekend Frühschicht shifts for the same employee */
  noConsecutiveFruehschicht: boolean;
  /** No Nachtbereitschaft in the week before a vacation starts */
  noNachtBeforeVacation: boolean;
  /** Respect per-employee allowedShiftTypes (filter by qualification) */
  respectEmployeeShiftTypes: boolean;
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
  /** How many of the verschieben slots per week are reserved for Ü55 employees */
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
    noConsecutiveNacht: true,
    noConsecutiveFruehschicht: true,
    noNachtBeforeVacation: true,
    respectEmployeeShiftTypes: true,
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
  /** Which shift types this employee is allowed to work */
  allowedShiftTypes?: ShiftType[];
  // Legacy fields kept for backward compatibility during migration
  isOver55?: boolean;
  hasL2?: boolean;
  vacationDays: Date[]; // single-day entries for backward compatibility
  vacationRanges?: VacationRange[]; // new: multi‑day ranges
  preferences: ShiftPreference[];
  /** Employee portal status: 'none' | 'invited' | 'draft' | 'submitted' */
  portalStatus?: 'none' | 'invited' | 'draft' | 'submitted';
  /** Employee-controlled email notification preferences (portal settings) */
  notificationPreferences?: NotificationPreferences;
  /** Eintrittsdatum — date the employee joined. Undefined = employed since before any planning period. */
  hireDate?: Date;
  /** Austrittsdatum — date the employee left. Undefined = still employed. */
  terminationDate?: Date;
  /** Which planning period the employee last selected in their portal (Einstellungen). Server-resolved default when unset. */
  portalSelectedPeriodId?: string;
}

// ── Employee portal notification preferences ────────────────────────

export interface NotificationPreferences {
  /** Notify by email when the admin releases a new shift plan */
  planRelease: boolean;
  /** Notify by email when an already-released plan changes (shifts/labels visible to this employee) */
  scheduleChanges: boolean;
  /** Notify by email when a shift swap/takeover match is approved */
  swapMatches: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  planRelease: true,
  scheduleChanges: true,
  swapMatches: true,
};

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

// ── Planning periods ─────────────────────────────────────────────────
//
// The app used to support exactly one global shift plan/year. It now
// supports any number of independent "Planungsperioden" — each with its
// own date range, its own generated assignments, and its own release /
// employee-lock status. A PlanningPeriod is a ShiftPlan (the generated
// content) plus period-level metadata and admin controls.

export interface PlanningPeriod extends ShiftPlan {
  id: string;
  /** Optional human-readable label, e.g. "2026" or "Sommer 2026". Falls back to a date-based label when absent. */
  name?: string;
  /** Whether this period's shift plan has been released to employees (visible in their portal/calendar). */
  released: boolean;
  /** Whether employee self-service changes (vacation/preferences) are locked for this period. */
  employeesLocked: boolean;
  createdAt: string;
  updatedAt?: string;
}

/** Inclusive [start, end) day-range helper for a planning period. */
export function getPeriodDateRange(period: Pick<PlanningPeriod, 'year' | 'startMonth' | 'months'>): { start: Date; end: Date } {
  const startMonth = period.startMonth ?? 0;
  const months = period.months ?? 12;
  const start = new Date(period.year, startMonth, 1);
  const end = new Date(period.year, startMonth + months, 0); // last day of the range, inclusive
  return { start, end };
}

/** Whether two planning periods' date ranges overlap (inclusive). */
export function periodsOverlap(a: Pick<PlanningPeriod, 'year' | 'startMonth' | 'months'>, b: Pick<PlanningPeriod, 'year' | 'startMonth' | 'months'>): boolean {
  const ra = getPeriodDateRange(a);
  const rb = getPeriodDateRange(b);
  return ra.start <= rb.end && rb.start <= ra.end;
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

export type ViewTab = 'employees' | 'departments' | 'planning' | 'calendar' | 'kpis' | 'swaps';

// ── Tab visibility settings ────────────────────────────────────────

export interface TabVisibility {
  employees: boolean;
  departments: boolean;
  planning: boolean;
  calendar: boolean;
  kpis: boolean;
  swaps: boolean;
}

export const DEFAULT_TAB_VISIBILITY: TabVisibility = {
  employees: true,
  departments: true,
  planning: true,
  calendar: true,
  kpis: true,
  swaps: true,
};

// ── Swap settings ────────────────────────────────────────────────────

export interface SwapSettings {
  /** Master toggle for the swap feature */
  enabled: boolean;
  /** Only allow swaps within the same department */
  onlyWithinDepartment: boolean;
  /** Only allow swaps of the same shift type */
  onlyWithinShiftType: boolean;
  /** Allow ring swaps (A→B→C→A circular trades) */
  allowRingSwap: boolean;
  /** Allow employees to directly take over an offered shift with no shift given in return */
  allowDirectTakeover: boolean;
}

export const DEFAULT_SWAP_SETTINGS: SwapSettings = {
  enabled: false,
  onlyWithinDepartment: false,
  onlyWithinShiftType: false,
  allowRingSwap: false,
  allowDirectTakeover: false,
};

// ── Swap requests & matches ─────────────────────────────────────────

export interface SwapOffer {
  id: string;
  employeeId: string;
  /** The assignment ID the employee wants to give away */
  assignmentId: string;
  shiftType: ShiftType;
  startDate: string; // ISO date
  endDate: string;   // ISO date
  /** Timeframe(s) the employee is willing to work instead */
  willingRanges: { startDate: string; endDate: string }[];
  /** If shift-type change is allowed, which types the employee would accept */
  willingShiftTypes?: ShiftType[];
  /** Timestamp when the offer was created */
  createdAt: string;
  /** Whether this offer is still active */
  status: 'open' | 'matched' | 'withdrawn';
}

export interface SwapMatch {
  id: string;
  offerA: string; // SwapOffer.id
  /** For direct swaps: the other party's offer. Absent for direct takeovers. */
  offerB?: string; // SwapOffer.id
  /** For ring swaps: ordered list of offer IDs forming the ring (A→B→C→...→A) */
  ringOffers?: string[];
  /** For direct takeovers: the employee who wants to take over offerA's shift with no shift given in return */
  takeoverEmployeeId?: string;
  /** Admin decision */
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  resolvedAt?: string;
}

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
