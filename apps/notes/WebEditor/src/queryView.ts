export type QueryResultRow = Record<string, string>;

export type QueryBoardGroup = {
  title: string;
  rows: QueryResultRow[];
  column: string | null;
};

export type QueryRefreshListener = (reason: string) => void;

export type SavedQueryViewDefinition = {
  id: string;
  name: string;
  query: string;
  view: string;
  groupBy: string | null;
};

export type SavedQueryViewsListener = () => void;

export const queryDocumentIdMetadataKey = '__notes.document_id';
export const queryEntityIdMetadataKey = '__notes.entity_id';

const boardAutoGroupColumns = ['status', 'lane', 'stage', 'state', 'date', 'supertags'];
const queryRefreshListeners = new Set<QueryRefreshListener>();
const savedQueryViewsListeners = new Set<SavedQueryViewsListener>();
let savedQueryViewsSnapshot: SavedQueryViewDefinition[] = [];

export function subscribeQueryRefresh(listener: QueryRefreshListener) {
  queryRefreshListeners.add(listener);
  return () => {
    queryRefreshListeners.delete(listener);
  };
}

export function notifyQueryRefresh(reason = 'dataChanged') {
  for (const listener of Array.from(queryRefreshListeners)) {
    listener(reason);
  }
}

export function subscribeSavedQueryViews(listener: SavedQueryViewsListener) {
  savedQueryViewsListeners.add(listener);
  return () => {
    savedQueryViewsListeners.delete(listener);
  };
}

export function getSavedQueryViews() {
  return savedQueryViewsSnapshot;
}

export function resolveSavedQueryView(savedViewId: unknown) {
  if (typeof savedViewId !== 'string') {
    return null;
  }

  const normalizedId = savedViewId.trim();
  if (!normalizedId) {
    return null;
  }

  return savedQueryViewsSnapshot.find((savedView) => savedView.id === normalizedId) ?? null;
}

export function savedQueryViewSummary(savedView: Pick<SavedQueryViewDefinition, 'view' | 'groupBy'>) {
  const view = normalizedSavedQueryViewMode(savedView.view);
  const groupBy = parseQueryGroupBy(savedView.groupBy);

  if (view === 'board' && groupBy) {
    return `Board by ${groupBy}`;
  }

  return view.charAt(0).toUpperCase() + view.slice(1);
}

export function savedQueryViewOptionLabel(savedView: SavedQueryViewDefinition) {
  return `${savedView.name} · ${savedQueryViewSummary(savedView)}`;
}

export function setSavedQueryViews(savedQueryViews: unknown) {
  savedQueryViewsSnapshot = normalizeSavedQueryViews(savedQueryViews);

  for (const listener of Array.from(savedQueryViewsListeners)) {
    listener();
  }

  notifyQueryRefresh('savedViewsChanged');
}

export function normalizeSavedQueryViews(savedQueryViews: unknown) {
  if (!Array.isArray(savedQueryViews)) {
    return [];
  }

  return savedQueryViews.flatMap((savedQueryView) => {
    const normalized = normalizeSavedQueryView(savedQueryView);
    return normalized ? [normalized] : [];
  });
}

export function parseQueryGroupBy(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

export function buildBoardGroups(
  rows: QueryResultRow[],
  columns: string[],
  requestedGroupBy: string
): QueryBoardGroup[] {
  const groupColumn = resolveBoardGroupColumn(columns, requestedGroupBy);
  if (!groupColumn) {
    return [{ title: 'Items', rows, column: null }];
  }

  const groups = new Map<string, QueryResultRow[]>();
  for (const row of rows) {
    const rawValue = row[groupColumn]?.trim();
    const title = rawValue && rawValue.length > 0 ? rawValue : `No ${groupColumn}`;
    groups.set(title, [...(groups.get(title) ?? []), row]);
  }

  return Array.from(groups, ([title, groupRows]) => ({
    title,
    rows: groupRows,
    column: groupColumn,
  }));
}

function resolveBoardGroupColumn(columns: string[], requestedGroupBy: string) {
  if (requestedGroupBy) {
    return columns.includes(requestedGroupBy) ? requestedGroupBy : null;
  }

  return boardAutoGroupColumns.find((column) => columns.includes(column)) ?? null;
}

export function queryRowDocumentId(row: QueryResultRow, columns: string[]) {
  if (columns.includes(queryDocumentIdMetadataKey)) {
    return null;
  }

  return normalizedCell(row[queryDocumentIdMetadataKey]);
}

export function queryRowEntityId(row: QueryResultRow, columns: string[]) {
  if (columns.includes(queryEntityIdMetadataKey)) {
    return null;
  }

  const metadataEntityId = normalizedCell(row[queryEntityIdMetadataKey]);
  if (metadataEntityId) {
    return metadataEntityId;
  }

  return null;
}

function normalizedCell(value: string | undefined) {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function normalizeSavedQueryView(savedQueryView: unknown): SavedQueryViewDefinition | null {
  if (!savedQueryView || typeof savedQueryView !== 'object') {
    return null;
  }

  const record = savedQueryView as Record<string, unknown>;
  const id = normalizedRequiredString(record.id);
  const name = normalizedRequiredString(record.name);
  const query = normalizedRequiredString(record.query);
  if (!id || !name || !query) {
    return null;
  }

  return {
    id,
    name,
    query,
    view: normalizedRequiredString(record.view) ?? 'table',
    groupBy: normalizedOptionalString(record.groupBy),
  };
}

function normalizedSavedQueryViewMode(value: unknown): 'table' | 'list' | 'board' {
  if (typeof value !== 'string') {
    return 'table';
  }

  switch (value.trim().toLowerCase()) {
    case 'list':
      return 'list';
    case 'board':
      return 'board';
    default:
      return 'table';
  }
}

function normalizedRequiredString(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizedOptionalString(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
