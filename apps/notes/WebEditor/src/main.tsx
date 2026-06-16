import React from 'react';
import ReactDOM from 'react-dom/client';
import { EditorContent, NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import { Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Excalidraw } from '@excalidraw/excalidraw';
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
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
};

type EntityBridgeResponse = {
  requestId: string;
  entityId?: string | null;
  label?: string | null;
  tags?: string[];
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

type NativeBridgeMessage =
  | { type: 'ready' }
  | { type: 'loaded'; documentId: string }
  | {
      type: 'upsertEntity';
      requestId: string;
      name: string;
      supertags: string[];
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
    extensions: [StarterKit, EntityReferenceNode, ExcalidrawNode],
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
        loadGenerationRef.current += 1;
        documentIdRef.current = payload.documentId;
        titleRef.current = payload.title;
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
        });
      },
    };

    postNativeMessage({ type: 'ready' });

    return () => {
      delete window.NotesEditor;
      rejectPendingEntityRequests('Editor unloaded before entity request completed.');
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

  return (
    <div className="toolbar">
      <EntityInsertControl
        editor={editor}
        disabled={disabled}
        getActiveDocumentSnapshot={getActiveDocumentSnapshot}
      />
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

      const entity = await requestEntity(trimmedName, parseSupertags(tags), requestSnapshot);
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
  snapshot: ActiveDocumentSnapshot
): Promise<EntityReferencePayload> {
  const requestId = makeId('entity_request');

  return new Promise((resolve, reject) => {
    if (!window.webkit?.messageHandlers?.notesBridge) {
      reject(new Error('Entity database is unavailable.'));
      return;
    }

    pendingEntityRequests.set(requestId, { ...snapshot, resolve, reject });
    postNativeMessage({
      type: 'upsertEntity',
      requestId,
      name,
      supertags,
    });
  });
}

function rejectPendingEntityRequests(message: string) {
  for (const [requestId, pending] of Array.from(pendingEntityRequests)) {
    pendingEntityRequests.delete(requestId);
    pending.reject(new Error(message));
  }
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

type PendingEditorChange = Extract<NativeBridgeMessage, { type: 'change' }>;

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
