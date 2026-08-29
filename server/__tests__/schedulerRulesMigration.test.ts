import { describe, it, expect } from 'vitest';
import { migrateSchedulerRules } from '../db';

/**
 * Verifies the one-time migration from the old flat-boolean SchedulerRules
 * shape to the new block-based BUILTIN_RULES/customRules shape preserves
 * each organization's existing on/off choices — critical since this runs
 * against real, already-generated production planning periods.
 */

function legacyConfig(overrides: Record<string, boolean> = {}) {
  return {
    shiftCounts: { verschieben: 5, nachtbereitschaft: 2, fruehschicht: 3 },
    over55VerschiebenSlots: 2,
    rules: {
      noWeekendAroundVacation: true,
      noFruehschichtAdjacentToVerschieben: true,
      noNachtAfterVerschieben: true,
      noVerschiebenAfterNacht: true,
      noConsecutiveVerschieben: true,
      noConsecutiveNacht: true,
      noConsecutiveFruehschicht: true,
      noNachtBeforeVacation: true,
      respectEmployeeShiftTypes: true,
      respectAvoidancePreferences: true,
      departmentDiversity: true,
      ...overrides,
    },
  };
}

describe('migrateSchedulerRules', () => {
  it('is idempotent — a state without planningPeriods/defaultSchedulerConfig just gets the flag set', () => {
    const { state, migrated } = migrateSchedulerRules({ planningPeriods: [] });
    expect(migrated).toBe(true);
    expect(state.schedulerRulesMigrated).toBe(true);
    const { migrated: migratedAgain } = migrateSchedulerRules(state);
    expect(migratedAgain).toBe(false);
  });

  it('converts a legacy period schedulerConfig into the builtin customRules (9 — noFruehschichtAdjacentToVerschieben splits into 2), all enabled by default', () => {
    const state = { planningPeriods: [{ id: 'p1', schedulerConfig: legacyConfig() }] };
    const { state: migrated } = migrateSchedulerRules(state);
    const cfg = migrated.planningPeriods[0].schedulerConfig;
    expect(cfg.customRules.length).toBe(9);
    expect(cfg.customRules.every((r: any) => r.enabled)).toBe(true);
    // Legacy keys are gone from `rules`, only the 3 behavior flags remain.
    expect(Object.keys(cfg.rules).sort()).toEqual(['departmentDiversity', 'respectAvoidancePreferences', 'respectEmployeeShiftTypes']);
  });

  it('preserves a disabled legacy flag as a disabled builtin rule (not silently re-enabled)', () => {
    const state = {
      planningPeriods: [{ id: 'p1', schedulerConfig: legacyConfig({ noConsecutiveNacht: false, noWeekendAroundVacation: false }) }],
    };
    const { state: migrated } = migrateSchedulerRules(state);
    const cfg = migrated.planningPeriods[0].schedulerConfig;
    const consecNacht = cfg.customRules.find((r: any) => r.builtinKey === 'noConsecutiveNacht');
    const weekendVacation = cfg.customRules.find((r: any) => r.builtinKey === 'noWeekendAroundVacation');
    expect(consecNacht.enabled).toBe(false);
    expect(weekendVacation.enabled).toBe(false);
    // Everything else stays enabled.
    const others = cfg.customRules.filter((r: any) => r.builtinKey !== 'noConsecutiveNacht' && r.builtinKey !== 'noWeekendAroundVacation');
    expect(others.every((r: any) => r.enabled)).toBe(true);
  });

  it('migrates a single legacy boolean into both split rules for noFruehschichtAdjacentToVerschieben', () => {
    const state = { planningPeriods: [{ id: 'p1', schedulerConfig: legacyConfig({ noFruehschichtAdjacentToVerschieben: false }) }] };
    const { state: migrated } = migrateSchedulerRules(state);
    const cfg = migrated.planningPeriods[0].schedulerConfig;
    const split = cfg.customRules.filter((r: any) => r.builtinKey === 'noFruehschichtAdjacentToVerschieben');
    expect(split.length).toBe(2);
    expect(split.every((r: any) => r.enabled === false)).toBe(true);
  });

  it('also migrates state.defaultSchedulerConfig when present', () => {
    const state = { planningPeriods: [], defaultSchedulerConfig: legacyConfig({ noNachtBeforeVacation: false }) };
    const { state: migrated } = migrateSchedulerRules(state);
    const cfg = migrated.defaultSchedulerConfig;
    expect(cfg.customRules.find((r: any) => r.builtinKey === 'noNachtBeforeVacation').enabled).toBe(false);
  });

  it('leaves a period with no schedulerConfig (never generated) untouched', () => {
    const state = { planningPeriods: [{ id: 'p1' }] };
    const { state: migrated } = migrateSchedulerRules(state);
    expect(migrated.planningPeriods[0].schedulerConfig).toBeUndefined();
  });

  it('leaves an already-new-shape config untouched (no legacy keys present)', () => {
    const newShapeConfig = {
      shiftCounts: { verschieben: 5, nachtbereitschaft: 2, fruehschicht: 3 },
      over55VerschiebenSlots: 2,
      rules: { respectEmployeeShiftTypes: true, respectAvoidancePreferences: true, departmentDiversity: true },
      customRules: [{ id: 'custom-1', name: 'Meine Regel', enabled: true, targetShiftTypes: ['verschieben'], condition: { type: 'isWeekend' } }],
    };
    const state = { planningPeriods: [{ id: 'p1', schedulerConfig: newShapeConfig }] };
    const { state: migrated } = migrateSchedulerRules(state);
    expect(migrated.planningPeriods[0].schedulerConfig.customRules).toEqual(newShapeConfig.customRules);
  });
});
