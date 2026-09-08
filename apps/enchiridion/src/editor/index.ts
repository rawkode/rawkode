import { Editor, Extension, getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { LoroDoc, UndoManager } from 'loro-crdt';
import { LoroSyncPlugin, LoroUndoPlugin, loroSyncPluginKey, updateLoroToPmState, undo, redo, type LoroDocType } from 'loro-prosemirror';
import { editorExtensions, validateDiagram } from './schema';
import { BINDING_VERSION, DOCUMENT_VERSION, preflightSnapshot } from './validation';
import { projectLegacy } from './legacy';
import type { DailyEditorHandle, DailyEditorOptions } from './types';
export type { DailyEditorHandle, DailyEditorOptions, DiagramKind, DiagramEditRequest } from './types';

export function createDailyEditor(options: DailyEditorOptions): DailyEditorHandle {
  if (options.snapshot && options.legacy) throw new Error('Choose either a current snapshot or a legacy note.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.day)) throw new Error('Invalid daily note date.');
  const extensions = editorExtensions(options);
  const schema = getSchema(extensions);
  const doc = new LoroDoc();
  doc.configTextStyle(Object.fromEntries(Object.entries(schema.marks).map(([name, mark]) => [name, {
    expand: mark.spec.inclusive === false ? 'none' as const : 'after' as const,
  }])));
  let initial;
  try {
    if (options.snapshot) {
      doc.import(options.snapshot);
      initial = preflightSnapshot(doc, options.day, schema);
    } else {
      initial = schema.nodeFromJSON(options.legacy ? projectLegacy(options.legacy, options.day) : {
        type: 'doc', content: [{ type: 'paragraph' }],
      });
      initial.check();
      const metadata = doc.getMap('metadata');
      for (const [key, value] of Object.entries({ schemaVersion: DOCUMENT_VERSION, day: options.day,
        binding: 'loro-prosemirror', bindingVersion: BINDING_VERSION, editorSchema: 1 })) metadata.set(key, value);
      updateLoroToPmState(doc as LoroDocType, new Map(), EditorState.create({ schema, doc: initial }));
      doc.commit({ origin: 'sys:init' });
      preflightSnapshot(doc, options.day, schema);
    }
  } catch (error) { doc.free(); throw error; }

  const undoManager = new UndoManager(doc, { mergeInterval: 500 });
  const collaboration = Extension.create({
    name: 'loroDailyDocument',
    addProseMirrorPlugins: () => [LoroSyncPlugin({ doc: doc as LoroDocType }), LoroUndoPlugin({ doc, undoManager })],
    addCommands() {
      return {
        undo: () => ({ state, dispatch, tr }) => {
          if (dispatch) tr.setMeta('preventDispatch', true);
          return undo(state, dispatch);
        },
        redo: () => ({ state, dispatch, tr }) => {
          if (dispatch) tr.setMeta('preventDispatch', true);
          return redo(state, dispatch);
        },
      };
    },
    addKeyboardShortcuts() {
      return {
        'Mod-z': () => this.editor.commands.undo(),
        'Mod-Shift-z': () => this.editor.commands.redo(),
        'Mod-y': () => this.editor.commands.redo(),
      };
    },
  });
  let active = true;
  let initialized = false;
  let notifyQueued = false;
  const emitSelection = () => {
    if (!initialized || !active || !options.onSelection) return;
    const { selection } = editor.state;
    let rect: DOMRect | null = null;
    if (!selection.empty) {
      try {
        const start = editor.view.coordsAtPos(selection.from);
        const end = editor.view.coordsAtPos(selection.to);
        rect = new DOMRect(Math.min(start.left, end.left), Math.min(start.top, end.top),
          Math.max(start.right, end.right) - Math.min(start.left, end.left),
          Math.max(start.bottom, end.bottom) - Math.min(start.top, end.top));
      } catch { /* A detached view has no selection geometry. */ }
    }
    options.onSelection({ empty: selection.empty, rect,
      formats: ['bold', 'italic', 'underline', 'strike', 'code', 'link'].filter(format => editor.isActive(format)) });
  };
  const editor = new Editor({
    element: options.element, extensions: [...extensions, collaboration], content: initial.toJSON(), editable: false,
    editorProps: { attributes: { class: 'daily-prose', 'aria-label': 'Daily note', spellcheck: 'true' } },
    onSelectionUpdate: emitSelection,
    onUpdate: emitSelection,
  });
  const flushNativeInput = () => {
    // ProseMirror buffers MutationObserver records (including composition edits).
    // setEditable redraws the view before its delayed flush, losing pending input.
    // This private seam is pinned by @tiptap/pm and covered by a DOM-input test.
    const view = editor.view as unknown as { domObserver: { flush(): void } };
    view.domObserver.flush();
  };
  const unsubscribe = doc.subscribe(event => {
    if (!active || !initialized || event.by !== 'local' || event.origin?.startsWith('sys:')) return;
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      if (active && initialized) options.onChange(doc.export({ mode: 'snapshot' }));
    });
  });
  const ready = new Promise<void>(resolve => {
    // The official binding initializes its mapping in its own zero-delay task.
    setTimeout(() => {
      if (active) { initialized = true; editor.setEditable(true, false); }
      resolve();
    }, 0);
  });
  return {
    editor, ready,
    exportSnapshot() {
      if (!active || !initialized) throw new Error('The editor is not ready.');
      flushNativeInput();
      return doc.export({ mode: 'snapshot' });
    },
    prepareForTransition() {
      if (!active || !initialized) throw new Error('The editor is not ready.');
      if (editor.view.composing) throw new Error('Finish the current text composition before changing days or quitting.');
      flushNativeInput();
      editor.setEditable(false, false);
    },
    insertDiagram(kind, source = '') {
      if (!active || !initialized) throw new Error('The editor is not ready.');
      const id = crypto.randomUUID();
      validateDiagram(kind, source, id);
      editor.chain().focus().insertContent([{ type: 'diagram', attrs: { id, kind, source } }, { type: 'paragraph' }]).run();
      return id;
    },
    updateDiagram(id, expectedSource, source) {
      if (!active || !initialized) throw new Error('The editor is not ready.');
      let position: number | undefined;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'diagram' && node.attrs.id === id) { position = pos; return false; }
      });
      if (position === undefined) throw new Error('This diagram was removed. Your changes have not overwritten the note.');
      const node = editor.state.doc.nodeAt(position)!;
      if (node.attrs.source !== expectedSource) throw new Error('This diagram changed while it was open. Reopen it before editing.');
      validateDiagram(node.attrs.kind, source, id);
      if (source !== expectedSource) editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, source }));
    },
    destroy() {
      if (!active) return;
      active = false;
      unsubscribe();
      loroSyncPluginKey.getState(editor.state)?.docSubscription?.();
      editor.destroy();
      undoManager.free();
      doc.free();
    },
  };
}
