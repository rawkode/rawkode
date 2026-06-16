export type QueryResultRow = Record<string, string>;

export type QueryBoardGroup = {
  title: string;
  rows: QueryResultRow[];
  column: string | null;
};

export type QueryRefreshListener = (reason: string) => void;

export const queryDocumentIdMetadataKey = '__notes.document_id';

const boardAutoGroupColumns = ['status', 'lane', 'stage', 'state', 'date', 'supertags'];
const queryRefreshListeners = new Set<QueryRefreshListener>();

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

function normalizedCell(value: string | undefined) {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}
