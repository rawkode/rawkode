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
  visibleColumns: string[];
  sortColumn: string | null;
  sortDescending: boolean;
  rowLimit: number | null;
};

export type QueryViewDisplaySettings = {
  visibleColumns: string[];
  sortColumn: string | null;
  sortDescending: boolean;
  rowLimit: number | null;
};

export type QueryValidationDiagnostic = {
  severity: 'error' | 'warning';
  message: string;
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

export function savedQueryViewSummary(
  savedView: Pick<SavedQueryViewDefinition, 'view' | 'groupBy'> & Partial<QueryViewDisplaySettings>
) {
  const view = normalizedSavedQueryViewMode(savedView.view);
  const groupBy = parseQueryGroupBy(savedView.groupBy);
  const displaySettings = normalizeQueryViewDisplaySettings(savedView);
  const details: string[] = [];

  if (view === 'board' && groupBy) {
    details.push(`Board by ${groupBy}`);
  } else {
    details.push(view.charAt(0).toUpperCase() + view.slice(1));
  }

  if (displaySettings.visibleColumns.length > 0) {
    details.push(`${displaySettings.visibleColumns.length} columns`);
  }

  if (displaySettings.sortColumn) {
    details.push(`sort ${displaySettings.sortColumn} ${displaySettings.sortDescending ? 'desc' : 'asc'}`);
  }

  if (displaySettings.rowLimit) {
    details.push(`limit ${displaySettings.rowLimit}`);
  }

  return details.join(' · ');
}

export function savedQueryViewOptionLabel(savedView: SavedQueryViewDefinition) {
  return `${savedView.name} · ${savedQueryViewSummary(savedView)}`;
}

export function savedQueryViewPromotionName(title: unknown, query: unknown) {
  const normalizedTitle = normalizedOptionalString(title);
  if (normalizedTitle) {
    return normalizedTitle;
  }

  if (typeof query !== 'string') {
    return 'Query View';
  }

  const sourceMatch = query.match(/\bfrom\s+([a-z_][a-z0-9_]*)/i);
  if (!sourceMatch) {
    return 'Query View';
  }

  return sourceMatch[1]
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function savedQueryViewPromotionSignature(input: {
  savedViewId: unknown;
  title: unknown;
  query: unknown;
  view: unknown;
  groupBy: unknown;
  visibleColumns?: unknown;
  sortColumn?: unknown;
  sortDescending?: unknown;
  rowLimit?: unknown;
}) {
  const savedViewId = normalizedOptionalString(input.savedViewId) ?? '';
  const title = normalizedOptionalString(input.title) ?? '';
  const query = typeof input.query === 'string' ? input.query : '';
  const view = normalizedOptionalString(input.view) ?? 'table';
  const groupBy = normalizedOptionalString(input.groupBy) ?? '';
  const displaySettings = normalizeQueryViewDisplaySettings(input);

  return [
    savedViewId,
    title,
    query,
    view,
    groupBy,
    displaySettings.visibleColumns.join(','),
    displaySettings.sortColumn ?? '',
    displaySettings.sortDescending ? 'desc' : 'asc',
    displaySettings.rowLimit?.toString() ?? '',
  ].join('\u0000');
}

export function upsertSavedQueryViewSnapshot(savedQueryView: unknown) {
  const normalized = normalizeSavedQueryView(savedQueryView);
  if (!normalized) {
    return null;
  }

  const existingIndex = savedQueryViewsSnapshot.findIndex((candidate) => candidate.id === normalized.id);
  if (existingIndex >= 0) {
    savedQueryViewsSnapshot = savedQueryViewsSnapshot.map((candidate, index) =>
      index === existingIndex ? normalized : candidate
    );
  } else {
    savedQueryViewsSnapshot = [...savedQueryViewsSnapshot, normalized];
  }

  for (const listener of Array.from(savedQueryViewsListeners)) {
    listener();
  }

  notifyQueryRefresh('savedViewsChanged');
  return normalized;
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

export function normalizeQueryViewDisplaySettings(input: unknown): QueryViewDisplaySettings {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    visibleColumns: normalizeVisibleColumns(record.visibleColumns),
    sortColumn: parseQuerySortColumn(record.sortColumn),
    sortDescending: parseQuerySortDescending(record.sortDescending ?? record.sortDirection),
    rowLimit: parseQueryRowLimit(record.rowLimit),
  };
}

export function normalizeVisibleColumns(value: unknown) {
  const rawColumns = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const seen = new Set<string>();
  const columns: string[] = [];

  for (const rawColumn of rawColumns) {
    if (typeof rawColumn !== 'string') {
      continue;
    }

    const column = rawColumn.trim();
    if (!column || seen.has(column)) {
      continue;
    }

    seen.add(column);
    columns.push(column);
  }

  return columns;
}

export function parseQuerySortColumn(value: unknown) {
  return normalizedOptionalString(value);
}

export function parseQuerySortDescending(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return false;
  }

  return value.trim().toLowerCase() === 'desc' || value.trim().toLowerCase() === 'descending';
}

export function parseQueryRowLimit(value: unknown) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
}

export function queryDisplayColumns(columns: string[], settings: QueryViewDisplaySettings) {
  const visibleColumns = normalizeVisibleColumns(settings.visibleColumns);
  const requestedColumns = visibleColumns.filter((column) => columns.includes(column));
  return requestedColumns.length > 0 ? requestedColumns : columns;
}

export function queryDisplayRows(
  rows: QueryResultRow[],
  columns: string[],
  settings: QueryViewDisplaySettings
) {
  let displayRows = [...rows];
  const sortColumn = parseQuerySortColumn(settings.sortColumn);

  if (sortColumn && columns.includes(sortColumn)) {
    displayRows.sort((left, right) => {
      const comparison = compareQueryValues(left[sortColumn] ?? '', right[sortColumn] ?? '');
      return settings.sortDescending ? -comparison : comparison;
    });
  }

  const rowLimit = parseQueryRowLimit(settings.rowLimit);
  if (rowLimit && displayRows.length > rowLimit) {
    displayRows = displayRows.slice(0, rowLimit);
  }

  return displayRows;
}

export function queryViewDisplayDiagnostics(
  columns: string[],
  view: string,
  requestedGroupBy: string,
  settings: QueryViewDisplaySettings
): QueryValidationDiagnostic[] {
  const diagnostics: QueryValidationDiagnostic[] = [];
  const columnSet = new Set(columns);
  const viewMode = normalizedSavedQueryViewMode(view);
  const groupBy = parseQueryGroupBy(requestedGroupBy);

  if (viewMode === 'board') {
    if (groupBy && !columnSet.has(groupBy)) {
      diagnostics.push({
        severity: 'error',
        message: `Board group field '${groupBy}' is not returned by the query.`,
      });
    } else if (!groupBy && !resolveBoardGroupColumn(columns, '')) {
      diagnostics.push({
        severity: 'warning',
        message: 'Board view will use a single Items column because no groupable field is returned.',
      });
    }
  }

  for (const column of normalizeVisibleColumns(settings.visibleColumns)) {
    if (!columnSet.has(column)) {
      diagnostics.push({
        severity: 'error',
        message: `Visible column '${column}' is not returned by the query.`,
      });
    }
  }

  const sortColumn = parseQuerySortColumn(settings.sortColumn);
  if (sortColumn && !columnSet.has(sortColumn)) {
    diagnostics.push({
      severity: 'error',
      message: `Sort field '${sortColumn}' is not returned by the query.`,
    });
  }

  return diagnostics;
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
    visibleColumns: normalizeVisibleColumns(record.visibleColumns),
    sortColumn: parseQuerySortColumn(record.sortColumn),
    sortDescending: parseQuerySortDescending(record.sortDescending ?? record.sortDirection),
    rowLimit: parseQueryRowLimit(record.rowLimit),
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

function compareQueryValues(left: string, right: string) {
  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  const leftNumber = Number(leftTrimmed);
  const rightNumber = Number(rightTrimmed);

  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return leftTrimmed.localeCompare(rightTrimmed, undefined, { numeric: true, sensitivity: 'base' });
}
