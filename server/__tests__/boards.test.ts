import { describe, it, expect } from 'vitest';
import { canSeeBoard, boardSharedUserIds } from '../boards';
import type { Board } from '../../src/types';

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: 'board-1',
    organizationId: 'org-1',
    name: 'Test Board',
    type: 'kanban',
    visibility: 'private',
    ownerId: 'owner-1',
    ownerName: 'Owner',
    createdAt: new Date().toISOString(),
    sections: [],
    ...overrides,
  };
}

describe('canSeeBoard', () => {
  it('the owner can always see their own board, regardless of visibility', () => {
    for (const visibility of ['private', 'organization', 'selected'] as const) {
      const board = makeBoard({ visibility, visibleToUserIds: [] });
      expect(canSeeBoard(board, { organizationId: 'org-1', adminUserId: 'owner-1' })).toBe(true);
    }
  });

  it('private boards are invisible to everyone except the owner', () => {
    const board = makeBoard({ visibility: 'private' });
    expect(canSeeBoard(board, { organizationId: 'org-1', adminUserId: 'someone-else' })).toBe(false);
  });

  it('organization-visible boards are visible to any account in the same org', () => {
    const board = makeBoard({ visibility: 'organization' });
    expect(canSeeBoard(board, { organizationId: 'org-1', adminUserId: 'someone-else' })).toBe(true);
  });

  it('selected-visibility boards are only visible to listed users (plus the owner)', () => {
    const board = makeBoard({ visibility: 'selected', visibleToUserIds: ['user-a', 'user-b'] });
    expect(canSeeBoard(board, { organizationId: 'org-1', adminUserId: 'user-a' })).toBe(true);
    expect(canSeeBoard(board, { organizationId: 'org-1', adminUserId: 'user-c' })).toBe(false);
  });

  it('a board is never visible across organizations, regardless of visibility setting', () => {
    const board = makeBoard({ visibility: 'organization', organizationId: 'org-1' });
    expect(canSeeBoard(board, { organizationId: 'org-2', adminUserId: 'anyone' })).toBe(false);
  });
});

describe('boardSharedUserIds', () => {
  it('private boards only share with the owner', () => {
    const board = makeBoard({ visibility: 'private' });
    expect(boardSharedUserIds(board)).toEqual(['owner-1']);
  });

  it('selected-visibility boards share with the listed users plus the owner, deduplicated', () => {
    const board = makeBoard({ visibility: 'selected', visibleToUserIds: ['user-a', 'owner-1', 'user-b'] });
    const shared = boardSharedUserIds(board);
    expect(new Set(shared)).toEqual(new Set(['owner-1', 'user-a', 'user-b']));
    expect(shared.length).toBe(3); // deduplicated, not 4
  });
});
