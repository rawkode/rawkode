import { Node, mergeAttributes, type Extensions } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import type { DailyEditorOptions, DiagramKind } from './types';

export function validateDiagram(kind: unknown, source: unknown, id: unknown): asserts kind is DiagramKind {
  if ((kind !== 'd2' && kind !== 'excalidraw') || typeof source !== 'string' ||
      typeof id !== 'string' || !id || id.length > 128 || source.includes('\0')) {
    throw new Error('This diagram has an unsupported structure. The saved note is preserved.');
  }
  const limit = kind === 'd2' ? 512 * 1024 : 8 * 1024 * 1024;
  if (new TextEncoder().encode(source).length > limit) throw new Error('This diagram exceeds the supported size.');
  if (kind === 'excalidraw' && source) {
    const scene = JSON.parse(source);
    if (scene.type !== 'excalidraw' || scene.version !== 2 || !Array.isArray(scene.elements) ||
        !scene.appState || typeof scene.appState !== 'object' || scene.elements.length > 50_000) {
      throw new Error('This drawing has an unsupported scene format.');
    }
    const ids = new Set<string>();
    for (const element of scene.elements) {
      if (!element || typeof element.id !== 'string' || !element.id || ids.has(element.id) || typeof element.type !== 'string') {
        throw new Error('This drawing contains invalid elements.');
      }
      ids.add(element.id);
      if (element.type === 'image' && element.fileId) {
        const file = scene.files?.[element.fileId];
        if (typeof file?.dataURL !== 'string' || !file.dataURL.startsWith('data:image/')) {
          throw new Error('This drawing is missing an embedded image.');
        }
      }
    }
  }
}

export function editorExtensions(options: Pick<DailyEditorOptions, 'onDiagramEdit' | 'loadPreview'>): Extensions {
  const Diagram = Node.create({
    name: 'diagram', group: 'block', atom: true, selectable: true, draggable: true,
    addAttributes() {
      return { id: { default: null }, kind: { default: 'd2' }, source: { default: '' } };
    },
    parseHTML() {
      return [{ tag: 'figure[data-diagram]', getAttrs(element) {
        const attrs = { id: crypto.randomUUID(), kind: element.getAttribute('data-diagram'), source: element.getAttribute('data-source') ?? '' };
        try { validateDiagram(attrs.kind, attrs.source, attrs.id); return attrs; } catch { return false; }
      } }];
    },
    renderHTML({ node, HTMLAttributes }) {
      return ['figure', mergeAttributes(HTMLAttributes, {
        'data-diagram': node.attrs.kind, 'data-id': node.attrs.id, 'data-source': node.attrs.source,
      }), ['span', {}, node.attrs.kind === 'd2' ? 'D2 diagram' : 'Drawing']];
    },
    addProseMirrorPlugins() {
      return [new Plugin({
        appendTransaction(transactions, _old, state) {
          if (!transactions.some(transaction => transaction.docChanged)) return null;
          const ids = new Set<string>();
          const tr = state.tr;
          state.doc.descendants((node, pos) => {
            if (node.type.name !== 'diagram') return;
            if (ids.has(node.attrs.id)) {
              // Alt-drag and internal clipboard slices can copy an existing atom.
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: crypto.randomUUID() });
            }
            ids.add(node.attrs.id);
          });
          return tr.docChanged ? tr : null;
        },
      })];
    },
    addNodeView() {
      return ({ node: initial }) => {
        let node = initial;
        let generation = 0;
        const dom = document.createElement('figure');
        dom.className = 'diagram-node';
        dom.contentEditable = 'false';
        const image = document.createElement('img');
        image.className = 'diagram-preview';
        image.hidden = true;
        const footer = document.createElement('figcaption');
        const label = document.createElement('span');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Edit';
        button.addEventListener('click', event => {
          event.preventDefault();
          options.onDiagramEdit({ id: node.attrs.id, kind: node.attrs.kind, source: node.attrs.source });
        });
        footer.append(label, button);
        dom.append(image, footer);
        const refresh = () => {
          const version = ++generation;
          label.textContent = node.attrs.kind === 'd2' ? 'D2 diagram' : 'Drawing';
          button.setAttribute('aria-label', `Edit ${label.textContent.toLowerCase()}`);
          image.alt = label.textContent;
          image.hidden = true;
          image.removeAttribute('src');
          options.loadPreview?.(node.attrs.kind, node.attrs.source).then(url => {
            if (version === generation && url?.startsWith('data:image/png;base64,')) {
              image.src = url;
              image.hidden = false;
            }
          }).catch(() => {}); // A missing derived preview must not block editable source.
        };
        refresh();
        return {
          dom,
          update(next) {
            if (next.type !== node.type) return false;
            const changed = next.attrs.source !== node.attrs.source || next.attrs.kind !== node.attrs.kind;
            node = next;
            if (changed) refresh();
            return true;
          },
          stopEvent: event => button.contains(event.target as globalThis.Node),
          ignoreMutation: () => true,
          destroy: () => { generation++; },
        };
      };
    },
  });
  return [
    StarterKit.configure({ undoRedo: false, trailingNode: false, link: { openOnClick: false, protocols: ['http', 'https', 'mailto'], isAllowedUri: url => /^(https?:\/\/|mailto:)/i.test(url) && !/[\u0000-\u001f]/.test(url) } }),
    TaskList, TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }), TableRow, TableHeader, TableCell, Diagram,
  ];
}
