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

type NativeBridgeMessage =
  | { type: 'ready' }
  | { type: 'loaded'; documentId: string }
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
    extensions: [StarterKit, ExcalidrawNode],
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
    };

    postNativeMessage({ type: 'ready' });

    return () => {
      delete window.NotesEditor;
      flushPendingChange();
    };
  }, [editor, flushPendingChange]);

  return (
    <main className="editor-shell">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </main>
  );
}

function Toolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  const disabled = !editor;

  return (
    <div className="toolbar">
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
