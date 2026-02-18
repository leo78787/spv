// Core data types for the shift planning application

export type ShiftType = 'fruehschicht' | 'verschieben' | 'nachtbereitschaft';

export interface VacationRange {
  startDate: Date;
  endDate: Date;
}

export interface Employee {
  id: string;
  name: string;
  department: string;
  isOver55: boolean;
  hasL2: boolean;
  vacationDays: Date[]; // single-day entries for backward compatibility
  vacationRanges?: VacationRange[]; // new: multi‑day ranges
  preferences: ShiftPreference[];
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

export interface ShiftPlan {
  year: number;                // start year for the plan (backwards compatible)
  startMonth?: number;         // 0 = Januar — optional, present when plan had start month selected
  months?: number;             // number of months included in the plan (typically 12)
  assignments: ShiftAssignment[];
}

// Label types for calendar markings (e.g., training, meetings, etc.)
export interface Label {
  id: string;
  name: string;                // e.g., "Schulung"
  letter: string;              // e.g., "S" - single character abbreviation
  color: string;               // hex color e.g., "#3b82f6"
  text?: string;               // optional additional text
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
  verschieben: { count: 4, duration: 'weekdays', days: 'Mo-Fr' },
  nachtbereitschaft: { count: 2, duration: 'weekly', days: 'Sa-Sa' }
};

export const SHIFT_LABELS: Record<ShiftType, string> = {
  fruehschicht: 'Frühschicht (Wochenende)',
  verschieben: 'Verschobene Schicht',
  nachtbereitschaft: 'Nachtbereitschaft'
};
