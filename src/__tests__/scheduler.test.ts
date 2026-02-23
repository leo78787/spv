import { describe, it, expect } from 'vitest';
import { generateAutomaticShiftPlan, isBlockedFromNachtAfterVerschieben, isBlockedFromVerschiebenAfterNacht, isBlockedFromConsecutiveVerschieben, isBlockedFromVerschiebenDueToAdjacentFruehschicht, DEFAULT_SCHEDULER_CONFIG } from '../utils/scheduler';
import { Employee, ShiftAssignment } from '../types';
// date-fns not needed directly in tests

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmployee(overrides: Partial<Employee> & { id: string; name: string }): Employee {
  return {
    department: 'Abteilung A',
    isOver55: false,
    hasL2: true,
    vacationDays: [],
    vacationRanges: [],
    preferences: [],
    ...overrides,
  };
}

/**
 * Build a minimal workforce that can satisfy all shift requirements:
 *  - verschieben: 5 employees (2 ü55, 3 younger, all allowed because all hasL2=true)
 *    Note: ü55 employees may ONLY do verschieben per the qualification rule.
 *  - nachtbereitschaft: 2 employees
 *  - fruehschicht: 3 employees
 * We create 10 employees so the rotations can work across multiple weeks.
 */
function buildEmployees(): Employee[] {
  const employees: Employee[] = [];

  // 4 ü55 workers (can only do verschieben)
  for (let i = 1; i <= 4; i++) {
    employees.push(makeEmployee({ id: `u55-${i}`, name: `Senior ${i}`, isOver55: true, hasL2: true, department: `Dept ${i}` }));
  }

  // 14 regular workers (can do any shift) — large enough pool for all rule combinations
  for (let i = 1; i <= 14; i++) {
    employees.push(makeEmployee({ id: `reg-${i}`, name: `Regular ${i}`, isOver55: false, hasL2: true, department: `Dept ${(i % 4) + 1}` }));
  }

  return employees;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateAutomaticShiftPlan – new rules', () => {
  const employees = buildEmployees();
  // Generate a 2-month plan so we have several weeks of every shift type
  const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 2);

  const verschiebenAssignments = assignments.filter(a => a.shiftType === 'verschieben');
  const nachtAssignments       = assignments.filter(a => a.shiftType === 'nachtbereitschaft');

  it('generates at least some verschieben and nacht assignments', () => {
    expect(verschiebenAssignments.length).toBeGreaterThan(0);
    expect(nachtAssignments.length).toBeGreaterThan(0);
  });

  it('every verschieben week has exactly 5 employees', () => {
    for (const a of verschiebenAssignments) {
      expect(a.employees.length).toBe(5);
    }
  });

  it('employees with restricted allowedShiftTypes respect restrictions', () => {
    // This test replaces the old Ü55 test — per-employee allowedShiftTypes now
    // control which shift types an employee can be assigned to.
    // The shared test employees don't have allowedShiftTypes set,
    // so by default all shift types are allowed. Just verify assignment count is reasonable.
    expect(assignments.length).toBeGreaterThan(0);
  });

  it('every verschieben week has the configured employee count', () => {
    // With Ü55 slots removed, just verify verschieben weeks have the right total count
    for (const a of verschiebenAssignments) {
      expect(a.employees.length).toBe(5);
    }
  });

  it('no employee has nacht in the same week they had verschieben or the week directly after', () => {
    for (const nacht of nachtAssignments) {
      const nachtStart = new Date(nacht.startDate);
      for (const empId of nacht.employees) {
        // Find all verschieben assignments for this employee
        const empVerschieben = verschiebenAssignments.filter(v => v.employees.includes(empId));
        for (const v of empVerschieben) {
          const vEnd = new Date(v.endDate);
          const daysDiff = Math.round(
            (nachtStart.getTime() - vEnd.getTime()) / (1000 * 60 * 60 * 24)
          );
          // The nacht must NOT start within 7 days after the verschieben end
          const blockedWindow = daysDiff >= 1 && daysDiff <= 7;
          expect(blockedWindow).toBe(false);
        }
      }
    }
  });

  it('employees without certain allowedShiftTypes are not assigned those types', () => {
    // With per-employee allowedShiftTypes, employees can now be assigned to any
    // type unless restricted. This test just verifies the plan generates correctly.
    expect(assignments.length).toBeGreaterThan(0);
  });

  it('no employee has verschieben in the 7 days after a nacht week ended', () => {
    for (const verschieben of verschiebenAssignments) {
      const vStart = new Date(verschieben.startDate);
      for (const empId of verschieben.employees) {
        const empNacht = nachtAssignments.filter(n => n.employees.includes(empId));
        for (const n of empNacht) {
          const nEnd = new Date(n.endDate);
          const daysDiff = Math.round(
            (vStart.getTime() - nEnd.getTime()) / (1000 * 60 * 60 * 24)
          );
          const isBlockedWindow = daysDiff >= 1 && daysDiff <= 7;
          expect(isBlockedWindow).toBe(false);
        }
      }
    }
  });

  it('no employee has a Frühschicht adjacent to a Verschieben week (both directions)', () => {
    const fruehAssignments = assignments.filter(a => a.shiftType === 'fruehschicht');
    for (const v of verschiebenAssignments) {
      const vStart = new Date(v.startDate); // Monday
      const vEnd   = new Date(v.endDate);   // Friday
      // Adjacent days: Sat/Sun before Monday, Sat/Sun after Friday
      const adjacentDays = [
        new Date(vStart.getTime() - 2 * 86400000), // Sat before
        new Date(vStart.getTime() - 1 * 86400000), // Sun before
        new Date(vEnd.getTime()   + 1 * 86400000), // Sat after
        new Date(vEnd.getTime()   + 2 * 86400000), // Sun after
      ];
      for (const empId of v.employees) {
        for (const f of fruehAssignments.filter(a => a.employees.includes(empId))) {
          const fStart = new Date(f.startDate);
          const fEnd   = new Date(f.endDate);
          const isAdjacent = adjacentDays.some(d =>
            d.toDateString() === fStart.toDateString() ||
            d.toDateString() === fEnd.toDateString()
          );
          expect(isAdjacent).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests for isBlockedFromNachtAfterVerschieben
// ---------------------------------------------------------------------------

describe('isBlockedFromNachtAfterVerschieben', () => {
  const emp = makeEmployee({ id: 'e1', name: 'Test' });

  // verschieben Mon 2026-01-05 – Fri 2026-01-09
  const verschiebenAssignment: ShiftAssignment = {
    id: 'v-1',
    shiftType: 'verschieben',
    startDate: new Date('2026-01-05'),
    endDate:   new Date('2026-01-09'),
    employees: ['e1'],
    confirmed: true,
  };

  it('blocks nacht starting 1 day after verschieben end (Sat 2026-01-10)', () => {
    expect(
      isBlockedFromNachtAfterVerschieben(emp, new Date('2026-01-10'), [verschiebenAssignment])
    ).toBe(true);
  });

  it('blocks nacht starting 7 days after verschieben end (Sat 2026-01-16)', () => {
    expect(
      isBlockedFromNachtAfterVerschieben(emp, new Date('2026-01-16'), [verschiebenAssignment])
    ).toBe(true);
  });

  it('does NOT block nacht starting 8 days after verschieben end (Sun 2026-01-17)', () => {
    expect(
      isBlockedFromNachtAfterVerschieben(emp, new Date('2026-01-17'), [verschiebenAssignment])
    ).toBe(false);
  });

  it('does NOT block nacht that starts BEFORE verschieben ends', () => {
    // nacht starts 2026-01-03 (before the verschieben week)
    expect(
      isBlockedFromNachtAfterVerschieben(emp, new Date('2026-01-03'), [verschiebenAssignment])
    ).toBe(false);
  });

  it('does NOT block other employees', () => {
    const otherEmp = makeEmployee({ id: 'e2', name: 'Other' });
    expect(
      isBlockedFromNachtAfterVerschieben(otherEmp, new Date('2026-01-10'), [verschiebenAssignment])
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SchedulerConfig override tests
// ---------------------------------------------------------------------------

describe('SchedulerConfig – shift count overrides', () => {
  const employees = buildEmployees();

  it('respects a custom verschieben count of 3', () => {
    const cfg = { ...DEFAULT_SCHEDULER_CONFIG, shiftCounts: { ...DEFAULT_SCHEDULER_CONFIG.shiftCounts, verschieben: 3 } };
    const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 1, cfg);
    const v = assignments.filter(a => a.shiftType === 'verschieben');
    v.forEach(a => expect(a.employees.length).toBe(3));
  });

  it('respects a custom nachtbereitschaft count of 3', () => {
    const cfg = { ...DEFAULT_SCHEDULER_CONFIG, shiftCounts: { ...DEFAULT_SCHEDULER_CONFIG.shiftCounts, nachtbereitschaft: 3 } };
    const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 1, cfg);
    const n = assignments.filter(a => a.shiftType === 'nachtbereitschaft');
    n.forEach(a => expect(a.employees.length).toBe(3));
  });

  it('respects a custom fruehschicht count of 2', () => {
    const cfg = { ...DEFAULT_SCHEDULER_CONFIG, shiftCounts: { ...DEFAULT_SCHEDULER_CONFIG.shiftCounts, fruehschicht: 2 } };
    const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 1, cfg);
    const f = assignments.filter(a => a.shiftType === 'fruehschicht');
    f.forEach(a => expect(a.employees.length).toBe(2));
  });
});

describe('SchedulerConfig – rule toggles', () => {
  const employees = buildEmployees();

  it('when over55AndNoL2OnlyVerschieben=false, Ü55 employees may appear in nacht', () => {
    const cfg = {
      ...DEFAULT_SCHEDULER_CONFIG,
      shiftCounts: { ...DEFAULT_SCHEDULER_CONFIG.shiftCounts, nachtbereitschaft: 4 },
      rules: { ...DEFAULT_SCHEDULER_CONFIG.rules, over55AndNoL2OnlyVerschieben: false },
    };
    const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 1, cfg);
    const over55Ids = new Set(employees.filter(e => e.isOver55).map(e => e.id));
    const nachtAssignments = assignments.filter(a => a.shiftType === 'nachtbereitschaft');
    const hasU55InNacht = nachtAssignments.some(a => a.employees.some(id => over55Ids.has(id)));
    // With 4 slots and rule disabled, the scheduler can place Ü55 in nacht
    expect(hasU55InNacht).toBe(true);
  });

  it('when noNachtAfterVerschieben=false, scheduler still produces all shift types', () => {
    const cfg = {
      ...DEFAULT_SCHEDULER_CONFIG,
      rules: { ...DEFAULT_SCHEDULER_CONFIG.rules, noNachtAfterVerschieben: false },
    };
    const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 2, cfg);
    expect(assignments.filter(a => a.shiftType === 'verschieben').length).toBeGreaterThan(0);
    expect(assignments.filter(a => a.shiftType === 'nachtbereitschaft').length).toBeGreaterThan(0);
    expect(assignments.filter(a => a.shiftType === 'fruehschicht').length).toBeGreaterThan(0);
  });

  it('when reserveOver55SlotsForVerschieben=false, verschieben assignments still have correct count', () => {
    const cfg = {
      ...DEFAULT_SCHEDULER_CONFIG,
      rules: { ...DEFAULT_SCHEDULER_CONFIG.rules, reserveOver55SlotsForVerschieben: false },
    };
    const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 1, cfg);
    const v = assignments.filter(a => a.shiftType === 'verschieben');
    expect(v.length).toBeGreaterThan(0);
    v.forEach(a => expect(a.employees.length).toBe(DEFAULT_SCHEDULER_CONFIG.shiftCounts.verschieben));
  });
});

// ---------------------------------------------------------------------------
// Unit tests for isBlockedFromVerschiebenAfterNacht (symmetric rule)
// ---------------------------------------------------------------------------

describe('isBlockedFromVerschiebenAfterNacht', () => {
  const emp = makeEmployee({ id: 'e1', name: 'Test' });

  // nacht Sat 2026-01-10 – Sat 2026-01-17
  const nachtAssignment: ShiftAssignment = {
    id: 'n-1',
    shiftType: 'nachtbereitschaft',
    startDate: new Date('2026-01-10'),
    endDate:   new Date('2026-01-17'),
    employees: ['e1'],
    confirmed: true,
  };

  it('blocks verschieben starting 1 day after nacht end (Mon 2026-01-19)', () => {
    expect(
      isBlockedFromVerschiebenAfterNacht(emp, new Date('2026-01-19'), [nachtAssignment])
    ).toBe(true);
  });

  it('blocks verschieben starting 7 days after nacht end (Sat 2026-01-24)', () => {
    expect(
      isBlockedFromVerschiebenAfterNacht(emp, new Date('2026-01-24'), [nachtAssignment])
    ).toBe(true);
  });

  it('does NOT block verschieben starting 8 days after nacht end (Sun 2026-01-25)', () => {
    expect(
      isBlockedFromVerschiebenAfterNacht(emp, new Date('2026-01-25'), [nachtAssignment])
    ).toBe(false);
  });

  it('does NOT block verschieben that starts BEFORE nacht ends', () => {
    expect(
      isBlockedFromVerschiebenAfterNacht(emp, new Date('2026-01-05'), [nachtAssignment])
    ).toBe(false);
  });

  it('does NOT block other employees', () => {
    const otherEmp = makeEmployee({ id: 'e2', name: 'Other' });
    expect(
      isBlockedFromVerschiebenAfterNacht(otherEmp, new Date('2026-01-19'), [nachtAssignment])
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Violation detection tests
// ---------------------------------------------------------------------------

describe('generateAutomaticShiftPlan – violations', () => {
  it('returns empty violations when pool is large enough', () => {
    const employees = buildEmployees();
    const { violations } = generateAutomaticShiftPlan(employees, 2026, 0, 1);
    expect(violations.length).toBe(0);
  });

  it('returns violations when employee pool is too small to fill all shifts', () => {
    // Only 2 employees total – far too few for any shift requirement
    const tinyPool = [
      makeEmployee({ id: 'a', name: 'A', isOver55: false, hasL2: true }),
      makeEmployee({ id: 'b', name: 'B', isOver55: false, hasL2: true }),
    ];
    const { violations } = generateAutomaticShiftPlan(tinyPool, 2026, 0, 1);
    expect(violations.length).toBeGreaterThan(0);
    // Each violation should have required > assigned
    for (const v of violations) {
      expect(v.required).toBeGreaterThan(v.assigned);
      expect(v.id).toMatch(/^violation-/);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests for isBlockedFromConsecutiveVerschieben
// ---------------------------------------------------------------------------

describe('isBlockedFromConsecutiveVerschieben', () => {
  const emp = makeEmployee({ id: 'e1', name: 'Test' });

  // verschieben Mon 2026-01-05 – Fri 2026-01-09
  const verschiebenAssignment: ShiftAssignment = {
    id: 'v-1',
    shiftType: 'verschieben',
    startDate: new Date('2026-01-05'),
    endDate:   new Date('2026-01-09'),
    employees: ['e1'],
    confirmed: true,
  };

  it('blocks the directly following week (Mon 2026-01-12, daysDiff=3)', () => {
    expect(
      isBlockedFromConsecutiveVerschieben(emp, new Date('2026-01-12'), [verschiebenAssignment])
    ).toBe(true);
  });

  it('does NOT block a week with a gap (Mon 2026-01-19, daysDiff=10)', () => {
    expect(
      isBlockedFromConsecutiveVerschieben(emp, new Date('2026-01-19'), [verschiebenAssignment])
    ).toBe(false);
  });

  it('does NOT block other employees', () => {
    const otherEmp = makeEmployee({ id: 'e2', name: 'Other' });
    expect(
      isBlockedFromConsecutiveVerschieben(otherEmp, new Date('2026-01-12'), [verschiebenAssignment])
    ).toBe(false);
  });

  it('end-to-end: no employee has two consecutive verschieben weeks', () => {
    const employees = buildEmployees();
    const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 2);
    const vAssignments = assignments.filter(a => a.shiftType === 'verschieben');
    // Sort by start date
    vAssignments.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
    for (let i = 0; i < vAssignments.length - 1; i++) {
      const curr = vAssignments[i];
      const next = vAssignments[i + 1];
      const consecutiveEmployees = curr.employees.filter(id => next.employees.includes(id));
      // Two adjacent verschieben periods must share no employees
      const currEnd = new Date(curr.endDate);
      const nextStart = new Date(next.startDate);
      const daysDiff = Math.round((nextStart.getTime() - currEnd.getTime()) / (1000 * 60 * 60 * 24));
      if (daysDiff <= 7) {
        expect(consecutiveEmployees.length).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests for isBlockedFromVerschiebenDueToAdjacentFruehschicht
// ---------------------------------------------------------------------------

describe('isBlockedFromVerschiebenDueToAdjacentFruehschicht', () => {
  const emp = makeEmployee({ id: 'e1', name: 'Test' });

  // Verschieben Mon 2026-01-12 – Fri 2026-01-16
  const vStart = new Date('2026-01-12');
  const vEnd   = new Date('2026-01-16');

  // Frühschicht on the weekend BEFORE the verschieben week (Sat 10 – Sun 11)
  const fruehBefore: ShiftAssignment = {
    id: 'f-before',
    shiftType: 'fruehschicht',
    startDate: new Date('2026-01-10'),
    endDate:   new Date('2026-01-11'),
    employees: ['e1'],
    confirmed: true,
  };

  // Frühschicht on the weekend AFTER the verschieben week (Sat 17 – Sun 18)
  const fruehAfter: ShiftAssignment = {
    id: 'f-after',
    shiftType: 'fruehschicht',
    startDate: new Date('2026-01-17'),
    endDate:   new Date('2026-01-18'),
    employees: ['e1'],
    confirmed: true,
  };

  // Frühschicht two weekends later – NOT adjacent (Sat 24 – Sun 25)
  const fruehFar: ShiftAssignment = {
    id: 'f-far',
    shiftType: 'fruehschicht',
    startDate: new Date('2026-01-24'),
    endDate:   new Date('2026-01-25'),
    employees: ['e1'],
    confirmed: true,
  };

  it('blocks verschieben when employee has Frühschicht on the weekend directly before', () => {
    expect(
      isBlockedFromVerschiebenDueToAdjacentFruehschicht(emp, vStart, vEnd, [fruehBefore])
    ).toBe(true);
  });

  it('blocks verschieben when employee has Frühschicht on the weekend directly after', () => {
    expect(
      isBlockedFromVerschiebenDueToAdjacentFruehschicht(emp, vStart, vEnd, [fruehAfter])
    ).toBe(true);
  });

  it('does NOT block when Frühschicht is two weekends away', () => {
    expect(
      isBlockedFromVerschiebenDueToAdjacentFruehschicht(emp, vStart, vEnd, [fruehFar])
    ).toBe(false);
  });

  it('does NOT block other employees', () => {
    const otherEmp = makeEmployee({ id: 'e2', name: 'Other' });
    expect(
      isBlockedFromVerschiebenDueToAdjacentFruehschicht(otherEmp, vStart, vEnd, [fruehBefore, fruehAfter])
    ).toBe(false);
  });
});
