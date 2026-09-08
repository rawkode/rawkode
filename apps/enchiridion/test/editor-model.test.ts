import { test, expect } from 'bun:test';
import { getSchema } from '../website/node_modules/@tiptap/core';
import { EditorState } from '../website/node_modules/@tiptap/pm/state';
import { LoroDoc } from '../website/node_modules/loro-crdt';
import { updateLoroToPmState, type LoroDocType } from '../website/node_modules/loro-prosemirror';
import { editorExtensions } from '../website/src/editor/schema';
import { preflightSnapshot } from '../website/src/editor/validation';
import { ExtensionRegistry } from '../website/src/editor/extensions/registry';
import { todayConfiguration } from '../website/src/today/slots';

test('unknown versioned blocks round-trip losslessly through the Loro document model', () => {
  const schema = getSchema(editorExtensions({ onDiagramEdit() {} }));
  const doc = new LoroDoc();
  try {
    const content = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'diagram', attrs: { id: 'test-id', kind: 'future.canvas', version: 7, source: '{"keep":"everything"}' } }, { type: 'paragraph', content: [{ type: 'text', text: 'Still editable prose' }] }] });
    for (const [key, value] of Object.entries({ schemaVersion: 4, day: '2026-09-09', binding: 'loro-prosemirror', bindingVersion: '0.4.4', editorSchema: 1 })) doc.getMap('metadata').set(key, value);
    updateLoroToPmState(doc as LoroDocType, new Map(), EditorState.create({ schema, doc: content })); doc.commit();
    expect(preflightSnapshot(doc, '2026-09-09', schema).toJSON()).toEqual(content.toJSON());
    expect(() => preflightSnapshot(doc, '2026-09-10', schema)).toThrow('different editor');
  } finally { doc.free(); }
});
test('extension registration is replaceable and slot defaults reject accidental loss of the document', () => {
  const registry = new ExtensionRegistry();
  const definition = { id: 'custom', version: 1, label: 'Custom', description: '', initialSource: '', validate() {}, async load() { return { async mount() { return { async read() { return { source: '' }; }, destroy() {} }; } }; } };
  const unregister = registry.register(definition); expect(registry.get('custom')).toBe(definition);
  expect(() => registry.register(definition)).toThrow('already registered'); unregister(); expect(registry.get('custom')).toBeUndefined();
  registry.register({ ...definition, version: 2 }); expect(registry.get('custom', 2)?.version).toBe(2);
  expect(todayConfiguration().main).toEqual(['document']);
  expect(todayConfiguration({ context: ['people', 'agenda'] }).context).toEqual(['people', 'agenda']);
  expect(() => todayConfiguration({ main: [], context: [] })).toThrow('Invalid Today layout');
});
