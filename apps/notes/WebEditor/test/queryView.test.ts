import { describe, expect, test } from 'bun:test';
import {
  buildBoardGroups,
  notifyQueryRefresh,
  parseQueryGroupBy,
  queryDocumentIdMetadataKey,
  queryRowDocumentId,
  subscribeQueryRefresh,
} from '../src/queryView';

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

  test('finds trusted document metadata on backlink rows', () => {
    expect(
      queryRowDocumentId(
        {
          entity_id: 'entity-1',
          document_id: 'document-1',
          [queryDocumentIdMetadataKey]: 'document-1',
          document: 'Daily note',
        },
        ['entity_id', 'document_id', 'document']
      )
    ).toBe('document-1');
  });

  test('finds trusted document metadata on document rows', () => {
    expect(
      queryRowDocumentId(
        { id: 'daily-1', date: '2026-06-16', title: 'Today', [queryDocumentIdMetadataKey]: 'daily-1' },
        ['id', 'date', 'title']
      )
    ).toBe('daily-1');
    expect(
      queryRowDocumentId(
        { id: 'note-1', kind: 'note', title: 'Research', [queryDocumentIdMetadataKey]: 'note-1' },
        ['id', 'kind', 'title']
      )
    ).toBe('note-1');
  });

  test('does not treat entity ids as document ids', () => {
    expect(queryRowDocumentId({ id: 'entity-1', name: 'Rawkode Academy', supertags: 'company' }, ['id', 'name', 'supertags'])).toBeNull();
    expect(queryRowDocumentId({ document_id: 'entity-1', title: 'Aliased' }, ['document_id', 'title'])).toBeNull();
    expect(
      queryRowDocumentId(
        { id: 'entity-1', entity_id: 'entity-1', date: '2026-06-16', title: 'Mention' },
        ['id', 'entity_id', 'date', 'title']
      )
    ).toBeNull();
    expect(
      queryRowDocumentId(
        {
          id: 'entity-1',
          name: 'Shipping Plan',
          supertags: 'project',
          date: '2026-06-16',
          title: 'Launch',
        },
        ['id', 'name', 'supertags', 'date', 'title']
      )
    ).toBeNull();
    expect(
      queryRowDocumentId(
        { id: 'entity-1', owner_entity_id: 'entity-2', date: '2026-06-16', title: 'Launch' },
        ['id', 'owner_entity_id', 'date', 'title']
      )
    ).toBeNull();
    expect(
      queryRowDocumentId(
        { id: 'entity-1', title: 'Aliased entity', date: '2026-06-16' },
        ['id', 'title', 'date']
      )
    ).toBeNull();
  });

  test('notifies query refresh subscribers until they unsubscribe', () => {
    const reasons: string[] = [];
    const unsubscribe = subscribeQueryRefresh((reason) => {
      reasons.push(reason);
    });

    notifyQueryRefresh('entityChanged');
    unsubscribe();
    notifyQueryRefresh('documentChanged');

    expect(reasons).toEqual(['entityChanged']);
  });
});
