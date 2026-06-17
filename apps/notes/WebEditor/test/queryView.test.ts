import { describe, expect, test } from 'bun:test';
import {
  buildBoardGroups,
  getSavedQueryViews,
  normalizeQueryViewDisplaySettings,
  normalizeSavedQueryViews,
  notifyQueryRefresh,
  parseQueryGroupBy,
  queryDisplayColumns,
  queryDisplayRows,
  queryDocumentIdMetadataKey,
  queryEntityIdMetadataKey,
  queryRowDocumentId,
  queryRowEntityId,
  queryViewDisplayDiagnostics,
  resolveSavedQueryView,
  savedQueryViewOptionLabel,
  savedQueryViewPromotionName,
  savedQueryViewPromotionSignature,
  savedQueryViewSummary,
  setSavedQueryViews,
  subscribeSavedQueryViews,
  subscribeQueryRefresh,
  upsertSavedQueryViewSnapshot,
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

  test('finds entity metadata on entity and backlink rows', () => {
    expect(
      queryRowEntityId(
        { id: 'entity-1', name: 'Rawkode Academy', supertags: 'company', [queryEntityIdMetadataKey]: 'entity-1' },
        ['id', 'name', 'supertags']
      )
    ).toBe('entity-1');
    expect(
      queryRowEntityId(
        {
          entity_id: 'entity-2',
          entity: 'Notes Roadmap',
          document: 'Daily note',
          [queryEntityIdMetadataKey]: 'entity-2',
        },
        ['entity_id', 'entity', 'document']
      )
    ).toBe('entity-2');
    expect(queryRowEntityId({ entity_id: 'entity-3', entity: 'Visible backlink' }, ['entity_id', 'entity'])).toBeNull();
    expect(queryRowEntityId({ id: 'entity-3', name: 'Loose row' }, ['id', 'name'])).toBeNull();
    expect(
      queryRowEntityId(
        { [queryEntityIdMetadataKey]: 'entity-4', name: 'Visible metadata' },
        [queryEntityIdMetadataKey, 'name']
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

  test('normalizes saved query views from bridge payloads', () => {
    expect(
      normalizeSavedQueryViews([
        {
          id: ' saved-view-1 ',
          name: ' Active Projects ',
          query: ' SELECT * FROM projects ',
          view: 'board',
          groupBy: ' status ',
          visibleColumns: [' name ', 'status', 'name'],
          sortColumn: ' updated_at ',
          sortDescending: true,
          rowLimit: 20,
        },
        { id: 'missing-query', name: 'Broken', view: 'table' },
      ])
    ).toEqual([
      {
        id: 'saved-view-1',
        name: 'Active Projects',
        query: 'SELECT * FROM projects',
        view: 'board',
        groupBy: 'status',
        visibleColumns: ['name', 'status'],
        sortColumn: 'updated_at',
        sortDescending: true,
        rowLimit: 20,
      },
    ]);
  });

  test('applies query display settings without mutating result rows', () => {
    const rows = [
      { name: 'Alpha', priority: '2', status: 'active', [queryEntityIdMetadataKey]: 'entity-1' },
      { name: 'Beta', priority: '10', status: 'blocked', [queryEntityIdMetadataKey]: 'entity-2' },
      { name: 'Gamma', priority: '1', status: 'active', [queryEntityIdMetadataKey]: 'entity-3' },
    ];
    const columns = ['name', 'priority', 'status'];
    const settings = normalizeQueryViewDisplaySettings({
      visibleColumns: 'status, name, missing',
      sortColumn: 'priority',
      sortDirection: 'desc',
      rowLimit: '2',
    });

    expect(queryDisplayColumns(columns, settings)).toEqual(['status', 'name']);
    expect(queryDisplayRows(rows, columns, settings).map((row) => row.name)).toEqual(['Beta', 'Alpha']);
    expect(queryRowEntityId(queryDisplayRows(rows, columns, settings)[0], ['status', 'name'])).toBe('entity-2');
  });

  test('reports missing query display fields', () => {
    const diagnostics = queryViewDisplayDiagnostics(
      ['name', 'status'],
      'board',
      'lane',
      normalizeQueryViewDisplaySettings({
        visibleColumns: ['name', 'owner'],
        sortColumn: 'updated_at',
      })
    );

    expect(diagnostics).toEqual([
      {
        severity: 'error',
        message: "Board group field 'lane' is not returned by the query.",
      },
      {
        severity: 'error',
        message: "Visible column 'owner' is not returned by the query.",
      },
      {
        severity: 'error',
        message: "Sort field 'updated_at' is not returned by the query.",
      },
    ]);
  });

  test('warns when a board has no grouping field', () => {
    expect(
      queryViewDisplayDiagnostics(
        ['name'],
        'board',
        '',
        normalizeQueryViewDisplaySettings({})
      )
    ).toEqual([
      {
        severity: 'warning',
        message: 'Board view will use a single Items column because no groupable field is returned.',
      },
    ]);
  });

  test('summarizes saved query views for insertion controls', () => {
    expect(
      savedQueryViewSummary({
        view: 'board',
        groupBy: 'status',
      })
    ).toBe('Board by status');
    expect(
      savedQueryViewSummary({
        view: 'list',
        groupBy: null,
      })
    ).toBe('List');
    expect(
      savedQueryViewOptionLabel({
        id: 'saved-view-1',
        name: 'Active Projects',
        query: 'SELECT * FROM projects',
        view: 'board',
        groupBy: 'status',
        visibleColumns: ['name', 'owner'],
        sortColumn: 'owner',
        sortDescending: false,
        rowLimit: 25,
      })
    ).toBe('Active Projects · Board by status · 2 columns · sort owner asc · limit 25');
  });

  test('builds promotion names from query block metadata', () => {
    expect(savedQueryViewPromotionName(' Active Projects ', 'SELECT * FROM projects')).toBe('Active Projects');
    expect(savedQueryViewPromotionName('', 'SELECT date, title FROM daily_notes')).toBe('Daily Notes');
    expect(savedQueryViewPromotionName(null, 'SELECT 1')).toBe('Query View');
  });

  test('detects query block state changes during promotion', () => {
    const submitted = savedQueryViewPromotionSignature({
      savedViewId: '',
      title: ' Active Projects ',
      query: 'SELECT * FROM projects',
      view: 'board',
      groupBy: ' status ',
      visibleColumns: ['name'],
      sortColumn: 'name',
      sortDescending: false,
      rowLimit: 10,
    });

    expect(
      savedQueryViewPromotionSignature({
        savedViewId: '',
        title: 'Active Projects',
        query: 'SELECT * FROM projects',
        view: 'board',
        groupBy: 'status',
        visibleColumns: ['name'],
        sortColumn: 'name',
        sortDescending: false,
        rowLimit: 10,
      })
    ).toBe(submitted);
    expect(
      savedQueryViewPromotionSignature({
        savedViewId: '',
        title: 'Active Projects',
        query: 'SELECT * FROM projects WHERE status = "active"',
        view: 'board',
        groupBy: 'status',
        visibleColumns: ['name'],
        sortColumn: 'name',
        sortDescending: false,
        rowLimit: 10,
      })
    ).not.toBe(submitted);
    expect(
      savedQueryViewPromotionSignature({
        savedViewId: 'saved-view-1',
        title: 'Active Projects',
        query: 'SELECT * FROM projects',
        view: 'board',
        groupBy: 'status',
        visibleColumns: ['name'],
        sortColumn: 'name',
        sortDescending: true,
        rowLimit: 10,
      })
    ).not.toBe(submitted);
  });

  test('stores saved query views and refreshes subscribers', () => {
    const savedViewUpdates: number[] = [];
    const refreshReasons: string[] = [];
    const unsubscribeSavedViews = subscribeSavedQueryViews(() => {
      savedViewUpdates.push(getSavedQueryViews().length);
    });
    const unsubscribeRefresh = subscribeQueryRefresh((reason) => {
      refreshReasons.push(reason);
    });

    setSavedQueryViews([
      {
        id: 'saved-view-1',
        name: 'Active Projects',
        query: 'SELECT * FROM projects',
        view: 'table',
        groupBy: null,
        visibleColumns: ['name'],
        sortColumn: 'name',
        sortDescending: false,
        rowLimit: 5,
      },
    ]);

    expect(resolveSavedQueryView(' saved-view-1 ')?.name).toBe('Active Projects');
    expect(savedViewUpdates).toEqual([1]);
    expect(refreshReasons).toEqual(['savedViewsChanged']);

    expect(
      upsertSavedQueryViewSnapshot({
        id: 'saved-view-2',
        name: 'Daily Notes',
        query: 'SELECT date, title FROM daily_notes',
        view: 'board',
        groupBy: 'date',
        visibleColumns: ['date', 'title'],
        sortColumn: 'date',
        sortDescending: true,
        rowLimit: 7,
      })?.name
    ).toBe('Daily Notes');
    expect(resolveSavedQueryView('saved-view-2')?.groupBy).toBe('date');
    expect(resolveSavedQueryView('saved-view-2')?.visibleColumns).toEqual(['date', 'title']);
    expect(savedViewUpdates).toEqual([1, 2]);
    expect(refreshReasons).toEqual(['savedViewsChanged', 'savedViewsChanged']);

    unsubscribeSavedViews();
    unsubscribeRefresh();
    setSavedQueryViews([]);
  });
});
