import { describe, it, expect } from 'vitest';
import {
  generateAutomaticShiftPlan,
  getAvailableEmployeesSorted,
  isEmployeeActiveDuring,
  getEmployeeActiveWeight,
  DEFAULT_SCHEDULER_CONFIG,
} from '../utils/scheduler';
import { Employee } from '../types';

function makeEmployee(overrides: Partial<Employee> & { id: string; name: string }): Employee {
  return {
    department: 'Dept A',
    isOver55: false,
    hasL2: true,
    vacationDays: [],
    vacationRanges: [],
    preferences: [],
    ...overrides,
  };
}

describe('isEmployeeActiveDuring', () => {
  it('is active with no hire/termination dates set (always active)', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A' });
    expect(isEmployeeActiveDuring(emp, new Date(2020, 0, 1), new Date(2030, 0, 1))).toBe(true);
  });

  it('excludes a shift entirely before the hire date', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A', hireDate: new Date(2026, 5, 1) });
    expect(isEmployeeActiveDuring(emp, new Date(2026, 4, 1), new Date(2026, 4, 7))).toBe(false);
  });

  it('includes a shift starting exactly on the hire date', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A', hireDate: new Date(2026, 5, 1) });
    expect(isEmployeeActiveDuring(emp, new Date(2026, 5, 1), new Date(2026, 5, 7))).toBe(true);
  });

  it('excludes a shift that starts before hire date even if it ends after', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A', hireDate: new Date(2026, 5, 5) });
    expect(isEmployeeActiveDuring(emp, new Date(2026, 5, 1), new Date(2026, 5, 7))).toBe(false);
  });

  it('excludes a shift entirely after the termination date', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A', terminationDate: new Date(2026, 5, 30) });
    expect(isEmployeeActiveDuring(emp, new Date(2026, 6, 1), new Date(2026, 6, 7))).toBe(false);
  });

  it('includes a shift ending exactly on the termination date', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A', terminationDate: new Date(2026, 5, 30) });
    expect(isEmployeeActiveDuring(emp, new Date(2026, 5, 24), new Date(2026, 5, 30))).toBe(true);
  });

  it('excludes a shift that ends after termination date even if it starts before', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A', terminationDate: new Date(2026, 5, 26) });
    expect(isEmployeeActiveDuring(emp, new Date(2026, 5, 24), new Date(2026, 5, 30))).toBe(false);
  });

  it('respects both hire and termination dates together', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A', hireDate: new Date(2026, 2, 1), terminationDate: new Date(2026, 8, 1) });
    expect(isEmployeeActiveDuring(emp, new Date(2026, 4, 1), new Date(2026, 4, 7))).toBe(true);
    expect(isEmployeeActiveDuring(emp, new Date(2026, 0, 1), new Date(2026, 0, 7))).toBe(false);
    expect(isEmployeeActiveDuring(emp, new Date(2026, 9, 1), new Date(2026, 9, 7))).toBe(false);
  });
});

describe('getEmployeeActiveWeight', () => {
  it('returns 1 for an employee active the whole range', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A' });
    const weight = getEmployeeActiveWeight(emp, new Date(2026, 0, 1), new Date(2026, 11, 31));
    expect(weight).toBe(1);
  });

  it('returns ~0.5 for an employee hired exactly at the midpoint of a full year', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A', hireDate: new Date(2026, 6, 2) }); // Jul 2 — roughly midyear
    const weight = getEmployeeActiveWeight(emp, new Date(2026, 0, 1), new Date(2026, 11, 31));
    expect(weight).toBeGreaterThan(0.45);
    expect(weight).toBeLessThan(0.55);
  });

  it('returns 0 for an employee who left before the range started', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A', terminationDate: new Date(2025, 11, 31) });
    const weight = getEmployeeActiveWeight(emp, new Date(2026, 0, 1), new Date(2026, 11, 31));
    expect(weight).toBe(0);
  });

  it('returns 0 for an employee who was hired after the range ended', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A', hireDate: new Date(2027, 0, 1) });
    const weight = getEmployeeActiveWeight(emp, new Date(2026, 0, 1), new Date(2026, 11, 31));
    expect(weight).toBe(0);
  });
});

describe('getAvailableEmployeesSorted — employment window filtering', () => {
  it('excludes an employee not yet hired for a shift before their hire date', () => {
    const employees = [
      makeEmployee({ id: 'e1', name: 'Future Hire', hireDate: new Date(2026, 6, 1) }),
      makeEmployee({ id: 'e2', name: 'Already Here' }),
    ];
    const available = getAvailableEmployeesSorted(
      employees, 'verschieben', new Date(2026, 0, 5), new Date(2026, 0, 9), [], DEFAULT_SCHEDULER_CONFIG
    );
    expect(available.map(e => e.id)).toEqual(['e2']);
  });

  it('excludes an employee already terminated for a shift after their termination date', () => {
    const employees = [
      makeEmployee({ id: 'e1', name: 'Left Already', terminationDate: new Date(2025, 11, 31) }),
      makeEmployee({ id: 'e2', name: 'Still Here' }),
    ];
    const available = getAvailableEmployeesSorted(
      employees, 'verschieben', new Date(2026, 0, 5), new Date(2026, 0, 9), [], DEFAULT_SCHEDULER_CONFIG
    );
    expect(available.map(e => e.id)).toEqual(['e2']);
  });
});

describe('generateAutomaticShiftPlan — employment window integration', () => {
  it('never assigns a not-yet-hired or already-left employee to any shift', () => {
    const employees: Employee[] = [];
    for (let i = 1; i <= 6; i++) {
      employees.push(makeEmployee({ id: `full-${i}`, name: `Full ${i}`, department: `Dept ${i % 2}` }));
    }
    // This employee only exists for March; plan covers Jan–Jun (6 months)
    employees.push(makeEmployee({
      id: 'partial-1', name: 'Partial', department: 'Dept 0',
      hireDate: new Date(2026, 2, 1), terminationDate: new Date(2026, 2, 31),
    }));

    const config = { ...DEFAULT_SCHEDULER_CONFIG, shiftCounts: { verschieben: 3, nachtbereitschaft: 1, fruehschicht: 2 }, over55VerschiebenSlots: 0 };
    const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 6, config);

    const partialAssignments = assignments.filter(a => a.employees.includes('partial-1'));
    for (const a of partialAssignments) {
      expect(new Date(a.startDate) >= new Date(2026, 2, 1)).toBe(true);
      expect(new Date(a.endDate) <= new Date(2026, 2, 31)).toBe(true);
    }
  });

  it('gives a half-period employee roughly half the shifts of a full-period employee (proportional fairness)', () => {
    const employees: Employee[] = [];
    // 8 full-period employees, enough to cover requirements comfortably
    for (let i = 1; i <= 8; i++) {
      employees.push(makeEmployee({ id: `full-${i}`, name: `Full ${i}`, department: `Dept ${i % 3}` }));
    }
    // 1 employee active only for the first half of the 12-month period
    employees.push(makeEmployee({
      id: 'half-1', name: 'Half', department: 'Dept 0',
      hireDate: new Date(2026, 0, 1), terminationDate: new Date(2026, 5, 30),
    }));

    const config = { ...DEFAULT_SCHEDULER_CONFIG, shiftCounts: { verschieben: 4, nachtbereitschaft: 1, fruehschicht: 2 }, over55VerschiebenSlots: 0 };
    const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 12, config);

    const countFor = (id: string) => assignments.filter(a => a.employees.includes(id)).length;
    const fullCounts = employees.filter(e => e.id.startsWith('full-')).map(e => countFor(e.id));
    const avgFull = fullCounts.reduce((s, c) => s + c, 0) / fullCounts.length;
    const halfCount = countFor('half-1');

    // The half-period employee should end up with roughly half the shifts of a
    // full-period peer — not zero, and not the same as a full-period peer.
    expect(halfCount).toBeGreaterThan(0);
    expect(halfCount).toBeLessThan(avgFull);
    expect(halfCount).toBeGreaterThan(avgFull * 0.25);
    expect(halfCount).toBeLessThan(avgFull * 0.75);
  });
});
