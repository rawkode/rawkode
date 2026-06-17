import React from 'react';
import ReactDOM from 'react-dom/client';
import { EditorContent, NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import { Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Excalidraw } from '@excalidraw/excalidraw';
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import {
  findParagraphQueryFenceReplacement,
  parseQueryCodeBlock,
  parseQueryViewMode,
  queryFenceReplacementToNodeAttributes,
  type QueryFenceReplacement,
  type QueryFenceTextBlock,
  type QueryViewMode,
} from './queryFence';
import {
  buildBoardGroups,
  getSavedQueryViews,
  notifyQueryRefresh,
  parseQueryGroupBy,
  queryRowDocumentId,
  queryRowEntityId,
  resolveSavedQueryView,
  savedQueryViewOptionLabel,
  savedQueryViewPromotionName,
  savedQueryViewPromotionSignature,
  savedQueryViewSummary,
  setSavedQueryViews as setSavedQueryViewsSnapshot,
  subscribeQueryRefresh,
  subscribeSavedQueryViews,
  type SavedQueryViewDefinition,
  upsertSavedQueryViewSnapshot,
} from './queryView';
import './styles.css';

type EditorBridgePayload = {
  documentId: string;
  title: string;
  contentJSON: string;
};

type EntityReferencePayload = {
  entityId: string;
  label: string;
  tags: string[];
  properties?: Record<string, string>;
};

type EntityBridgeResponse = {
  requestId: string;
  entityId?: string | null;
  label?: string | null;
  tags?: string[];
  properties?: Record<string, string>;
  error?: string | null;
};

type QueryResultPayload = {
  columns: string[];
  rows: Record<string, string>[];
};

type QueryBridgeResponse = QueryResultPayload & {
  requestId: string;
  error?: string | null;
};

type QueryRefreshPayload = {
  reason?: string;
};

type SavedQueryViewBridgeResponse = Partial<SavedQueryViewDefinition> & {
  requestId: string;
  error?: string | null;
};

type ActiveDocumentSnapshot = {
  documentId: string;
  loadGeneration: number;
};

type PendingEntityRequest = {
  documentId: string;
  loadGeneration: number;
  resolve(entity: EntityReferencePayload): void;
  reject(error: Error): void;
};

type PendingQueryRequest = {
  documentId: string;
  loadGeneration: number;
  resolve(result: QueryResultPayload): void;
  reject(error: Error): void;
};

type PendingSavedQueryViewRequest = {
  documentId: string;
  loadGeneration: number;
  resolve(savedView: SavedQueryViewDefinition): void;
  reject(error: Error): void;
};

type NativeBridgeMessage =
  | { type: 'ready' }
  | { type: 'loaded'; documentId: string }
  | {
      type: 'upsertEntity';
      requestId: string;
      name: string;
      supertags: string[];
      properties?: Record<string, string>;
    }
  | {
      type: 'runQuery';
      requestId: string;
      query: string;
    }
  | {
      type: 'saveQueryView';
      requestId: string;
      name: string;
      query: string;
      view: QueryViewMode;
      groupBy?: string | null;
    }
  | {
      type: 'openDocument';
      documentId: string;
    }
  | {
      type: 'openEntity';
      entityId: string;
    }
  | {
      type: 'change';
      documentId: string;
      title: string;
      contentJSON: string;
      plainText: string;
    };

declare global {
  interface Window {
    NotesEditor?: {
      loadDocument(payload: EditorBridgePayload): boolean;
      completeEntityRequest(response: EntityBridgeResponse): void;
      completeQueryRequest(response: QueryBridgeResponse): void;
      completeSavedQueryViewRequest(response: SavedQueryViewBridgeResponse): void;
      refreshQueryViews(payload?: QueryRefreshPayload): void;
      setSavedQueryViews(savedQueryViews: unknown): void;
    };
    webkit?: {
      messageHandlers?: {
        notesBridge?: {
          postMessage(message: NativeBridgeMessage): void;
        };
      };
    };
  }
}

const emptyDocument = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

const emptyScene: ExcalidrawInitialDataState = {
  elements: [],
  appState: {},
  files: {},
};

const pendingEntityRequests = new Map<string, PendingEntityRequest>();
const pendingQueryRequests = new Map<string, PendingQueryRequest>();
const pendingSavedQueryViewRequests = new Map<string, PendingSavedQueryViewRequest>();
let activeDocumentSnapshot: ActiveDocumentSnapshot = { documentId: '', loadGeneration: 0 };

const EntityReferenceNode = Node.create({
  name: 'entityReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      entityId: { default: null },
      label: { default: 'Untitled entity' },
      tags: { default: [] },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-entity-reference]' }];
  },

  renderHTML({ node }) {
    return [
      'span',
      mergeAttributes({
        'data-entity-reference': 'true',
        'data-entity-id': node.attrs.entityId,
        'data-label': node.attrs.label,
        class: 'entity-reference',
      }),
      node.attrs.label,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(EntityReferenceView);
  },
});

const QueryViewNode = Node.create({
  name: 'queryView',
  group: 'block',
  atom: true,
  selectable: true,
  isolating: true,

  addAttributes() {
    return {
      query: { default: 'SELECT * FROM entities' },
      view: { default: 'table' },
      groupBy: { default: null },
      title: { default: null },
      savedViewId: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'section[data-query-view]' }];
  },

  renderHTML({ node }) {
    return [
      'section',
      mergeAttributes({
        'data-query-view': 'true',
        'data-view': node.attrs.view,
        'data-group-by': node.attrs.groupBy,
        'data-title': node.attrs.title,
        'data-saved-view-id': node.attrs.savedViewId,
        class: 'query-view-node',
      }),
      node.attrs.query,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(QueryViewNodeView);
  },
});

const ExcalidrawNode = Node.create({
  name: 'excalidraw',
  group: 'block',
  atom: true,
  selectable: true,
  isolating: true,

  addAttributes() {
    return {
      drawingId: { default: null },
      title: { default: 'Sketch' },
      scene: { default: emptyScene },
    };
  },

  parseHTML() {
    return [{ tag: 'section[data-excalidraw]' }];
  },

  renderHTML({ node }) {
    return [
      'section',
      mergeAttributes({
        'data-excalidraw': 'true',
        'data-drawing-id': node.attrs.drawingId,
        class: 'excalidraw-node',
      }),
      node.attrs.title,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ExcalidrawNodeView);
  },
});

function EntityReferenceView({ node }: NodeViewProps) {
  const tags = Array.isArray(node.attrs.tags) ? node.attrs.tags : [];

  return (
    <NodeViewWrapper as="span" className="entity-chip" data-entity-id={node.attrs.entityId}>
      <span className="entity-chip__label">{node.attrs.label || 'Untitled entity'}</span>
      {tags.length > 0 ? <span className="entity-chip__tag">{tags[0]}</span> : null}
    </NodeViewWrapper>
  );
}

function QueryViewNodeView({ node, updateAttributes, selected }: NodeViewProps) {
  const savedQueryViews = React.useSyncExternalStore(
    subscribeSavedQueryViews,
    getSavedQueryViews,
    getSavedQueryViews
  );
  const savedViewId = typeof node.attrs.savedViewId === 'string' ? node.attrs.savedViewId.trim() : '';
  const savedView = savedViewId ? (savedQueryViews.find((candidate) => candidate.id === savedViewId) ?? null) : null;
  const query = typeof node.attrs.query === 'string' ? node.attrs.query : '';
  const effectiveQuery = savedView?.query ?? query;
  const view = savedView ? parseQueryViewMode(savedView.view) : parseQueryViewMode(node.attrs.view);
  const groupBy = savedView ? parseQueryGroupBy(savedView.groupBy) : parseQueryGroupBy(node.attrs.groupBy);
  const title = typeof node.attrs.title === 'string' ? node.attrs.title : '';
  const displayTitle = (savedView?.name ?? title).trim();
  const isSavedViewBacked = Boolean(savedView);
  const isMissingSavedView = Boolean(savedViewId && !savedView);
  const querySignature = `${savedViewId}\u0000${effectiveQuery}\u0000${view}\u0000${groupBy}`;
  const promotionBlockSignature = savedQueryViewPromotionSignature({
    savedViewId,
    title: displayTitle,
    query: effectiveQuery,
    view,
    groupBy,
  });
  const [result, setResult] = React.useState<QueryResultPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isRunning, setIsRunning] = React.useState(false);
  const [isPromoting, setIsPromoting] = React.useState(false);
  const [promotionName, setPromotionName] = React.useState('');
  const [promotionError, setPromotionError] = React.useState<string | null>(null);
  const [isSavingPromotion, setIsSavingPromotion] = React.useState(false);
  const didAutoRunRef = React.useRef(false);
  const isMountedRef = React.useRef(true);
  const queryGenerationRef = React.useRef(0);
  const activeRunRef = React.useRef(0);
  const previousQuerySignatureRef = React.useRef(querySignature);
  const promotionBlockSignatureRef = React.useRef(promotionBlockSignature);
  const trimmedPromotionName = promotionName.trim();
  const defaultPromotionName = savedQueryViewPromotionName(displayTitle, effectiveQuery);

  React.useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    promotionBlockSignatureRef.current = promotionBlockSignature;
  }, [promotionBlockSignature]);

  const run = React.useCallback(async () => {
    const trimmedQuery = effectiveQuery.trim();
    if (!trimmedQuery) {
      setError('Query cannot be empty.');
      setResult(null);
      return;
    }

    const snapshot = getCurrentDocumentSnapshot();
    if (!snapshot.documentId) {
      setError('No active note is loaded.');
      setResult(null);
      return;
    }

    const queryGeneration = queryGenerationRef.current;
    const runId = activeRunRef.current + 1;
    activeRunRef.current = runId;
    setIsRunning(true);
    setError(null);

    try {
      const nextResult = await requestQuery(trimmedQuery, snapshot);
      if (
        !isMountedRef.current ||
        queryGenerationRef.current !== queryGeneration ||
        activeRunRef.current !== runId
      ) {
        return;
      }

      setResult(nextResult);
    } catch (requestError) {
      if (
        !isMountedRef.current ||
        queryGenerationRef.current !== queryGeneration ||
        activeRunRef.current !== runId
      ) {
        return;
      }

      setResult(null);
      setError(requestError instanceof Error ? requestError.message : 'Query failed.');
    } finally {
      if (isMountedRef.current && activeRunRef.current === runId) {
        setIsRunning(false);
      }
    }
  }, [effectiveQuery]);

  function updateQuery(nextQuery: string) {
    queryGenerationRef.current += 1;
    activeRunRef.current += 1;
    setResult(null);
    setError(null);
    setIsRunning(false);
    updateAttributes({ query: nextQuery, savedViewId: null });
  }

  function updateGroupBy(nextGroupBy: string) {
    updateAttributes({ groupBy: parseQueryGroupBy(nextGroupBy) || null, savedViewId: null });
  }

  function updateTitle(nextTitle: string) {
    updateAttributes({ title: nextTitle.trim().length > 0 ? nextTitle : null, savedViewId: null });
  }

  function updateView(nextView: string) {
    updateAttributes({ view: parseQueryViewMode(nextView), savedViewId: null });
  }

  function detachSavedView() {
    updateAttributes({
      query: effectiveQuery,
      view,
      groupBy: groupBy || null,
      title: displayTitle || null,
      savedViewId: null,
    });
  }

  function beginPromoting() {
    setPromotionName(defaultPromotionName);
    setPromotionError(null);
    setIsPromoting(true);
  }

  async function promoteQueryView(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuery = effectiveQuery.trim();
    if (!trimmedPromotionName || !trimmedQuery || isSavingPromotion) {
      return;
    }

    const snapshot = getCurrentDocumentSnapshot();
    if (!snapshot.documentId) {
      setPromotionError('No active note is loaded.');
      return;
    }

    setIsSavingPromotion(true);
    setPromotionError(null);
    const submittedPromotionSignature = promotionBlockSignature;

    try {
      const savedView = await requestSavedQueryView(
        {
          name: trimmedPromotionName,
          query: trimmedQuery,
          view,
          groupBy: groupBy || null,
        },
        snapshot
      );

      if (!isMountedRef.current) {
        return;
      }

      if (promotionBlockSignatureRef.current !== submittedPromotionSignature) {
        setPromotionError('Query block changed before the saved view was applied. Review the block and save it again.');
        return;
      }

      updateAttributes({
        query: savedView.query,
        view: parseQueryViewMode(savedView.view),
        groupBy: parseQueryGroupBy(savedView.groupBy) || null,
        title: savedView.name,
        savedViewId: savedView.id,
      });
      setIsPromoting(false);
    } catch (requestError) {
      if (isMountedRef.current) {
        setPromotionError(requestError instanceof Error ? requestError.message : 'Could not save view.');
      }
    } finally {
      if (isMountedRef.current) {
        setIsSavingPromotion(false);
      }
    }
  }

  React.useEffect(() => {
    if (didAutoRunRef.current) {
      return;
    }

    didAutoRunRef.current = true;
    void run();
  }, [run]);

  React.useEffect(() => {
    if (previousQuerySignatureRef.current === querySignature) {
      return;
    }

    previousQuerySignatureRef.current = querySignature;
    queryGenerationRef.current += 1;
    activeRunRef.current += 1;
    setResult(null);
    setError(null);
    setIsRunning(false);

    if (didAutoRunRef.current) {
      void run();
    }
  }, [querySignature, run]);

  React.useEffect(() => {
    return subscribeQueryRefresh(() => {
      if (!didAutoRunRef.current) {
        return;
      }

      void run();
    });
  }, [run]);

  React.useEffect(() => {
    if (isSavedViewBacked) {
      setIsPromoting(false);
      setPromotionError(null);
    }
  }, [isSavedViewBacked]);

  return (
    <NodeViewWrapper className={`query-block ${selected ? 'is-selected' : ''}`}>
      <div className="query-block__toolbar">
        <strong>{displayTitle || 'Query'}</strong>
        {savedView ? <span className="query-block__badge">Saved View</span> : null}
        {isMissingSavedView ? <span className="query-block__badge is-warning">Saved View Missing</span> : null}
        <label className="query-block__title">
          <span>Title</span>
          <input
            value={displayTitle}
            readOnly={isSavedViewBacked || isSavingPromotion}
            onChange={(event) => updateTitle(event.target.value)}
            placeholder="View title"
          />
        </label>
        <select
          value={view}
          disabled={isSavedViewBacked || isSavingPromotion}
          onChange={(event) => updateView(event.target.value)}
        >
          <option value="table">Table</option>
          <option value="list">List</option>
          <option value="board">Board</option>
        </select>
        <button type="button" onClick={() => void run()} disabled={isRunning}>
          {isRunning ? 'Running' : 'Run'}
        </button>
        {view === 'board' ? (
          <label className="query-block__group">
            <span>Group</span>
            <input
              value={groupBy}
              readOnly={isSavedViewBacked || isSavingPromotion}
              onChange={(event) => updateGroupBy(event.target.value)}
              placeholder="status"
            />
          </label>
        ) : null}
        {savedView ? (
          <button type="button" onClick={detachSavedView}>
            Detach
          </button>
        ) : null}
        {!isSavedViewBacked ? (
          <button type="button" onClick={beginPromoting} disabled={!effectiveQuery.trim() || isSavingPromotion}>
            Save View
          </button>
        ) : null}
      </div>
      {isPromoting && !isSavedViewBacked ? (
        <form className="query-block__promotion" onSubmit={promoteQueryView}>
          <label>
            <span>Name</span>
            <input
              value={promotionName}
              onChange={(event) => setPromotionName(event.target.value)}
              placeholder="Saved view name"
            />
          </label>
          {promotionError ? <p className="query-block__promotion-error">{promotionError}</p> : null}
          <div className="query-block__promotion-actions">
            <button type="button" onClick={() => setIsPromoting(false)} disabled={isSavingPromotion}>
              Cancel
            </button>
            <button type="submit" disabled={!trimmedPromotionName || !effectiveQuery.trim() || isSavingPromotion}>
              {isSavingPromotion ? 'Saving' : 'Save View'}
            </button>
          </div>
        </form>
      ) : null}
      <textarea
        value={effectiveQuery}
        readOnly={isSavedViewBacked || isSavingPromotion}
        spellCheck={false}
        onChange={(event) => updateQuery(event.target.value)}
      />
      {error ? <p className="query-block__error">{error}</p> : null}
      {renderQueryResult(result, view, groupBy)}
    </NodeViewWrapper>
  );
}

function ExcalidrawNodeView({ node, updateAttributes, selected }: NodeViewProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const scene = normalizeScene(node.attrs.scene);
  const elementCount = Array.isArray(scene.elements) ? scene.elements.length : 0;

  return (
    <NodeViewWrapper className={`sketch-card ${selected ? 'is-selected' : ''}`}>
      <div className="sketch-card__header">
        <div>
          <p className="sketch-card__eyebrow">Excalidraw</p>
          <strong>{node.attrs.title || 'Sketch'}</strong>
        </div>
        <button type="button" onClick={() => setIsOpen((value) => !value)}>
          {isOpen ? 'Close' : 'Edit'}
        </button>
      </div>

      {isOpen ? (
        <div className="sketch-card__canvas">
          <Excalidraw
            initialData={scene}
            onChange={(elements, appState, files) => {
              updateAttributes({
                scene: {
                  elements,
                  appState: sanitizeExcalidrawAppState(appState),
                  files: sanitizeBinaryFiles(files),
                },
              });
            }}
          />
        </div>
      ) : (
        <button type="button" className="sketch-card__preview" onClick={() => setIsOpen(true)}>
          <span>{elementCount} elements</span>
          <span>Open sketch</span>
        </button>
      )}
    </NodeViewWrapper>
  );
}

function App() {
  const documentIdRef = React.useRef<string>('');
  const titleRef = React.useRef<string>('Untitled Note');
  const suppressUpdateRef = React.useRef(false);
  const changeTimerRef = React.useRef<number | null>(null);
  const pendingChangeRef = React.useRef<PendingEditorChange | null>(null);
  const loadGenerationRef = React.useRef(0);

  const flushPendingChange = React.useCallback(() => {
    if (changeTimerRef.current !== null) {
      window.clearTimeout(changeTimerRef.current);
      changeTimerRef.current = null;
    }

    if (pendingChangeRef.current) {
      postNativeMessage(pendingChangeRef.current);
      pendingChangeRef.current = null;
    }
  }, []);

  const editor = useEditor({
    extensions: [StarterKit, EntityReferenceNode, QueryViewNode, ExcalidrawNode],
    content: emptyDocument,
    editorProps: {
      attributes: {
        class: 'editor-prose',
      },
    },
    onUpdate: ({ editor }) => {
      if (suppressUpdateRef.current) {
        return;
      }

      if (convertQueryFenceBlocks(editor)) {
        return;
      }

      const pendingChange = buildChangePayload(documentIdRef.current, titleRef.current, editor);
      if (!pendingChange) {
        return;
      }

      pendingChangeRef.current = pendingChange;

      if (changeTimerRef.current !== null) {
        window.clearTimeout(changeTimerRef.current);
      }

      changeTimerRef.current = window.setTimeout(() => {
        flushPendingChange();
      }, 300);
    },
  });

  React.useEffect(() => {
    if (!editor) {
      return;
    }

    window.NotesEditor = {
      loadDocument(payload) {
        flushPendingChange();
        rejectPendingEntityRequests('Entity request cancelled because the active note changed.');
        rejectPendingQueryRequests('Query request cancelled because the active note changed.');
        rejectPendingSavedQueryViewRequests('Saved view request cancelled because the active note changed.');
        loadGenerationRef.current += 1;
        documentIdRef.current = payload.documentId;
        titleRef.current = payload.title;
        activeDocumentSnapshot = {
          documentId: documentIdRef.current,
          loadGeneration: loadGenerationRef.current,
        };
        suppressUpdateRef.current = true;

        const parsedContent = parseEditorContent(payload.contentJSON);
        const didSetContent = editor.commands.setContent(parsedContent, { emitUpdate: false });

        window.setTimeout(() => {
          suppressUpdateRef.current = false;
        }, 0);

        if (didSetContent) {
          postNativeMessage({ type: 'loaded', documentId: payload.documentId });
        }

        return didSetContent;
      },
      completeEntityRequest(response) {
        const pending = pendingEntityRequests.get(response.requestId);
        if (!pending) {
          return;
        }

        pendingEntityRequests.delete(response.requestId);

        if (
          pending.documentId !== documentIdRef.current ||
          pending.loadGeneration !== loadGenerationRef.current
        ) {
          pending.reject(new Error('Entity request cancelled because the active note changed.'));
          return;
        }

        if (response.error || !response.entityId || !response.label) {
          pending.reject(new Error(response.error || 'Entity request failed.'));
          return;
        }

        pending.resolve({
          entityId: response.entityId,
          label: response.label,
          tags: Array.isArray(response.tags) ? response.tags : [],
          properties: response.properties || {},
        });
      },
      completeQueryRequest(response) {
        const pending = pendingQueryRequests.get(response.requestId);
        if (!pending) {
          return;
        }

        pendingQueryRequests.delete(response.requestId);

        if (
          pending.documentId !== activeDocumentSnapshot.documentId ||
          pending.loadGeneration !== activeDocumentSnapshot.loadGeneration
        ) {
          pending.reject(new Error('Query request cancelled because the active note changed.'));
          return;
        }

        if (response.error) {
          pending.reject(new Error(response.error));
          return;
        }

        pending.resolve({
          columns: Array.isArray(response.columns) ? response.columns : [],
          rows: Array.isArray(response.rows) ? response.rows : [],
        });
      },
      completeSavedQueryViewRequest(response) {
        const pending = pendingSavedQueryViewRequests.get(response.requestId);
        if (!pending) {
          return;
        }

        pendingSavedQueryViewRequests.delete(response.requestId);

        if (
          pending.documentId !== activeDocumentSnapshot.documentId ||
          pending.loadGeneration !== activeDocumentSnapshot.loadGeneration
        ) {
          pending.reject(new Error('Saved view request cancelled because the active note changed.'));
          return;
        }

        if (response.error) {
          pending.reject(new Error(response.error));
          return;
        }

        const savedView = upsertSavedQueryViewSnapshot(response);
        if (!savedView) {
          pending.reject(new Error('Saved view response was invalid.'));
          return;
        }

        pending.resolve(savedView);
      },
      refreshQueryViews(payload) {
        const reason = typeof payload?.reason === 'string' ? payload.reason : 'dataChanged';
        notifyQueryRefresh(reason);
      },
      setSavedQueryViews(savedQueryViews) {
        setSavedQueryViewsSnapshot(savedQueryViews);
      },
    };

    postNativeMessage({ type: 'ready' });

    return () => {
      delete window.NotesEditor;
      setSavedQueryViewsSnapshot([]);
      rejectPendingEntityRequests('Editor unloaded before entity request completed.');
      rejectPendingQueryRequests('Editor unloaded before query request completed.');
      rejectPendingSavedQueryViewRequests('Editor unloaded before saved view request completed.');
      flushPendingChange();
    };
  }, [editor, flushPendingChange]);

  const getActiveDocumentSnapshot = React.useCallback(
    () => ({
      documentId: documentIdRef.current,
      loadGeneration: loadGenerationRef.current,
    }),
    []
  );

  return (
    <main className="editor-shell">
      <Toolbar editor={editor} getActiveDocumentSnapshot={getActiveDocumentSnapshot} />
      <EditorContent editor={editor} />
    </main>
  );
}

function Toolbar({
  editor,
  getActiveDocumentSnapshot,
}: {
  editor: ReturnType<typeof useEditor>;
  getActiveDocumentSnapshot(): ActiveDocumentSnapshot;
}) {
  const disabled = !editor;
  const savedQueryViews = React.useSyncExternalStore(
    subscribeSavedQueryViews,
    getSavedQueryViews,
    getSavedQueryViews
  );

  return (
    <div className="toolbar">
      <EntityInsertControl
        editor={editor}
        disabled={disabled}
        getActiveDocumentSnapshot={getActiveDocumentSnapshot}
      />
      <SavedViewInsertControl
        editor={editor}
        disabled={disabled}
        savedQueryViews={savedQueryViews}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          editor
            ?.chain()
            .focus()
            .insertContent({
              type: 'queryView',
              attrs: {
                query: 'SELECT * FROM entities',
                view: 'table',
                groupBy: null,
                title: null,
                savedViewId: null,
              },
            })
            .run();
        }}
      >
        Query
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          editor
            ?.chain()
            .focus()
            .insertContent({
              type: 'excalidraw',
              attrs: {
                drawingId: makeId('drawing'),
                title: 'Sketch',
                scene: emptyScene,
              },
            })
            .run();
        }}
      >
        Sketch
      </button>
    </div>
  );
}

function SavedViewInsertControl({
  editor,
  disabled,
  savedQueryViews,
}: {
  editor: ReturnType<typeof useEditor>;
  disabled: boolean;
  savedQueryViews: SavedQueryViewDefinition[];
}) {
  const [selectedId, setSelectedId] = React.useState('');
  const selectedValue = selectedId || savedQueryViews[0]?.id || '';
  const selectedSavedView =
    resolveSavedQueryView(selectedValue) ??
    savedQueryViews.find((savedQueryView) => savedQueryView.id === selectedValue) ??
    null;

  React.useEffect(() => {
    if (savedQueryViews.some((savedQueryView) => savedQueryView.id === selectedId)) {
      return;
    }

    setSelectedId(savedQueryViews[0]?.id ?? '');
  }, [savedQueryViews, selectedId]);

  function insertSavedView() {
    if (!editor || !selectedSavedView) {
      return;
    }

    editor
      .chain()
      .focus()
      .insertContent({
        type: 'queryView',
        attrs: {
          query: selectedSavedView.query,
          view: parseQueryViewMode(selectedSavedView.view),
          groupBy: parseQueryGroupBy(selectedSavedView.groupBy) || null,
          title: selectedSavedView.name,
          savedViewId: selectedSavedView.id,
        },
      })
      .run();
  }

  return (
    <div className="saved-view-insert">
      <label className="saved-view-insert__picker">
        <span>Saved View</span>
        <select
          value={selectedValue}
          disabled={disabled || savedQueryViews.length === 0}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {savedQueryViews.length === 0 ? (
            <option value="">No saved views</option>
          ) : (
            savedQueryViews.map((savedQueryView) => (
              <option key={savedQueryView.id} value={savedQueryView.id}>
                {savedQueryViewOptionLabel(savedQueryView)}
              </option>
            ))
          )}
        </select>
      </label>
      {selectedSavedView ? (
        <span className="saved-view-insert__summary">{savedQueryViewSummary(selectedSavedView)}</span>
      ) : null}
      <button type="button" disabled={disabled || !selectedSavedView} onClick={insertSavedView}>
        Insert
      </button>
    </div>
  );
}

function EntityInsertControl({
  editor,
  disabled,
  getActiveDocumentSnapshot,
}: {
  editor: ReturnType<typeof useEditor>;
  disabled: boolean;
  getActiveDocumentSnapshot(): ActiveDocumentSnapshot;
}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [tags, setTags] = React.useState('');
  const [properties, setProperties] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const trimmedName = name.trim();

  async function insertEntity(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !trimmedName || isSaving) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const requestSnapshot = getActiveDocumentSnapshot();
      if (!requestSnapshot.documentId) {
        throw new Error('No active note is loaded.');
      }

      const entity = await requestEntity(
        trimmedName,
        parseSupertags(tags),
        parseProperties(properties),
        requestSnapshot
      );
      const activeSnapshot = getActiveDocumentSnapshot();
      if (
        activeSnapshot.documentId !== requestSnapshot.documentId ||
        activeSnapshot.loadGeneration !== requestSnapshot.loadGeneration
      ) {
        throw new Error('Entity request cancelled because the active note changed.');
      }

      editor
        .chain()
        .focus()
        .insertContent({
          type: 'entityReference',
          attrs: {
            entityId: entity.entityId,
            label: entity.label,
            tags: entity.tags,
          },
        })
        .run();
      setName('');
      setTags('');
      setProperties('');
      setIsOpen(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not create entity.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="entity-insert">
      <button type="button" disabled={disabled} onClick={() => setIsOpen((value) => !value)}>
        Entity
      </button>

      {isOpen ? (
        <form className="entity-insert__form" onSubmit={insertEntity}>
          <label>
            <span>Name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Person, project, company"
            />
          </label>
          <label>
            <span>Supertags</span>
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="person, customer"
            />
          </label>
          <label>
            <span>Properties</span>
            <textarea
              value={properties}
              onChange={(event) => setProperties(event.target.value)}
              placeholder={'url: https://example.com\nstatus: active'}
              rows={3}
            />
          </label>
          {error ? <p className="entity-insert__error">{error}</p> : null}
          <div className="entity-insert__actions">
            <button type="button" onClick={() => setIsOpen(false)}>
              Cancel
            </button>
            <button type="submit" disabled={!trimmedName || isSaving}>
              {isSaving ? 'Creating' : 'Insert'}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function requestEntity(
  name: string,
  supertags: string[],
  properties: Record<string, string>,
  snapshot: ActiveDocumentSnapshot
): Promise<EntityReferencePayload> {
  const requestId = makeId('entity_request');

  return new Promise((resolve, reject) => {
    if (!window.webkit?.messageHandlers?.notesBridge) {
      reject(new Error('Entity database is unavailable.'));
      return;
    }

    pendingEntityRequests.set(requestId, { ...snapshot, resolve, reject });
    const message: NativeBridgeMessage = {
      type: 'upsertEntity',
      requestId,
      name,
      supertags,
    };

    if (Object.keys(properties).length > 0) {
      message.properties = properties;
    }

    postNativeMessage(message);
  });
}

function rejectPendingEntityRequests(message: string) {
  for (const [requestId, pending] of Array.from(pendingEntityRequests)) {
    pendingEntityRequests.delete(requestId);
    pending.reject(new Error(message));
  }
}

function requestQuery(
  query: string,
  snapshot: ActiveDocumentSnapshot
): Promise<QueryResultPayload> {
  const requestId = makeId('query_request');

  return new Promise((resolve, reject) => {
    if (!window.webkit?.messageHandlers?.notesBridge) {
      reject(new Error('Query database is unavailable.'));
      return;
    }

    pendingQueryRequests.set(requestId, { ...snapshot, resolve, reject });
    postNativeMessage({
      type: 'runQuery',
      requestId,
      query,
    });
  });
}

function requestSavedQueryView(
  savedView: {
    name: string;
    query: string;
    view: QueryViewMode;
    groupBy: string | null;
  },
  snapshot: ActiveDocumentSnapshot
): Promise<SavedQueryViewDefinition> {
  const requestId = makeId('saved_view_request');

  return new Promise((resolve, reject) => {
    if (!window.webkit?.messageHandlers?.notesBridge) {
      reject(new Error('Saved view database is unavailable.'));
      return;
    }

    pendingSavedQueryViewRequests.set(requestId, { ...snapshot, resolve, reject });
    postNativeMessage({
      type: 'saveQueryView',
      requestId,
      name: savedView.name,
      query: savedView.query,
      view: savedView.view,
      groupBy: savedView.groupBy,
    });
  });
}

function rejectPendingQueryRequests(message: string) {
  for (const [requestId, pending] of Array.from(pendingQueryRequests)) {
    pendingQueryRequests.delete(requestId);
    pending.reject(new Error(message));
  }
}

function rejectPendingSavedQueryViewRequests(message: string) {
  for (const [requestId, pending] of Array.from(pendingSavedQueryViewRequests)) {
    pendingSavedQueryViewRequests.delete(requestId);
    pending.reject(new Error(message));
  }
}

function getCurrentDocumentSnapshot(): ActiveDocumentSnapshot {
  return { ...activeDocumentSnapshot };
}

function parseSupertags(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const tag of value.split(',')) {
    const normalized = tag.trim().replace(/^#+/, '');
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function parseProperties(value: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of value.split(/\r?\n/)) {
    const separatorIndex = line.search(/[:=]/);
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const propertyValue = line.slice(separatorIndex + 1).trim();
    if (key && propertyValue) {
      result[key] = propertyValue;
    }
  }

  return result;
}

function renderQueryResult(
  result: QueryResultPayload | null,
  view: QueryViewMode,
  groupBy = ''
) {
  if (!result) {
    return <p className="query-block__empty">Run the query to load results.</p>;
  }

  if (result.rows.length === 0) {
    return <p className="query-block__empty">No rows.</p>;
  }

  switch (view) {
    case 'list':
      return (
        <ul className="query-list">
          {result.rows.map((row, index) => {
            return (
              <li key={queryRowKey(row, index)}>
                <strong>{primaryQueryValue(row, result.columns)}</strong>
                {secondaryQueryValues(row, result.columns).map(([column, value]) => (
                  <span key={column}>
                    {column}: {value}
                  </span>
                ))}
                {renderQueryRowActions(row, result.columns)}
              </li>
            );
          })}
        </ul>
      );

    case 'board':
      const groups = buildBoardGroups(result.rows, result.columns, groupBy);
      return (
        <div className="query-board">
          {groups.map((group) => (
            <section className="query-board__column" key={group.title}>
              <div className="query-board__header">
                <strong>{group.title}</strong>
                <span>{group.rows.length}</span>
              </div>
              <div className="query-board__cards">
                {group.rows.map((row, index) => {
                  return (
                    <article key={queryRowKey(row, index)}>
                      <strong>{primaryQueryValue(row, result.columns)}</strong>
                      {secondaryQueryValues(row, result.columns, [group.column]).map(([column, value]) => (
                        <span key={column}>
                          {column}: {value}
                        </span>
                      ))}
                      {renderQueryRowActions(row, result.columns)}
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      );

    case 'table':
      const hasRowActions = result.rows.some((row) => hasQueryRowActions(row, result.columns));
      return (
        <div className="query-table-wrap">
          <table className="query-table">
            <thead>
              <tr>
                {result.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
                {hasRowActions ? <th className="query-table__action">Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => {
                return (
                  <tr key={queryRowKey(row, index)}>
                    {result.columns.map((column) => (
                      <td key={column}>{row[column] || ''}</td>
                    ))}
                    {hasRowActions ? (
                      <td className="query-table__action">{renderQueryRowActions(row, result.columns)}</td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
  }
}

function hasQueryRowActions(row: Record<string, string>, columns: string[]) {
  return Boolean(queryRowDocumentId(row, columns) || queryRowEntityId(row, columns));
}

function renderQueryRowActions(row: Record<string, string>, columns: string[]) {
  const documentId = queryRowDocumentId(row, columns);
  const entityId = queryRowEntityId(row, columns);

  if (!documentId && !entityId) {
    return null;
  }

  return (
    <div className="query-row-actions">
      {documentId ? (
        <button type="button" className="query-row-action" onClick={() => openQueryDocument(documentId)}>
          Note
        </button>
      ) : null}
      {entityId ? (
        <button type="button" className="query-row-action" onClick={() => openQueryEntity(entityId)}>
          Entity
        </button>
      ) : null}
    </div>
  );
}

function primaryQueryValue(row: Record<string, string>, columns: string[]) {
  return row.name || row.title || row.date || row[columns[0]] || 'Untitled';
}

function secondaryQueryValues(
  row: Record<string, string>,
  columns: string[],
  excludedColumns: Array<string | null> = []
) {
  const primary = primaryQueryValue(row, columns);
  const excluded = new Set(excludedColumns.filter((column): column is string => Boolean(column)));
  return columns
    .map((column) => [column, row[column] || ''] as const)
    .filter(([column, value]) => !excluded.has(column) && value && value !== primary)
    .slice(0, 4);
}

function queryRowKey(row: Record<string, string>, index: number) {
  return row.id || `${index}-${primaryQueryValue(row, Object.keys(row))}`;
}

function openQueryDocument(documentId: string) {
  postNativeMessage({
    type: 'openDocument',
    documentId,
  });
}

function openQueryEntity(entityId: string) {
  postNativeMessage({
    type: 'openEntity',
    entityId,
  });
}

type PendingEditorChange = Extract<NativeBridgeMessage, { type: 'change' }>;

function convertQueryFenceBlocks(editor: NonNullable<ReturnType<typeof useEditor>>) {
  const replacement = findQueryFenceReplacement(editor);
  if (!replacement) {
    return false;
  }

  return editor.commands.command(({ tr, dispatch }) => {
    const queryViewNode = editor.state.schema.nodes.queryView?.create(
      queryFenceReplacementToNodeAttributes(replacement)
    );
    if (!queryViewNode) {
      return false;
    }

    tr.replaceWith(replacement.from, replacement.to, queryViewNode);
    dispatch?.(tr.scrollIntoView());
    return true;
  });
}

function findQueryFenceReplacement(
  editor: NonNullable<ReturnType<typeof useEditor>>
): QueryFenceReplacement | null {
  let codeBlockReplacement: QueryFenceReplacement | null = null;
  editor.state.doc.descendants((node, position) => {
    if (codeBlockReplacement || node.type.name !== 'codeBlock') {
      return !codeBlockReplacement;
    }

    const parsed = parseQueryCodeBlock(node.attrs.language, node.textContent);
    if (parsed) {
      codeBlockReplacement = {
        from: position,
        to: position + node.nodeSize,
        ...parsed,
      };
    }

    return !codeBlockReplacement;
  });

  return codeBlockReplacement || findParagraphQueryFenceReplacement(buildTopLevelTextBlocks(editor));
}

function buildTopLevelTextBlocks(editor: NonNullable<ReturnType<typeof useEditor>>) {
  const blocks: QueryFenceTextBlock[] = [];
  editor.state.doc.forEach((node, offset) => {
    blocks.push({
      from: offset,
      to: offset + node.nodeSize,
      text: node.textBetween(0, node.content.size, '\n', '\n'),
      type: node.type.name,
    });
  });

  return blocks;
}

function buildChangePayload(
  documentId: string,
  fallbackTitle: string,
  editor: NonNullable<ReturnType<typeof useEditor>>
): PendingEditorChange | null {
  if (!documentId) {
    return null;
  }

  const content = editor.getJSON();
  const title = inferTitle(content, fallbackTitle);

  return {
    type: 'change',
    documentId,
    title,
    contentJSON: JSON.stringify(content),
    plainText: editor.getText({ blockSeparator: '\n' }),
  };
}

function postNativeMessage(message: NativeBridgeMessage) {
  window.webkit?.messageHandlers?.notesBridge?.postMessage(message);
}

function parseEditorContent(contentJSON: string) {
  try {
    const parsed = JSON.parse(contentJSON);
    return parsed && typeof parsed === 'object' ? parsed : emptyDocument;
  } catch {
    return emptyDocument;
  }
}

function inferTitle(content: unknown, fallback: string): string {
  const nodes = isRecord(content) && Array.isArray(content.content) ? content.content : [];
  const heading = nodes.find((node) => isRecord(node) && node.type === 'heading');

  if (isRecord(heading) && Array.isArray(heading.content)) {
    const text = heading.content
      .map((child) => (isRecord(child) && typeof child.text === 'string' ? child.text : ''))
      .join('')
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  return fallback.trim() || 'Untitled Note';
}

function normalizeScene(scene: unknown): ExcalidrawInitialDataState {
  if (!isRecord(scene)) {
    return emptyScene;
  }

  return {
    elements: Array.isArray(scene.elements)
      ? (scene.elements as ExcalidrawInitialDataState['elements'])
      : [],
    appState: isRecord(scene.appState)
      ? sanitizeExcalidrawAppState(scene.appState as Partial<AppState>)
      : {},
    files: isRecord(scene.files) ? sanitizeBinaryFiles(scene.files as BinaryFiles) : {},
  };
}

function sanitizeExcalidrawAppState(appState: Partial<AppState>): Partial<AppState> {
  if (!isRecord(appState)) {
    return {};
  }

  const persistedKeys: (keyof AppState)[] = [
    'currentItemBackgroundColor',
    'currentItemEndArrowhead',
    'currentItemFillStyle',
    'currentItemFontFamily',
    'currentItemFontSize',
    'currentItemOpacity',
    'currentItemRoughness',
    'currentItemStartArrowhead',
    'currentItemStrokeColor',
    'currentItemStrokeStyle',
    'currentItemStrokeWidth',
    'currentItemTextAlign',
    'gridSize',
    'gridStep',
    'name',
    'scrollX',
    'scrollY',
    'theme',
    'viewBackgroundColor',
    'viewModeEnabled',
    'zoom',
  ];

  const sanitized: Record<string, unknown> = {};
  for (const key of persistedKeys) {
    const value = appState[key];
    if (value !== undefined && isJSONValue(value)) {
      sanitized[key] = cloneJSON(value);
    }
  }

  return sanitized as Partial<AppState>;
}

function sanitizeBinaryFiles(files: BinaryFiles): BinaryFiles {
  const sanitized: Record<string, BinaryFileData> = {};

  for (const [id, file] of Object.entries(files)) {
    if (
      isRecord(file) &&
      typeof file.id === 'string' &&
      typeof file.mimeType === 'string' &&
      typeof file.dataURL === 'string' &&
      typeof file.created === 'number'
    ) {
      sanitized[id] = file as BinaryFileData;
    }
  }

  return sanitized as BinaryFiles;
}

function isJSONValue(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function cloneJSON<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? value : (JSON.parse(serialized) as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function makeId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Math.random().toString(36).slice(2)}`;
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
