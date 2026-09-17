/// <reference types="node" />
// @vitest-environment jsdom
import type { JSONContent } from '@tiptap/core';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { createDailyEditor, type DailyEditorHandle } from '../../src/editor';

const handles: DailyEditorHandle[] = [];
const day = '2026-09-08';
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
async function open(snapshot?: Uint8Array, legacy?: Uint8Array) {
  const changes: Uint8Array[] = [];
  const element = document.createElement('div');
  document.body.append(element);
  const handle = createDailyEditor({ element, day, snapshot, legacy, onChange: bytes => changes.push(bytes), onDiagramEdit: () => {} });
  handles.push(handle);
  await handle.ready;
  await settle();
  return { handle, editor: handle.editor, changes };
}
afterEach(() => { for (const handle of handles.splice(0)) handle.destroy(); document.body.innerHTML = ''; });

function legacySnapshot(font?: unknown) {
  const doc = new LoroDoc();
  doc.getMap('metadata').set('day', day);
  doc.getMap('metadata').set('schemaVersion', 1);
  doc.configTextStyle({ font: { expand: 'after' } });
  doc.getText('body').insert(0, 'Hello 🦀\nsecond');
  if (font) doc.getText('body').mark({ start: 0, end: 5 }, 'font', JSON.stringify(font));
  return doc.export({ mode: 'snapshot' });
}

describe('daily Loro editor', () => {
  it('does not save bootstrap or selection, creates snapshot on first real edit', async () => {
    const { handle, editor, changes } = await open();
    expect(changes).toHaveLength(0);
    editor.commands.setTextSelection(1);
    await settle();
    expect(changes).toHaveLength(0);
    editor.commands.insertContent('Hello 🦀');
    await settle();
    expect(changes.length).toBeGreaterThan(0);
    const reopened = await open(handle.exportSnapshot());
    expect(reopened.editor.getText()).toBe('Hello 🦀');
    expect(reopened.changes).toHaveLength(0);
  });

  it('uses one rich document across paragraphs, lists, tasks, tables, and diagrams', async () => {
    const { editor, handle } = await open();
    editor.commands.setContent({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Before', marks: [{ type: 'bold' }, { type: 'italic' }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bullet' }] }] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done' }] }] }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell' }] }] }] }] },
      { type: 'diagram', attrs: { id: 'diagram-1', kind: 'd2', source: 'a -> b' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
    ] });
    await settle();
    if (process.env.EDITOR_FIXTURE_PATH) writeFileSync(process.env.EDITOR_FIXTURE_PATH, handle.exportSnapshot());
    const expected = editor.getJSON();
    const reopened = await open(handle.exportSnapshot());
    expect(reopened.editor.getJSON()).toEqual(expected);
    reopened.handle.updateDiagram('diagram-1', 'a -> b', 'a -> c');
    expect(() => reopened.handle.updateDiagram('diagram-1', 'a -> b', 'stale')).toThrow(/changed/);
    expect(reopened.editor.getJSON().content?.find(node => node.type === 'diagram')?.attrs?.source).toBe('a -> c');
  });

  it('undoes one cross-block delete and restores the full document', async () => {
    const { editor } = await open();
    editor.commands.insertContent('first');
    editor.commands.splitBlock();
    editor.commands.insertContent('second');
    await new Promise(resolve => setTimeout(resolve, 550));
    const before = editor.getJSON();
    editor.commands.setTextSelection({ from: 2, to: 11 });
    editor.commands.deleteSelection();
    await settle();
    expect(editor.getJSON()).not.toEqual(before);
    expect(editor.commands.undo()).toBe(true);
    await settle();
    expect(editor.getJSON()).toEqual(before);
  });

  it('rejects unknown nodes and marks before the binding can discard them', async () => {
    const { handle, editor } = await open();
    editor.commands.insertContent('preserve');
    await settle();
    for (const mode of ['node', 'mark']) {
      const doc = new LoroDoc(); doc.import(handle.exportSnapshot());
      const paragraph = (doc.getMap('doc').get('children') as LoroList).get(0) as LoroMap;
      if (mode === 'node') paragraph.set('nodeName', 'futureBlock');
      else {
        doc.configTextStyle({ futureMark: { expand: 'after' } });
        const text = (paragraph.get('children') as LoroList).get(0) as LoroText;
        text.mark({ start: 0, end: 1 }, 'futureMark', {});
      }
      expect(() => createDailyEditor({ element: document.createElement('div'), day,
        snapshot: doc.export({ mode: 'snapshot' }), onChange: () => { throw new Error('Must not save'); }, onDiagramEdit: () => {} })).toThrow(/Unsupported/);
      doc.free();
    }
  });

  it('migrates verified SwiftUI system17 bold and rejects unsupported fonts', async () => {
    const system = { tag: { system: {} }, value: { design: {}, size: 17, weight: {} } };
    const bold = { tag: { staticModifier: { _0: { do: { _0: { bold: {} } } } } }, value: system };
    const { editor, handle, changes } = await open(undefined, legacySnapshot(bold));
    expect(editor.getText()).toBe('Hello 🦀\n\nsecond');
    expect(editor.getJSON().content?.[0].content?.[0].marks).toEqual([{ type: 'bold' }]);
    expect(changes).toHaveLength(0);
    const reopened = await open(handle.exportSnapshot());
    expect(reopened.editor.getJSON()).toEqual(editor.getJSON());
    const custom = { ...system, value: { ...system.value, size: 42 } };
    expect(() => createDailyEditor({ element: document.createElement('div'), day,
      legacy: legacySnapshot(custom), onChange: () => {}, onDiagramEdit: () => {} })).toThrow(/Unsupported legacy system font/);
  });
  it('continues and exits lists through native Enter and joins paragraphs with Backspace', async () => {
    const { editor } = await open();
    editor.commands.setContent({ type: 'doc', content: [{ type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] },
    ] }] });
    let end = 0;
    editor.state.doc.descendants((node, pos) => { if (node.isText) end = pos + node.nodeSize; });
    editor.commands.setTextSelection(end);
    editor.commands.keyboardShortcut('Enter');
    expect(editor.getJSON().content?.[0].content).toHaveLength(2);
    editor.commands.keyboardShortcut('Enter');
    expect(editor.getJSON().content?.map(node => node.type)).toEqual(['bulletList', 'paragraph']);
    editor.commands.setContent({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
    ] });
    editor.commands.setTextSelection(8);
    editor.commands.keyboardShortcut('Backspace');
    expect(editor.getJSON().content).toHaveLength(1);
    expect(editor.getText()).toBe('firstsecond');
  });

  it('migrates v2 nested lists, checked tasks, and diagram source into the same document', async () => {
    const legacy = new LoroDoc();
    legacy.getMap('metadata').set('schemaVersion', 2);
    legacy.getMap('metadata').set('day', day);
    legacy.getText('body').insert(0, 'Original body');
    const list = legacy.getMovableList('components');
    const blocks = [
      { kind: 'bullet', text: 'Parent', indent: 0, checked: false },
      { kind: 'checklist', text: 'Nested task', indent: 1, checked: true },
      { kind: 'd2', text: 'a -> b', indent: 0, checked: false },
    ];
    blocks.forEach((block, index) => {
      const map = list.insertContainer(index, new LoroMap());
      map.set('id', `00000000-0000-0000-0000-00000000000${index}`);
      map.set('version', 1);
      for (const [key, value] of Object.entries(block)) if (key !== 'text') map.set(key, value);
      map.setContainer('text', new LoroText()).insert(0, block.text);
    });
    const { editor, handle, changes } = await open(undefined, legacy.export({ mode: 'snapshot' }));
    const content = editor.getJSON().content! as JSONContent[];
    expect(content.map(node => node.type)).toEqual(['paragraph', 'bulletList', 'diagram']);
    expect(content[1].content?.[0].content?.[1]).toMatchObject({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true } }] });
    expect(content[2].attrs?.source).toBe('a -> b');
    expect(changes).toHaveLength(0);
    expect((await open(handle.exportSnapshot())).editor.getJSON()).toEqual(editor.getJSON());
    legacy.free();
  });

  it('rejects unknown attributes and unsupported schema versions without saving', async () => {
    const { handle } = await open();
    for (const mutation of ['attribute', 'version']) {
      const doc = new LoroDoc(); doc.import(handle.exportSnapshot());
      if (mutation === 'version') doc.getMap('metadata').set('editorSchema', 2);
      else {
        const paragraph = (doc.getMap('doc').get('children') as LoroList).get(0) as LoroMap;
        (paragraph.get('attributes') as LoroMap).set('futureAttribute', 'preserve');
      }
      expect(() => createDailyEditor({ element: document.createElement('div'), day,
        snapshot: doc.export({ mode: 'snapshot' }), onChange: () => { throw new Error('Must not save'); }, onDiagramEdit: () => {} })).toThrow();
      doc.free();
    }
  });

  it('gives copied diagram atoms separate identities and preserves both on reopen', async () => {
    const { editor, handle } = await open();
    const diagram = { type: 'diagram', attrs: { id: 'copied', kind: 'd2', source: 'a -> b' } };
    editor.commands.setContent({ type: 'doc', content: [diagram, diagram, { type: 'paragraph' }] });
    await settle();
    const diagrams = editor.getJSON().content!.filter(node => node.type === 'diagram');
    expect(new Set(diagrams.map(node => node.attrs?.id)).size).toBe(2);
    expect((await open(handle.exportSnapshot())).editor.getJSON()).toEqual(editor.getJSON());
  });

});
