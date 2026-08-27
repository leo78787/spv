import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../store';
import { reviveImportedPlan } from '../utils/helpers';

describe('Planning period algorithm metadata', () => {
  beforeEach(() => {
    useStore.setState({ planningPeriods: [] });
  });

  it('records the algorithm applied to a planning period', () => {
    useStore.setState({
      planningPeriods: [{
        id: 'p1',
        year: 2026,
        startMonth: 0,
        months: 12,
        assignments: [],
        violations: [],
        released: false,
        employeesLocked: false,
        createdAt: new Date().toISOString(),
      }],
    });

    const store = useStore.getState();
    store.applyGeneratedPeriod({
      id: 'p1',
      year: 2026,
      startMonth: 0,
      months: 12,
      assignments: [],
      violations: [],
      algorithm: 'foo-algo',
      released: false,
      employeesLocked: false,
      createdAt: new Date().toISOString(),
    });

    const after = useStore.getState().planningPeriods.find(p => p.id === 'p1');
    expect(after).not.toBeUndefined();
    expect(after?.algorithm).toBe('foo-algo');
  });

  it('revived import preserves algorithm and defaults missing', () => {
    const withAlgo = {
      shiftPlan: { year: 2026, startMonth: 0, months: 12, assignments: [], algorithm: 'bar-algo' },
      employees: [],
      departments: []
    };
    const revived1 = reviveImportedPlan(withAlgo as any);
    expect(revived1?.shiftPlan.algorithm).toBe('bar-algo');

    const withoutAlgo = {
      shiftPlan: { year: 2026, startMonth: 0, months: 12, assignments: [] },
      employees: [],
      departments: []
    };
    const revived2 = reviveImportedPlan(withoutAlgo as any);
    expect(revived2?.shiftPlan.algorithm).toBe('importiert');
  });
});
