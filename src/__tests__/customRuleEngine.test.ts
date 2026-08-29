import { describe, it, expect } from 'vitest';
import { evaluateConditionNode, describeConditionNode, RuleEvalContext } from '../utils/customRuleEngine';
import { ConditionNode, Employee, ShiftAssignment } from '../types';

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

function makeAssignment(overrides: Partial<ShiftAssignment> & { shiftType: ShiftAssignment['shiftType']; startDate: Date; endDate: Date; employees: string[] }): ShiftAssignment {
  return { id: `a-${Math.random()}`, confirmed: true, ...overrides };
}

function baseCtx(overrides: Partial<RuleEvalContext> & { employee: Employee }): RuleEvalContext {
  return {
    startDate: new Date(2026, 5, 1),
    endDate: new Date(2026, 5, 5),
    assignments: [],
    ...overrides,
  };
}

describe('evaluateConditionNode — leaf conditions', () => {
  it('isWeekend: true for Saturday/Sunday, false for weekdays', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A' });
    const node: ConditionNode = { type: 'isWeekend' };
    expect(evaluateConditionNode(node, baseCtx({ employee: emp, startDate: new Date(2026, 5, 6) }))).toBe(true); // Saturday
    expect(evaluateConditionNode(node, baseCtx({ employee: emp, startDate: new Date(2026, 5, 7) }))).toBe(true); // Sunday
    expect(evaluateConditionNode(node, baseCtx({ employee: emp, startDate: new Date(2026, 5, 8) }))).toBe(false); // Monday
  });

  it('employeeAttribute: isOver55 matches boolean equals', () => {
    const senior = makeEmployee({ id: 'e1', name: 'Senior', isOver55: true });
    const junior = makeEmployee({ id: 'e2', name: 'Junior', isOver55: false });
    const node: ConditionNode = { type: 'employeeAttribute', attribute: 'isOver55', equals: true };
    expect(evaluateConditionNode(node, baseCtx({ employee: senior }))).toBe(true);
    expect(evaluateConditionNode(node, baseCtx({ employee: junior }))).toBe(false);
  });

  it('employeeAttribute: department matches string equals', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A', department: 'Dept X' });
    const node: ConditionNode = { type: 'employeeAttribute', attribute: 'department', equals: 'Dept X' };
    expect(evaluateConditionNode(node, baseCtx({ employee: emp }))).toBe(true);
    expect(evaluateConditionNode({ ...node, equals: 'Dept Y' }, baseCtx({ employee: emp }))).toBe(false);
  });

  it('assignmentGap "before": matches when the other assignment ends within the day window before the candidate shift starts', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A' });
    // Other assignment (verschieben) ends 2026-06-03; candidate shift starts 2026-06-08 → gap 5 days
    const assignments = [makeAssignment({
      shiftType: 'verschieben', employees: ['e1'],
      startDate: new Date(2026, 5, 1), endDate: new Date(2026, 5, 3),
    })];
    const node: ConditionNode = { type: 'assignmentGap', shiftType: 'verschieben', direction: 'before', minDays: 1, maxDays: 7 };
    expect(evaluateConditionNode(node, baseCtx({ employee: emp, assignments, startDate: new Date(2026, 5, 8), endDate: new Date(2026, 5, 8) }))).toBe(true);
    // Outside the window (gap = 10)
    expect(evaluateConditionNode(node, baseCtx({ employee: emp, assignments, startDate: new Date(2026, 5, 13), endDate: new Date(2026, 5, 13) }))).toBe(false);
    // Different employee — must not match
    const otherEmpCtx = baseCtx({ employee: makeEmployee({ id: 'e2', name: 'B' }), assignments, startDate: new Date(2026, 5, 8), endDate: new Date(2026, 5, 8) });
    expect(evaluateConditionNode(node, otherEmpCtx)).toBe(false);
  });

  it('assignmentGap "after": matches when the other assignment starts within the day window after the candidate shift ends', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A' });
    const assignments = [makeAssignment({
      shiftType: 'nachtbereitschaft', employees: ['e1'],
      startDate: new Date(2026, 5, 10), endDate: new Date(2026, 5, 16),
    })];
    const node: ConditionNode = { type: 'assignmentGap', shiftType: 'nachtbereitschaft', direction: 'after', minDays: 1, maxDays: 5 };
    // Candidate ends 2026-06-06 → gap to other start (06-10) = 4 days → within window
    expect(evaluateConditionNode(node, baseCtx({ employee: emp, assignments, startDate: new Date(2026, 5, 1), endDate: new Date(2026, 5, 6) }))).toBe(true);
    // Candidate ends 2026-06-01 → gap = 9 days → outside window
    expect(evaluateConditionNode(node, baseCtx({ employee: emp, assignments, startDate: new Date(2026, 4, 28), endDate: new Date(2026, 5, 1) }))).toBe(false);
  });

  it('assignmentGap "either": matches on either side', () => {
    const emp = makeEmployee({ id: 'e1', name: 'A' });
    const assignments = [makeAssignment({
      shiftType: 'fruehschicht', employees: ['e1'],
      startDate: new Date(2026, 5, 1), endDate: new Date(2026, 5, 2),
    })];
    const node: ConditionNode = { type: 'assignmentGap', shiftType: 'fruehschicht', direction: 'either', minDays: 1, maxDays: 3 };
    // Candidate before the other assignment (gap after = other.start - candidate.end)
    expect(evaluateConditionNode(node, baseCtx({ employee: emp, assignments, startDate: new Date(2026, 4, 29), endDate: new Date(2026, 4, 30) }))).toBe(true);
    // Candidate after the other assignment (gap before = candidate.start - other.end)
    expect(evaluateConditionNode(node, baseCtx({ employee: emp, assignments, startDate: new Date(2026, 5, 4), endDate: new Date(2026, 5, 5) }))).toBe(true);
  });

  it('nearVacation: matches single-day and range vacations within the window', () => {
    const emp1 = makeEmployee({ id: 'e1', name: 'A', vacationDays: [new Date(2026, 5, 10)] });
    const emp2 = makeEmployee({ id: 'e2', name: 'B', vacationRanges: [{ startDate: new Date(2026, 5, 10), endDate: new Date(2026, 5, 14) }] });
    const node: ConditionNode = { type: 'nearVacation', direction: 'before', minDays: 1, maxDays: 5 };
    // Candidate shift ends 2026-06-08, vacation starts 06-10 → this is "after" direction (vacation starts after candidate ends), not "before" — should be false for direction 'before'
    expect(evaluateConditionNode(node, baseCtx({ employee: emp1, startDate: new Date(2026, 5, 8), endDate: new Date(2026, 5, 8) }))).toBe(false);
    const afterNode: ConditionNode = { ...node, direction: 'after' };
    expect(evaluateConditionNode(afterNode, baseCtx({ employee: emp1, startDate: new Date(2026, 5, 8), endDate: new Date(2026, 5, 8) }))).toBe(true);
    expect(evaluateConditionNode(afterNode, baseCtx({ employee: emp2, startDate: new Date(2026, 5, 8), endDate: new Date(2026, 5, 8) }))).toBe(true);
  });
});

describe('evaluateConditionNode — combinators', () => {
  const emp = makeEmployee({ id: 'e1', name: 'A', isOver55: true, department: 'Dept X' });
  const trueNode: ConditionNode = { type: 'employeeAttribute', attribute: 'isOver55', equals: true };
  const falseNode: ConditionNode = { type: 'employeeAttribute', attribute: 'isOver55', equals: false };

  it('and: true only if all children true', () => {
    expect(evaluateConditionNode({ type: 'and', children: [trueNode, trueNode] }, baseCtx({ employee: emp }))).toBe(true);
    expect(evaluateConditionNode({ type: 'and', children: [trueNode, falseNode] }, baseCtx({ employee: emp }))).toBe(false);
  });

  it('or: true if any child true', () => {
    expect(evaluateConditionNode({ type: 'or', children: [falseNode, falseNode] }, baseCtx({ employee: emp }))).toBe(false);
    expect(evaluateConditionNode({ type: 'or', children: [falseNode, trueNode] }, baseCtx({ employee: emp }))).toBe(true);
  });

  it('not: negates its child', () => {
    expect(evaluateConditionNode({ type: 'not', child: trueNode }, baseCtx({ employee: emp }))).toBe(false);
    expect(evaluateConditionNode({ type: 'not', child: falseNode }, baseCtx({ employee: emp }))).toBe(true);
  });

  it('nested and/or/not combine correctly', () => {
    // (isOver55 AND department==Dept X) OR NOT(isOver55==false)
    const node: ConditionNode = {
      type: 'or',
      children: [
        { type: 'and', children: [trueNode, { type: 'employeeAttribute', attribute: 'department', equals: 'Dept X' }] },
        { type: 'not', child: falseNode },
      ],
    };
    expect(evaluateConditionNode(node, baseCtx({ employee: emp }))).toBe(true);
  });
});

describe('describeConditionNode', () => {
  it('produces non-empty German descriptions for every node type', () => {
    const nodes: ConditionNode[] = [
      { type: 'isWeekend' },
      { type: 'employeeAttribute', attribute: 'isOver55', equals: true },
      { type: 'employeeAttribute', attribute: 'department', equals: 'Dept X' },
      { type: 'assignmentGap', shiftType: 'verschieben', direction: 'before', minDays: 1, maxDays: 7 },
      { type: 'nearVacation', direction: 'either', minDays: 1, maxDays: 5 },
      { type: 'not', child: { type: 'isWeekend' } },
      { type: 'and', children: [{ type: 'isWeekend' }, { type: 'isWeekend' }] },
      { type: 'or', children: [{ type: 'isWeekend' }, { type: 'isWeekend' }] },
    ];
    for (const n of nodes) {
      expect(describeConditionNode(n).length).toBeGreaterThan(0);
    }
  });
});
