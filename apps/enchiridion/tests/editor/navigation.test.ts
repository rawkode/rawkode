/// <reference types="node" />
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDailyEditor } from '../../src/editor';

const wait = () => new Promise(resolve => setTimeout(resolve, 15));
describe('daily editor replacement', () => {
  it('preserves a snapshot through repeated editable toggles, destruction, and host reuse', async () => {
    const host = document.createElement('div'); document.body.append(host);
    let saved: Uint8Array | null = null;
    const options = { element: host, day: '2026-09-10', onChange: (bytes: Uint8Array) => { saved = bytes; }, onDiagramEdit: () => {} };
    let editor = createDailyEditor(options);
    await editor.ready;
    editor.editor.commands.insertContent('A note that must remain 🦀');
    editor.editor.setEditable(false, false);
    await Promise.resolve();
    expect(saved).not.toBeNull();
    const original = editor.editor.getJSON();
    editor.destroy(); host.replaceChildren();
    for (let count = 0; count < 20; count++) {
      const blank = createDailyEditor({ ...options, day: '2026-09-11', onChange: () => { throw new Error('Blank bootstrap saved'); } });
      await blank.ready;
      blank.editor.setEditable(true, false);
      expect(blank.editor.getText()).toBe('');
      blank.destroy(); host.replaceChildren();
      editor = createDailyEditor({ ...options, snapshot: saved, onChange: () => { throw new Error('Reopen saved'); } });
      await editor.ready;
      editor.editor.setEditable(true, false);
      expect(editor.editor.getJSON()).toEqual(original);
      await wait();
      expect(editor.editor.getJSON()).toEqual(original);
      editor.destroy(); host.replaceChildren();
    }
    host.remove();
  });

  it('keeps an observed DOM edit when navigation immediately freezes the view', async () => {
    const host = document.createElement('div'); document.body.append(host);
    let saved: Uint8Array | null = null;
    const editor = createDailyEditor({ element: host, day: '2026-09-10', onChange: bytes => { saved = bytes; }, onDiagramEdit: () => {} });
    await editor.ready;
    editor.editor.commands.insertContent('before');
    await wait();
    const text = editor.editor.view.dom.querySelector('p')!.firstChild!;
    text.textContent = 'before plus final DOM input';
    editor.editor.view.dom.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' plus final DOM input' }));
    editor.prepareForTransition();
    await Promise.resolve();
    await wait();
    expect(editor.editor.getText()).toBe('before plus final DOM input');
    expect(saved).not.toBeNull();
    const current = editor.editor.getJSON();
    editor.destroy(); host.replaceChildren();
    const reopened = createDailyEditor({ element: host, day: '2026-09-10', snapshot: saved, onChange: () => {}, onDiagramEdit: () => {} });
    await reopened.ready;
    expect(reopened.editor.getJSON()).toEqual(current);
    reopened.destroy(); host.remove();
  });

  it('refuses to cut off an active input-method composition', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const editor = createDailyEditor({ element: host, day: '2026-09-10', onChange: () => {}, onDiagramEdit: () => {} });
    await editor.ready;
    editor.editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    expect(editor.editor.view.composing).toBe(true);
    expect(() => editor.prepareForTransition()).toThrow(/composition/);
    expect(editor.editor.isEditable).toBe(true);
    editor.editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    await wait();
    editor.destroy(); host.remove();
  });

  it.skipIf(!process.env.EDITOR_READONLY_SNAPSHOT)('opens supplied real snapshot without mutation or delayed blanking', async () => {
    const bytes = new Uint8Array(readFileSync(process.env.EDITOR_READONLY_SNAPSHOT!));
    const host = document.createElement('div'); document.body.append(host);
    const editor = createDailyEditor({ element: host, day: process.env.EDITOR_READONLY_DAY!, snapshot: bytes,
      onChange: () => { throw new Error('Imported document triggered a save'); }, onDiagramEdit: () => {} });
    try {
      const before = editor.editor.getJSON();
      await editor.ready;
      editor.editor.setEditable(true, false);
      await wait();
      expect(editor.editor.getJSON()).toEqual(before);
      expect(editor.editor.state.doc.content.size).toBeGreaterThan(2);
      console.log('READONLY SNAPSHOT', editor.editor.state.doc.childCount, 'blocks', editor.editor.state.doc.content.size, 'document units');
    } finally { editor.destroy(); host.remove(); }
  });
});
