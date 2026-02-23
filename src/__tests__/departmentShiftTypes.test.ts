import { describe, it, expect } from 'vitest';
import { getAvailableEmployeesSorted, DEFAULT_SCHEDULER_CONFIG } from '../utils/scheduler';
import { Employee, Department, ShiftAssignment } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmployee(overrides: Partial<Employee> & { id: string; name: string }): Employee {
  return {
    department: 'dept-a',
    isOver55: false,
    hasL2: true,
    vacationDays: [],
    vacationRanges: [],
    preferences: [],
    ...overrides,
  };
}

const empA = makeEmployee({ id: 'emp-a', name: 'Anna', department: 'dept-a' });
const empB = makeEmployee({ id: 'emp-b', name: 'Ben', department: 'dept-b' });
const empC = makeEmployee({ id: 'emp-c', name: 'Clara', department: 'dept-c' });

const departments: Department[] = [
  { id: 'dept-a', name: 'Abteilung A' },
  { id: 'dept-b', name: 'Abteilung B' },
  { id: 'dept-c', name: 'Abteilung C' },
];

const employees = [empA, empB, empC];
const noAssignments: ShiftAssignment[] = [];

// A Monday-to-Friday week for testing
const start = new Date('2026-01-05T00:00:00');
const end = new Date('2026-01-09T00:00:00');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Department allowedShiftTypes filtering', () => {
  it('without department-level restrictions, all employees are available', () => {
    // Department-level allowedShiftTypes was removed; all employees should pass
    const available = getAvailableEmployeesSorted(
      employees, 'fruehschicht', start, end, noAssignments, DEFAULT_SCHEDULER_CONFIG, departments
    );
    const ids = available.map(e => e.id);
    expect(ids).toContain('emp-a');
    expect(ids).toContain('emp-b');
    expect(ids).toContain('emp-c');
  });

  it('all employees are available for verschieben', () => {
    const available = getAvailableEmployeesSorted(
      employees, 'verschieben', start, end, noAssignments, DEFAULT_SCHEDULER_CONFIG, departments
    );
    const ids = available.map(e => e.id);
    expect(ids).toContain('emp-a');
    expect(ids).toContain('emp-b');
    expect(ids).toContain('emp-c');
  });

  it('all employees are available for nachtbereitschaft', () => {
    const availableNacht = getAvailableEmployeesSorted(
      employees, 'nachtbereitschaft', start, end, noAssignments, DEFAULT_SCHEDULER_CONFIG, departments
    );
    const ids = availableNacht.map(e => e.id);
    expect(ids).toContain('emp-a');
    expect(ids).toContain('emp-b');
    expect(ids).toContain('emp-c');
  });

  it('without departments parameter, all employees pass the department filter', () => {
    // No departments passed — backward compatibility
    const available = getAvailableEmployeesSorted(
      employees, 'fruehschicht', start, end, noAssignments, DEFAULT_SCHEDULER_CONFIG
    );
    const ids = available.map(e => e.id);
    expect(ids).toContain('emp-a');
    expect(ids).toContain('emp-b');
    expect(ids).toContain('emp-c');
  });
});
