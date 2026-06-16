import { describe, expect, test } from 'bun:test';
import { buildBoardGroups, parseQueryGroupBy } from '../src/queryView';

describe('query board view helpers', () => {
  test('groups board rows by an explicit column', () => {
    const groups = buildBoardGroups(
      [
        { name: 'Alpha', status: 'active' },
        { name: 'Beta', status: 'blocked' },
        { name: 'Gamma', status: 'active' },
      ],
      ['name', 'status'],
      'status'
    );

    expect(groups.map((group) => [group.title, group.rows.map((row) => row.name)])).toEqual([
      ['active', ['Alpha', 'Gamma']],
      ['blocked', ['Beta']],
    ]);
  });

  test('uses common board columns when no explicit group is requested', () => {
    const groups = buildBoardGroups(
      [
        { name: 'Alpha', lane: 'Now' },
        { name: 'Beta', lane: 'Later' },
      ],
      ['name', 'lane'],
      ''
    );

    expect(groups.map((group) => group.title)).toEqual(['Now', 'Later']);
    expect(groups.every((group) => group.column === 'lane')).toBe(true);
  });

  test('keeps ungrouped boards usable', () => {
    expect(buildBoardGroups([{ name: 'Alpha' }], ['name'], '')).toEqual([
      {
        title: 'Items',
        rows: [{ name: 'Alpha' }],
        column: null,
      },
    ]);
  });

  test('falls back when an explicit group column is missing', () => {
    expect(buildBoardGroups([{ name: 'Alpha' }], ['name'], 'status')).toEqual([
      {
        title: 'Items',
        rows: [{ name: 'Alpha' }],
        column: null,
      },
    ]);
  });

  test('labels empty group values', () => {
    expect(buildBoardGroups([{ name: 'Alpha', status: '' }], ['name', 'status'], 'status')).toEqual([
      {
        title: 'No status',
        rows: [{ name: 'Alpha', status: '' }],
        column: 'status',
      },
    ]);
  });

  test('normalizes group field input', () => {
    expect(parseQueryGroupBy(' status ')).toBe('status');
    expect(parseQueryGroupBy(null)).toBe('');
  });
});
