// Core data types for the shift planning application

export type ShiftType = 'fruehschicht' | 'verschieben' | 'nachtbereitschaft';

// ---------------------------------------------------------------------------
// Scheduler configuration (also stored in ShiftPlan for calendar warnings)
// ---------------------------------------------------------------------------

/**
 * Behavior toggles that aren't expressible as block/condition rules (they're
 * selection strategies, not "block shift type X when Y" constraints) — kept
 * as simple on/off settings, not part of the rule builder. Every other
 * scheduling rule (the former 8 temporal SchedulerRules flags) now lives in
 * `SchedulerConfig.customRules` as an editable block-built CustomRule — see
 * BUILTIN_RULES below.
 */
export interface SchedulerRules {
  /** Respect per-employee allowedShiftTypes (filter by qualification) */
  respectEmployeeShiftTypes: boolean;
  /** Respect avoidance preferences */
  respectAvoidancePreferences: boolean;
  /** Prefer department diversity when selecting employees */
  departmentDiversity: boolean;
}

// ---------------------------------------------------------------------------
// Planning rules — a small condition-tree DSL, evaluated generically by
// src/utils/customRuleEngine.ts and enforced by the scheduler. Built (and,
// for the built-in rules below, pre-built) via the visual node editor in
// PlanningRulesEditor.tsx.
// ---------------------------------------------------------------------------

export type ConditionNode =
  | { type: 'and'; children: ConditionNode[] }
  | { type: 'or'; children: ConditionNode[] }
  | { type: 'not'; child: ConditionNode }
  /** True if the employee has another assignment of `shiftType` whose gap (in days) to the shift being considered falls within [minDays, maxDays] on the given side(s). */
  | { type: 'assignmentGap'; shiftType: ShiftType; direction: 'before' | 'after' | 'either'; minDays: number; maxDays: number }
  /** True if the employee has a vacation range overlapping the window [minDays, maxDays] before/after/either side of the shift being considered. */
  | { type: 'nearVacation'; direction: 'before' | 'after' | 'either'; minDays: number; maxDays: number }
  /** True if the shift being considered falls on a Saturday/Sunday. */
  | { type: 'isWeekend' }
  /** True if any day within the shift being considered is a Sat/Sun that falls within [minDays, maxDays] of a vacation range (start or end). Mirrors the classic "no weekend work around vacation" rule, which needs per-day (not just shift start/end) evaluation. */
  | { type: 'weekendNearVacation'; minDays: number; maxDays: number }
  /** True if the employee's attribute matches `equals` (boolean for isOver55, department id string for department). */
  | { type: 'employeeAttribute'; attribute: 'isOver55' | 'department'; equals: boolean | string };

export interface CustomRule {
  id: string;
  name: string;
  /** Free-text explanation shown in the rule's edit popup. */
  description?: string;
  enabled: boolean;
  /** Which shift type(s) this rule can block an employee from when its condition evaluates true. */
  targetShiftTypes: ShiftType[];
  condition: ConditionNode;
  /** Set on the 8 pre-built default rules (see BUILTIN_RULES) — lets "Auf Standardwerte zurücksetzen" and the one-time data migration recognize them. Absent on user-added rules. */
  builtinKey?: string;
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
  /** All block-built rules — the 8 pre-built defaults (builtinKey set) plus any user-added ones, in display order. */
  customRules: CustomRule[];
}

/**
 * The 8 rules that used to be hardcoded SchedulerRules booleans, now
 * pre-built as editable block trees — this is what "Standardwerte
 * zurücksetzen" restores and what a brand-new organization starts with.
 * Each `builtinKey` matches the old boolean's name so the one-time server
 * migration (see server/db.ts) can carry over an existing org's on/off
 * choices for periods created before this rule builder existed.
 */
export const BUILTIN_RULES: CustomRule[] = [
  {
    id: 'builtin-noWeekendAroundVacation', builtinKey: 'noWeekendAroundVacation',
    name: 'Kein Wochenenddienst direkt vor/nach Urlaub',
    description: 'Blockiert jede Wochenend-Schicht (Sa/So), wenn 1–2 Tage davor oder danach Urlaub liegt.',
    enabled: true, targetShiftTypes: ['fruehschicht', 'verschieben', 'nachtbereitschaft'],
    condition: { type: 'weekendNearVacation', minDays: 1, maxDays: 2 },
  },
  {
    id: 'builtin-noFruehschichtAdjacentToVerschieben-1', builtinKey: 'noFruehschichtAdjacentToVerschieben',
    name: 'Keine Frühschicht am Wochenende angrenzend an Versetzt-Woche',
    description: 'Blockiert Frühschicht, wenn 1–2 Tage davor oder danach eine Versetzt-Woche liegt.',
    enabled: true, targetShiftTypes: ['fruehschicht'],
    condition: { type: 'assignmentGap', shiftType: 'verschieben', direction: 'either', minDays: 1, maxDays: 2 },
  },
  {
    id: 'builtin-noFruehschichtAdjacentToVerschieben-2', builtinKey: 'noFruehschichtAdjacentToVerschieben',
    name: 'Keine Frühschicht direkt nach Nachtbereitschaft',
    description: 'Blockiert Frühschicht, wenn innerhalb der letzten 8 Tage eine Nachtbereitschaft endete.',
    enabled: true, targetShiftTypes: ['fruehschicht'],
    condition: { type: 'assignmentGap', shiftType: 'nachtbereitschaft', direction: 'before', minDays: 0, maxDays: 8 },
  },
  {
    id: 'builtin-noNachtAfterVerschieben', builtinKey: 'noNachtAfterVerschieben',
    name: 'Keine Nacht in der Folgewoche nach Versetzt-Woche',
    description: 'Blockiert Nachtbereitschaft, wenn innerhalb der letzten 8 Tage eine Versetzt-Woche endete (7-Tage-Sperre).',
    enabled: true, targetShiftTypes: ['nachtbereitschaft'],
    condition: { type: 'assignmentGap', shiftType: 'verschieben', direction: 'before', minDays: 1, maxDays: 8 },
  },
  {
    id: 'builtin-noVerschiebenAfterNacht', builtinKey: 'noVerschiebenAfterNacht',
    name: 'Kein Versetzt-Dienst in der Woche nach Nachtbereitschaft',
    description: 'Blockiert Versetzt-Dienst, wenn innerhalb der letzten 8 Tage eine Nachtbereitschaft endete (7-Tage-Sperre).',
    enabled: true, targetShiftTypes: ['verschieben'],
    condition: { type: 'assignmentGap', shiftType: 'nachtbereitschaft', direction: 'before', minDays: 1, maxDays: 8 },
  },
  {
    id: 'builtin-noConsecutiveVerschieben', builtinKey: 'noConsecutiveVerschieben',
    name: 'Keine zwei Versetzt-Wochen hintereinander',
    description: 'Blockiert eine Versetzt-Woche, wenn 1–7 Tage davor oder danach bereits eine Versetzt-Woche für dieselbe Person liegt.',
    enabled: true, targetShiftTypes: ['verschieben'],
    condition: { type: 'assignmentGap', shiftType: 'verschieben', direction: 'either', minDays: 1, maxDays: 7 },
  },
  {
    id: 'builtin-noConsecutiveNacht', builtinKey: 'noConsecutiveNacht',
    name: 'Keine zwei Nachtschichten hintereinander',
    description: 'Blockiert eine Nachtbereitschaft, wenn 1–8 Tage davor oder danach bereits eine Nachtbereitschaft für dieselbe Person liegt.',
    enabled: true, targetShiftTypes: ['nachtbereitschaft'],
    condition: { type: 'assignmentGap', shiftType: 'nachtbereitschaft', direction: 'either', minDays: 1, maxDays: 8 },
  },
  {
    id: 'builtin-noConsecutiveFruehschicht', builtinKey: 'noConsecutiveFruehschicht',
    name: 'Keine zwei Frühschichten (Wochenende) hintereinander',
    description: 'Blockiert eine Frühschicht, wenn 1–7 Tage davor oder danach bereits eine Frühschicht für dieselbe Person liegt.',
    enabled: true, targetShiftTypes: ['fruehschicht'],
    condition: { type: 'assignmentGap', shiftType: 'fruehschicht', direction: 'either', minDays: 1, maxDays: 7 },
  },
  {
    id: 'builtin-noNachtBeforeVacation', builtinKey: 'noNachtBeforeVacation',
    name: 'Keine Nachtbereitschaft in der Woche vor Urlaub',
    description: 'Blockiert Nachtbereitschaft, wenn 1–7 Tage danach Urlaub beginnt.',
    enabled: true, targetShiftTypes: ['nachtbereitschaft'],
    condition: { type: 'nearVacation', direction: 'after', minDays: 1, maxDays: 7 },
  },
];

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  shiftCounts: {
    verschieben: 5,
    nachtbereitschaft: 2,
    fruehschicht: 3,
  },
  over55VerschiebenSlots: 2,
  rules: {
    respectEmployeeShiftTypes: true,
    respectAvoidancePreferences: true,
    departmentDiversity: true,
  },
  customRules: BUILTIN_RULES.map(r => ({ ...r })),
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
  /** When true, this employee is skipped by the automatic scheduling algorithm (and any manual-assignment eligibility checks that share the same logic) and by Fairness KPI calculations — but still shown in the Kalender roster while employed. */
  excludeFromPlanning?: boolean;
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
  /** Admin-user id (Manager) assigned to this department — used to pre-select their department by default in Mitarbeiter/Kalender. */
  managerId?: string;
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

// ---------------------------------------------------------------------------
// Boards — Trello-style task boards, independent of the shift-scheduling
// domain above. See server/boards.ts for persistence/visibility logic.
// ---------------------------------------------------------------------------

export type BoardVisibility = 'private' | 'organization' | 'selected';

export interface BoardComment {
  id: string;
  authorId: string;
  /** Denormalized so the comment still reads correctly if the author account is later deleted. */
  authorName: string;
  text: string;
  attachmentIds: string[];
  createdAt: string;
}

export interface BoardSubtask {
  id: string;
  title: string;
  done: boolean;
}

export interface BoardTask {
  id: string;
  title: string;
  description?: string;
  done: boolean;
  /** ISO date (YYYY-MM-DD) */
  deadline?: string;
  /** AdminUser ids — must be a subset of who the board is shared with. */
  assigneeIds: string[];
  subtasks: BoardSubtask[];
  comments: BoardComment[];
  order: number;
  createdAt: string;
  createdBy: string;
}

export interface BoardSection {
  id: string;
  name: string;
  order: number;
  tasks: BoardTask[];
}

export interface Board {
  id: string;
  organizationId: string;
  name: string;
  /** Only 'kanban' for now — kept as a field for future board types. */
  type: 'kanban';
  visibility: BoardVisibility;
  /** Only meaningful when visibility === 'selected'. */
  visibleToUserIds?: string[];
  /** AdminUser id — always implicitly able to see/edit their own board regardless of visibility. */
  ownerId: string;
  ownerName: string;
  createdAt: string;
  sections: BoardSection[];
}
