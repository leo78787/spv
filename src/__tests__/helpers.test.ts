import { describe, it, expect } from 'vitest';
import { parseVacationRanges, parseBoolean, processImportPreview } from '../utils/helpers';

describe('helpers.parseVacationRanges', () => {
  it('parses multiple ranges', () => {
    const input = '2026-02-20:2026-02-24;2026-07-01:2026-07-03';
    const res = parseVacationRanges(input);
    expect(res).toHaveLength(2);
    expect(res[0].startDate.getFullYear()).toBe(2026);
    expect(res[0].endDate.getDate()).toBe(24);
  });

  it('parses single-day range', () => {
    const res = parseVacationRanges('2026-05-10:2026-05-10');
    expect(res).toHaveLength(1);
    expect(res[0].startDate.getDate()).toBe(10);
    expect(res[0].endDate.getDate()).toBe(10);
  });

  it('returns empty array for empty/invalid input', () => {
    expect(parseVacationRanges('')).toHaveLength(0);
    expect(parseVacationRanges(null)).toHaveLength(0);
  });
});

describe('helpers.parseBoolean', () => {
  it('handles truthy values', () => {
    expect(parseBoolean('true')).toBe(true);
    expect(parseBoolean('1')).toBe(true);
    expect(parseBoolean('Yes')).toBe(true);
    expect(parseBoolean(true)).toBe(true);
  });
  it('handles falsy values', () => {
    expect(parseBoolean('false')).toBe(false);
    expect(parseBoolean('0')).toBe(false);
    expect(parseBoolean(undefined)).toBe(false);
    expect(parseBoolean(false)).toBe(false);
  });
});

describe('helpers.processImportPreview', () => {
  it('detects departments to create and appends suffix for duplicate names', () => {
    const existingEmployees = [{ name: 'Max Mustermann' }];
    const existingDepartments = [{ name: 'Abteilung A' }];

    const rows = [
      { name: 'Max Mustermann', departmentName: 'Abteilung A', isOver55: false, hasL2: true, vacationRanges: [], errors: [] },
      { name: 'Max Mustermann', departmentName: 'Neue Abt', isOver55: false, hasL2: false, vacationRanges: [], errors: [] },
      { name: 'Anna', departmentName: 'Neue Abt', isOver55: false, hasL2: false, vacationRanges: [], errors: [] },
      { name: '', departmentName: '', errors: ['Name fehlt'] }
    ];

    const { departmentsToCreate, employeesToAdd } = processImportPreview(rows, existingEmployees as any, existingDepartments as any);
    expect(departmentsToCreate).toContain('Neue Abt');
    expect(employeesToAdd.find(e => e.originalName === 'Max Mustermann')?.name).toBe('Max Mustermann (2)');
    expect(employeesToAdd.find(e => e.originalName === 'Anna')?.name).toBe('Anna');
    expect(employeesToAdd).toHaveLength(3 - 1); // one row had an error
  });
});

