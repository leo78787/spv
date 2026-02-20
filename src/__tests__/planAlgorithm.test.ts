import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../store';
import { reviveImportedPlan } from '../utils/helpers';

describe('Shift plan algorithm metadata', () => {
  beforeEach(() => {
    // only clear the existing plan; other state isn't needed for these tests
    useStore.setState({ shiftPlan: null });
  });

  it('records the algorithm passed to createShiftPlan', () => {
    const store = useStore.getState();
    store.createShiftPlan(2026, 0, 12, undefined, [], 'foo-algo');
    const after = useStore.getState();
    expect(after.shiftPlan).not.toBeNull();
    expect(after.shiftPlan?.algorithm).toBe('foo-algo');
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