import { describe, it, expect } from 'vitest';
import { runOptimiser } from '../utils/optimizer';
import { computeFairnessScores } from '../utils/fairnessImpact';
import { DEFAULT_SCHEDULER_CONFIG, SchedulerConfig, generateAutomaticShiftPlan, runEqualityOptimiser, runTotalBalanceOptimiser } from '../utils/scheduler';
import { Employee } from '../types';

// ── shared employee pool ────────────────────────────────────────────────────

function makeEmployees(count: number): Employee[] {
  const depts = ['dept-A', 'dept-B', 'dept-C'];
  return Array.from({ length: count }, (_, i) => ({
    id: `emp-${i}`,
    name: `Employee ${i}`,
    department: depts[i % depts.length],
    isOver55: i < 3,
    hasL2: i >= 3,
    vacationDays: [],
    vacationRanges: [],
    preferences: [],
  }));
}

const employees = makeEmployees(16);

// ── tests ───────────────────────────────────────────────────────────────────

describe('Fairness Optimizer', () => {
  it('produces a valid plan with positive fairness scores', () => {
    const result = runOptimiser(
      employees,
      2026,
      0,
      2,
      DEFAULT_SCHEDULER_CONFIG,
      { maxIterations: 200, targets: { overall: true, verschieben: true, nacht: true, frueh: true } }
    );

    expect(result.assignments.length).toBeGreaterThan(0);
    expect(result.scores.overall).toBeGreaterThanOrEqual(0);
    expect(result.scores.verschieben).toBeGreaterThanOrEqual(0);
    expect(result.scores.nacht).toBeGreaterThanOrEqual(0);
    expect(result.scores.frueh).toBeGreaterThanOrEqual(0);
    expect(result.iterations).toBeGreaterThan(0);
  });

  it('respects per-employee allowedShiftTypes', () => {
    // Create employees with restricted shift types
    const restrictedEmployees = employees.map((e, i) =>
      i < 3 ? { ...e, allowedShiftTypes: ['verschieben' as const] } : e
    );
    const config = { ...DEFAULT_SCHEDULER_CONFIG, rules: { ...DEFAULT_SCHEDULER_CONFIG.rules, respectEmployeeShiftTypes: true } };
    const result = runOptimiser(
      restrictedEmployees,
      2026,
      0,
      2,
      config,
      { maxIterations: 20, targets: { overall: true, verschieben: true, nacht: true, frueh: true } }
    );

    const restrictedIds = new Set(restrictedEmployees.filter(e => e.allowedShiftTypes?.length === 1).map(e => e.id));
    for (const a of result.assignments) {
      if (a.shiftType !== 'verschieben') {
        for (const empId of a.employees) {
          expect(restrictedIds.has(empId)).toBe(false);
        }
      }
    }
  });

  it('respects hard rules — no employee has overlapping shifts', () => {
    const result = runOptimiser(
      employees,
      2026,
      0,
      2,
      DEFAULT_SCHEDULER_CONFIG,
      { maxIterations: 300, targets: { overall: true, verschieben: true, nacht: true, frueh: true } }
    );

    // For each employee, collect all assigned day ranges and check no overlap
    const empSlots: Record<string, { start: number; end: number }[]> = {};
    for (const a of result.assignments) {
      const s = new Date(a.startDate).getTime();
      const e = new Date(a.endDate).getTime();
      for (const empId of a.employees) {
        empSlots[empId] = empSlots[empId] || [];
        empSlots[empId].push({ start: s, end: e });
      }
    }
    for (const [_empId, slots] of Object.entries(empSlots)) {
      slots.sort((a, b) => a.start - b.start);
      for (let i = 1; i < slots.length; i++) {
        expect(slots[i].start).toBeGreaterThan(slots[i - 1].end);
      }
    }
  });

  it('always runs all requested iterations', () => {
    const result = runOptimiser(
      employees,
      2026,
      0,
      1,
      DEFAULT_SCHEDULER_CONFIG,
      { maxIterations: 200, targets: { overall: true, verschieben: true, nacht: true, frueh: true } }
    );

    // Must always exhaust exactly the requested iterations
    expect(result.iterations).toBe(200);
    expect(result.assignments.length).toBeGreaterThan(0);
  });

  it('calls the progress callback', () => {
    const progressUpdates: number[] = [];
    runOptimiser(
      employees,
      2026,
      0,
      1,
      DEFAULT_SCHEDULER_CONFIG,
      { maxIterations: 20, targets: { overall: true, verschieben: true, nacht: true, frueh: true } },
      (p) => { progressUpdates.push(p.iteration); }
    );

    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[0]).toBe(0); // first call at iteration 0
  });

  it('works with only a subset of targets enabled', () => {
    const result = runOptimiser(
      employees,
      2026,
      0,
      1,
      DEFAULT_SCHEDULER_CONFIG,
      { maxIterations: 300, targets: { overall: false, verschieben: true, nacht: false, frueh: true } }
    );

    expect(result.assignments.length).toBeGreaterThan(0);
    expect(result.scores.verschieben).toBeGreaterThanOrEqual(0);
    expect(result.scores.frueh).toBeGreaterThanOrEqual(0);
  });

  it('respects vacation — employee on vacation is never assigned to that day', () => {
    const emps = makeEmployees(16);
    // Give emp-5 a vacation range covering the first two weeks of Jan 2026
    emps[5].vacationRanges = [{
      startDate: new Date(2026, 0, 5),
      endDate: new Date(2026, 0, 16),
    }];

    const result = runOptimiser(
      emps,
      2026,
      0,
      1,
      DEFAULT_SCHEDULER_CONFIG,
      { maxIterations: 300, targets: { overall: true, verschieben: true, nacht: true, frueh: true } }
    );

    for (const a of result.assignments) {
      if (!a.employees.includes('emp-5')) continue;
      const aStart = new Date(a.startDate).getTime();
      const aEnd = new Date(a.endDate).getTime();
      const vacStart = new Date(2026, 0, 5).getTime();
      const vacEnd = new Date(2026, 0, 16).getTime();
      // The assignment period should not overlap with the vacation
      const overlaps = aStart <= vacEnd && aEnd >= vacStart;
      expect(overlaps).toBe(false);
    }
  });

  it('no employee appears twice in the same assignment', () => {
    const result = runOptimiser(
      employees,
      2026,
      0,
      3,
      DEFAULT_SCHEDULER_CONFIG,
      { maxIterations: 50, targets: { overall: true, verschieben: true, nacht: true, frueh: true } }
    );

    for (const a of result.assignments) {
      const unique = new Set(a.employees);
      expect(unique.size).toBe(a.employees.length);
    }
  });

  it('respects adjacency rules after optimisation (bidirectional)', () => {
    const cfg: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      rules: {
        ...DEFAULT_SCHEDULER_CONFIG.rules,
        noNachtAfterVerschieben: true,
        noVerschiebenAfterNacht: true,
        noConsecutiveVerschieben: true,
      },
    };

    const result = runOptimiser(
      employees,
      2026,
      0,
      3,
      cfg,
      { maxIterations: 50, targets: { overall: true, verschieben: true, nacht: true, frueh: true } }
    );

    // Build per-employee assignment list
    const empAssignments: Record<string, { start: Date; end: Date; type: string }[]> = {};
    for (const a of result.assignments) {
      for (const empId of a.employees) {
        empAssignments[empId] = empAssignments[empId] || [];
        empAssignments[empId].push({
          start: new Date(a.startDate),
          end: new Date(a.endDate),
          type: a.shiftType,
        });
      }
    }

    for (const [_empId, slots] of Object.entries(empAssignments)) {
      slots.sort((a, b) => a.start.getTime() - b.start.getTime());
      for (let i = 1; i < slots.length; i++) {
        const prev = slots[i - 1];
        const curr = slots[i];
        const gapDays = Math.round(
          (curr.start.getTime() - prev.end.getTime()) / 86_400_000
        );
        if (gapDays < 1 || gapDays > 7) continue; // only check close assignments

        // noNachtAfterVerschieben: verschieben then nacht within 7 days
        if (prev.type === 'verschieben' && curr.type === 'nachtbereitschaft') {
          expect.soft(gapDays).toBeGreaterThan(7);
        }
        // noVerschiebenAfterNacht: nacht then verschieben within 7 days
        if (prev.type === 'nachtbereitschaft' && curr.type === 'verschieben') {
          expect.soft(gapDays).toBeGreaterThan(7);
        }
        // noConsecutiveVerschieben: two verschieben within 7 days
        if (prev.type === 'verschieben' && curr.type === 'verschieben') {
          expect.soft(gapDays).toBeGreaterThan(7);
        }
      }
    }
  });

  it('achieves better or equal fairness than the greedy baseline', () => {
    // Generate greedy baseline
    const { assignments: greedyPlan } = generateAutomaticShiftPlan(
      employees, 2026, 0, 3, DEFAULT_SCHEDULER_CONFIG
    );
    const greedyScores = computeFairnessScores(employees, greedyPlan);
    const greedyComposite = (greedyScores.overall + greedyScores.verschieben + greedyScores.nacht + greedyScores.frueh) / 4;

    // Run optimizer with enough iterations to improve
    const result = runOptimiser(
      employees,
      2026,
      0,
      3,
      DEFAULT_SCHEDULER_CONFIG,
      { maxIterations: 100, targets: { overall: true, verschieben: true, nacht: true, frueh: true } }
    );
    const optComposite = (result.scores.overall + result.scores.verschieben + result.scores.nacht + result.scores.frueh) / 4;

    // The optimizer should achieve at least equal, and typically better scores
    expect(optComposite).toBeGreaterThanOrEqual(greedyComposite - 1); // allow tiny rounding difference
  });
});

// ---------------------------------------------------------------------------
// total-balance optimizer constraints
// ---------------------------------------------------------------------------
describe('Total balance optimizer', () => {
  function groupKey(e: Employee): string {
    const allowed = [...(e.allowedShiftTypes ?? ['fruehschicht','verschieben','nachtbereitschaft'])].sort().join(',');
    return `${allowed}|${e.isOver55 ? '55+' : '<55'}`;
  }

  function perTypeRange(pool: Employee[], assigns: any[]): Record<string, number> {
    const r: Record<string, number> = {};
    const types: Array<'verschieben'|'nachtbereitschaft'|'fruehschicht'> = ['verschieben','nachtbereitschaft','fruehschicht'];
    for (const st of types) {
      if (pool.length === 0) { r[st] = 0; continue; }
      const counts = pool.map(e => assigns.filter(a => a.shiftType === st && a.employees.includes(e.id)).length);
      r[st] = Math.max(...counts) - Math.min(...counts);
    }
    return r;
  }

  function computePoolsRanges(employees: Employee[], assigns: any[]) {
    const poolMap: Record<string, Employee[]> = {};
    for (const e of employees) {
      const key = groupKey(e);
      poolMap[key] = poolMap[key] || [];
      poolMap[key].push(e);
    }
    const out: Record<string, number> = {};
    for (const key of Object.keys(poolMap)) {
      const ranges = perTypeRange(poolMap[key], assigns);
      for (const st of Object.keys(ranges)) {
        out[`${key}:${st}`] = ranges[st as string];
      }
    }
    return out;
  }

  it('does not worsen per-type ranges per employee pool', () => {
    const emps = makeEmployees(20);
    const baseline = generateAutomaticShiftPlan(emps, 2026, 0, 2, DEFAULT_SCHEDULER_CONFIG).assignments;
    const baselineRanges = computePoolsRanges(emps, baseline);

    // feed baseline through equality first to get a realistic starting point
    const equalityResult = runEqualityOptimiser(emps, baseline, DEFAULT_SCHEDULER_CONFIG, 10);

    const totalRes = runTotalBalanceOptimiser(emps, equalityResult.assignments, DEFAULT_SCHEDULER_CONFIG, 20);
    const afterRanges = computePoolsRanges(emps, totalRes.assignments);

    // every pool/type range must be <= baseline
    for (const k of Object.keys(baselineRanges)) {
      expect(afterRanges[k]).toBeLessThanOrEqual(baselineRanges[k]);
    }
  });
});

// ---------------------------------------------------------------------------
// Fairness optimizer — range preservation
// ---------------------------------------------------------------------------
describe('Fairness Optimizer — range preservation', () => {
  function groupKey(e: Employee): string {
    const allowed = [...(e.allowedShiftTypes ?? ['fruehschicht','verschieben','nachtbereitschaft'])].sort().join(',');
    return `${allowed}|${e.isOver55 ? '55+' : '<55'}`;
  }

  function perTypeRange(pool: Employee[], assigns: any[]): Record<string, number> {
    const r: Record<string, number> = {};
    const types: Array<'verschieben'|'nachtbereitschaft'|'fruehschicht'> = ['verschieben','nachtbereitschaft','fruehschicht'];
    for (const st of types) {
      if (pool.length === 0) { r[st] = 0; continue; }
      const counts = pool.map(e => assigns.filter((a: any) => a.shiftType === st && a.employees.includes(e.id)).length);
      r[st] = Math.max(...counts) - Math.min(...counts);
    }
    return r;
  }

  function computePoolsRanges(emps: Employee[], assigns: any[]) {
    const poolMap: Record<string, Employee[]> = {};
    for (const e of emps) {
      const key = groupKey(e);
      poolMap[key] = poolMap[key] || [];
      poolMap[key].push(e);
    }
    const out: Record<string, number> = {};
    for (const key of Object.keys(poolMap)) {
      const ranges = perTypeRange(poolMap[key], assigns);
      for (const st of Object.keys(ranges)) {
        out[`${key}:${st}`] = ranges[st as string];
      }
    }
    return out;
  }

  it('does not worsen per-type ranges per employee-type pool', () => {
    const emps = makeEmployees(16);
    // Generate a greedy baseline to establish starting ranges
    const { assignments: baseline } = generateAutomaticShiftPlan(emps, 2026, 0, 2, DEFAULT_SCHEDULER_CONFIG);
    const baselineRanges = computePoolsRanges(emps, baseline);

    // Run the fairness optimizer
    const result = runOptimiser(
      emps,
      2026,
      0,
      2,
      DEFAULT_SCHEDULER_CONFIG,
      { maxIterations: 100, targets: { overall: true, verschieben: true, nacht: true, frueh: true } }
    );
    const afterRanges = computePoolsRanges(emps, result.assignments);

    // Every pool/type range must be <= baseline (i.e. not worsened)
    for (const k of Object.keys(baselineRanges)) {
      expect(afterRanges[k]).toBeLessThanOrEqual(baselineRanges[k]);
    }
  });

  it('does not worsen ranges with mixed employee types (Ü55 + non-Ü55)', () => {
    // Create employees with different allowed shift types and ages
    const emps: Employee[] = [];
    for (let i = 0; i < 6; i++) {
      emps.push({
        id: `u55-${i}`,
        name: `Ü55 Employee ${i}`,
        department: 'dept-A',
        isOver55: true,
        hasL2: false,
        allowedShiftTypes: ['verschieben'],
        vacationDays: [],
        vacationRanges: [],
        preferences: [],
      });
    }
    for (let i = 0; i < 12; i++) {
      emps.push({
        id: `young-${i}`,
        name: `Young Employee ${i}`,
        department: i < 6 ? 'dept-A' : 'dept-B',
        isOver55: false,
        hasL2: true,
        allowedShiftTypes: ['fruehschicht', 'verschieben', 'nachtbereitschaft'],
        vacationDays: [],
        vacationRanges: [],
        preferences: [],
      });
    }

    const { assignments: baseline } = generateAutomaticShiftPlan(emps, 2026, 0, 2, DEFAULT_SCHEDULER_CONFIG);
    const baselineRanges = computePoolsRanges(emps, baseline);

    const result = runOptimiser(
      emps,
      2026,
      0,
      2,
      DEFAULT_SCHEDULER_CONFIG,
      { maxIterations: 50, targets: { overall: true, verschieben: true, nacht: true, frueh: true } }
    );
    const afterRanges = computePoolsRanges(emps, result.assignments);

    for (const k of Object.keys(baselineRanges)) {
      expect(afterRanges[k]).toBeLessThanOrEqual(baselineRanges[k]);
    }
  });
});
