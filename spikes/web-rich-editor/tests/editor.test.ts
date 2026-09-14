import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { Editor } from '@tiptap/core';
import { Editor as VueEditor } from '@tiptap/vue-3';
import { documentExtensions, applyBlockStyle } from '../src/editor/extensions';
import { loadDocument, saveDocument, draftSchema } from '../src/editor/persistence';
import { parseNote } from '../src/lib/note';
import { FencedCodeAuthoring, createFenceEnterTransaction, fenceAuthoringKey } from '../src/editor/fencedCode';

const text = (value: string) => ({ type: 'text', text: value });
const paragraph = (value: string) => ({ type: 'paragraph', ...(value ? { content: [text(value)] } : {}) });
function editorFor(content: unknown) {
  const editor = new Editor({ element: null, extensions: documentExtensions(), content: parseNote(content) });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  return editor;
}

function vueEditorFor(content: unknown, context: TestContext) {
  // Exercise the real Vue Editor's cached state without needing a browser. Its
  // reactive notifications use animation frames even with an unmounted view.
  const animationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 0; },
  });
  const editor = new VueEditor({ element: null, extensions: [...documentExtensions(), FencedCodeAuthoring], content: parseNote(content) });
  const plugins = editor.extensionManager.plugins;
  editor.registerPlugin(plugins[0]!, () => plugins);
  context.after(() => {
    editor.destroy();
    if (animationFrame) Object.defineProperty(globalThis, 'requestAnimationFrame', animationFrame);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  });
  return editor;
}

test('saved note is exactly the current Tiptap JSON, with no second document representation', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../native-rich-editor/Tests/Fixtures/tiptap.native-note', import.meta.url), 'utf8'));
  const editor = editorFor(fixture);
  const first = JSON.parse(JSON.stringify(editor.getJSON()));
  const saved = saveDocument(editor);
  assert.deepEqual(JSON.parse(saved), first);
  loadDocument(editor, JSON.parse(saved));
  assert.deepEqual(JSON.parse(JSON.stringify(editor.getJSON())), first);
  assert.deepEqual(JSON.parse(saveDocument(editor)), first);
  assert.equal('segments' in first, false);
  assert.equal('version' in first, false);
  editor.destroy();
});

test('nested lists and multiple paragraphs per item are ordinary editor content', () => {
  const editor = editorFor({ type: 'doc', content: [{ type: 'orderedList', attrs: { start: 3 }, content: [
    { type: 'listItem', content: [paragraph('First'), paragraph('More on this item'), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Nested')] }] }] },
    { type: 'listItem', content: [paragraph('Second')] },
  ] }] });
  assert.equal(editor.getText().includes('More on this item'), true);
  const saved = saveDocument(editor);
  loadDocument(editor, JSON.parse(saved));
  assert.deepEqual(JSON.parse(saveDocument(editor)), JSON.parse(saved));
  editor.destroy();
});

test('invalid imports cannot replace a note or pollute its undo scope', () => {
  const editor = editorFor({ type: 'doc', content: [paragraph('Keep me')] });
  editor.commands.setTextSelection(5);
  editor.view.dispatch(editor.state.tr.insertText(' this'));
  const before = saveDocument(editor);
  assert.throws(() => loadDocument(editor, { type: 'doc', content: [{ type: 'mystery' }] }));
  assert.equal(saveDocument(editor), before);
  loadDocument(editor, { type: 'doc', content: [paragraph('Different note')] });
  assert.equal(editor.commands.undo(), false);
  assert.equal(editor.getText(), 'Different note');
  editor.destroy();
});

test('code conversion refuses to delete an inline diagram', () => {
  const editor = editorFor({ type: 'doc', content: [{ type: 'paragraph', content: [text('Before'), { type: 'component', attrs: { component: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'diagram', title: 'D2', source: 'a -> b',
  } } }, text('After')] }] });
  editor.commands.setTextSelection(2);
  const before = saveDocument(editor);
  assert.equal(editor.commands.setCodeBlock(), false);
  assert.equal(applyBlockStyle(editor, 'code'), false);
  assert.equal(saveDocument(editor), before);
  assert.equal(applyBlockStyle(editor, 'heading2'), true);
  assert.equal(parseNote(editor.getJSON()).content[0].type, 'heading');
  editor.destroy();
});

test('block styles use standard marks and clear explicit size without losing emphasis', () => {
  const editor = editorFor({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Important', marks: [
    { type: 'bold' }, { type: 'italic' }, { type: 'textStyle', attrs: { fontSize: '32px', fontFamily: 'Helvetica Neue', color: '#336699' } },
  ] }] }] });
  editor.commands.setTextSelection(2);
  assert.equal(applyBlockStyle(editor, 'paragraph'), true);
  const node = editor.getJSON().content![0];
  assert.equal(node.type, 'paragraph');
  const marks = node.content![0].marks!;
  assert.ok(marks.some(mark => mark.type === 'bold'));
  assert.ok(marks.some(mark => mark.type === 'italic'));
  assert.deepEqual({ ...marks.find(mark => mark.type === 'textStyle')?.attrs }, { fontFamily: null, fontSize: null, color: '#336699', backgroundColor: null });
  editor.view.dispatch(editor.state.tr.insertText('New '));
  assert.equal(editor.getJSON().content![0].content![0].marks!.find(mark => mark.type === 'textStyle')?.attrs?.fontSize, null);
  assert.doesNotThrow(() => saveDocument(editor));
  editor.destroy();
});

test('draft metadata is validated with the same Zod document schema', () => {
  assert.throws(() => draftSchema.parse({ filename: 4, note: { type: 'doc', content: [paragraph('')] } }));
  assert.throws(() => draftSchema.parse({ filename: 'note.native-note', note: { version: 2, segments: [] } }));
  assert.equal(draftSchema.parse({ filename: 'note.native-note', note: { type: 'doc', content: [paragraph('Hello')] } }).note.type, 'doc');
});

test('Vue Editor keeps a new document through subsequent commands and autosave', context => {
  const editor = vueEditorFor({ type: 'doc', content: [paragraph('Previous note')] }, context);
  editor.commands.setTextSelection(1);
  editor.view.dispatch(editor.state.tr.insertText('Edited '));
  assert.equal(editor.can().undo(), true);
  editor.commands.setBold();
  const autosaves: string[] = [];
  editor.on('update', () => autosaves.push(saveDocument(editor)));

  loadDocument(editor, { type: 'doc', content: [paragraph('')] });
  assert.equal(editor.state, editor.view.state);
  assert.equal(editor.getText(), '');
  assert.equal(editor.commands.undo(), false);
  assert.equal(editor.state.storedMarks, null);
  assert.equal(autosaves.length, 0, 'caller assigns the new filename before the first save');

  // Focus and toolbar actions issue selection transactions before further input.
  editor.commands.setTextSelection(1);
  editor.view.dispatch(editor.state.tr.insertText('Only the new note'));
  assert.equal(editor.state, editor.view.state);
  assert.equal(editor.getText(), 'Only the new note');
  assert.equal(autosaves.at(-1), saveDocument(editor));
  assert.equal(saveDocument(editor).includes('Previous note'), false);
  assert.equal(editor.commands.undo(), true);
  assert.equal(editor.getText(), '');
  assert.equal(editor.commands.undo(), false, 'undo cannot cross into the previous note');
});

test('Vue Editor valid import resets history and ephemeral fenced authoring state', context => {
  const editor = vueEditorFor({ type: 'doc', content: [paragraph('```d2')] }, context);
  editor.commands.setTextSelection(6);
  editor.view.dispatch(createFenceEnterTransaction(editor.state)!);
  editor.view.dispatch(editor.state.tr.insertText('a -> b\n```'));
  assert.equal(fenceAuthoringKey.getState(editor.state)?.get(0), 3);
  const imported = saveDocument(editor);

  loadDocument(editor, JSON.parse(imported));
  assert.equal(editor.state, editor.view.state);
  assert.equal(saveDocument(editor), imported);
  assert.equal(fenceAuthoringKey.getState(editor.state)?.size, 0);
  assert.equal(editor.commands.undo(), false);
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  assert.equal(createFenceEnterTransaction(editor.state), undefined, 'imported code ending in a fence remains code');
  assert.equal(saveDocument(editor), imported);
});

test('Vue Editor invalid import preserves both state references and usable undo', context => {
  const editor = vueEditorFor({ type: 'doc', content: [paragraph('Keep me')] }, context);
  editor.commands.setTextSelection(1);
  editor.view.dispatch(editor.state.tr.insertText('Please '));
  const before = editor.state;
  const saved = saveDocument(editor);
  assert.throws(() => loadDocument(editor, { type: 'doc', content: [{ type: 'mystery' }] }));
  assert.equal(editor.state, before);
  assert.equal(editor.view.state, before);
  assert.equal(saveDocument(editor), saved);
  assert.equal(editor.commands.undo(), true);
  assert.equal(editor.getText(), 'Keep me');
  assert.equal(editor.commands.redo(), true);
  assert.equal(saveDocument(editor), saved);
});
