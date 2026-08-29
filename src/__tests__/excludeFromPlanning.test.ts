import { describe, it, expect } from 'vitest';
import { generateAutomaticShiftPlan, DEFAULT_SCHEDULER_CONFIG } from '../utils/scheduler';
import { computeFairnessScores } from '../utils/fairnessImpact';
import { Employee } from '../types';

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

describe('Employee.excludeFromPlanning', () => {
  it('generateAutomaticShiftPlan never assigns an excluded employee to any shift', () => {
    const employees: Employee[] = [
      ...Array.from({ length: 12 }, (_, i) => makeEmployee({ id: `emp-${i}`, name: `Employee ${i}`, department: `Dept ${(i % 3) + 1}` })),
      makeEmployee({ id: 'excluded-1', name: 'Excluded One', excludeFromPlanning: true }),
      makeEmployee({ id: 'excluded-2', name: 'Excluded Two', excludeFromPlanning: true }),
    ];

    const { assignments } = generateAutomaticShiftPlan(employees, 2026, 0, 2, DEFAULT_SCHEDULER_CONFIG);

    for (const a of assignments) {
      expect(a.employees.includes('excluded-1')).toBe(false);
      expect(a.employees.includes('excluded-2')).toBe(false);
    }
    expect(assignments.length).toBeGreaterThan(0);
  });

  it('computeFairnessScores excludes flagged employees from the score pool entirely', () => {
    const employees: Employee[] = [
      makeEmployee({ id: 'a', name: 'A' }),
      makeEmployee({ id: 'b', name: 'B' }),
      makeEmployee({ id: 'excluded', name: 'Excluded', excludeFromPlanning: true }),
    ];
    // Give the excluded employee a huge, wildly unbalanced shift count — if
    // they were still counted, this would tank the fairness score.
    const assignments = [
      { id: 's1', shiftType: 'verschieben' as const, startDate: new Date(2026, 0, 5), endDate: new Date(2026, 0, 9), employees: ['a'], confirmed: true },
      { id: 's2', shiftType: 'verschieben' as const, startDate: new Date(2026, 0, 12), endDate: new Date(2026, 0, 16), employees: ['b'], confirmed: true },
      { id: 's3', shiftType: 'verschieben' as const, startDate: new Date(2026, 0, 19), endDate: new Date(2026, 0, 23), employees: ['excluded'], confirmed: true },
      { id: 's4', shiftType: 'verschieben' as const, startDate: new Date(2026, 0, 26), endDate: new Date(2026, 0, 30), employees: ['excluded'], confirmed: true },
      { id: 's5', shiftType: 'verschieben' as const, startDate: new Date(2026, 1, 2), endDate: new Date(2026, 1, 6), employees: ['excluded'], confirmed: true },
    ];
    const scores = computeFairnessScores(employees, assignments);
    // A and B each have exactly 1 verschieben shift -> perfectly equal among judged employees.
    expect(scores.verschieben).toBe(100);
  });
});
