import { describe, it, expect } from 'vitest';
import { generateAutomaticShiftPlan, DEFAULT_SCHEDULER_CONFIG } from '../utils/scheduler';
import { Employee, CustomRule, SchedulerConfig } from '../types';

/**
 * Proves that a custom rule built through the new engine (not one of the 11
 * hardcoded SchedulerRules) is actually enforced by generateAutomaticShiftPlan
 * — i.e. the algorithm respects newly configured rules, not just the UI.
 */

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

function buildEmployees(): Employee[] {
  const employees: Employee[] = [];
  for (let i = 1; i <= 18; i++) {
    employees.push(makeEmployee({ id: `emp-${i}`, name: `Employee ${i}`, department: `Dept ${(i % 4) + 1}` }));
  }
  return employees;
}

describe('custom rule enforcement in generateAutomaticShiftPlan', () => {
  it('a custom "no verschieben within 10 days of nachtbereitschaft (either direction)" rule holds for every generated assignment, stricter than the built-in 7-day one-directional rules', () => {
    const employees = buildEmployees();

    const customRule: CustomRule = {
      id: 'test-custom-1',
      name: 'Kein Versetzt innerhalb 10 Tagen um Nachtbereitschaft',
      enabled: true,
      targetShiftTypes: ['verschieben'],
      condition: {
        type: 'assignmentGap',
        shiftType: 'nachtbereitschaft',
        direction: 'either',
        minDays: 0,
        maxDays: 10,
      },
    };

    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      customRules: [customRule],
    };

    const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 3, config);
    const verschiebenAssignments = assignments.filter(a => a.shiftType === 'verschieben');
    const nachtAssignments = assignments.filter(a => a.shiftType === 'nachtbereitschaft');

    expect(verschiebenAssignments.length).toBeGreaterThan(0);
    expect(nachtAssignments.length).toBeGreaterThan(0);

    const dayDiff = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));

    for (const v of verschiebenAssignments) {
      const vStart = new Date(v.startDate);
      const vEnd = new Date(v.endDate);
      for (const empId of v.employees) {
        for (const n of nachtAssignments) {
          if (!n.employees.includes(empId)) continue;
          const nStart = new Date(n.startDate);
          const nEnd = new Date(n.endDate);
          const gapBefore = dayDiff(vStart, nEnd);   // nacht ends before verschieben starts
          const gapAfter = dayDiff(nStart, vEnd);    // nacht starts after verschieben ends
          const violatesBefore = gapBefore >= 0 && gapBefore <= 10;
          const violatesAfter = gapAfter >= 0 && gapAfter <= 10;
          expect(violatesBefore || violatesAfter).toBe(false);
        }
      }
    }
  });

  it('disabling the custom rule (enabled: false) stops it from being enforced', () => {
    const employees = buildEmployees();
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      customRules: [{
        id: 'test-custom-2',
        name: 'Immer blockiert',
        enabled: false,
        targetShiftTypes: ['fruehschicht', 'verschieben', 'nachtbereitschaft'],
        // Vacuously true (AND of zero children) — doesn't matter since enabled:false means it's never evaluated anyway.
        condition: { type: 'and', children: [] },
      }],
    };
    // Sanity: generation still produces a normal plan when the custom rule is disabled.
    const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 1, config);
    expect(assignments.length).toBeGreaterThan(0);
  });
});
