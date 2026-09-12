import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { history, undo, redo } from '@tiptap/pm/history'
import { defaultComponent, playback, webURL } from '../src/lib/component'
import { parseNote } from '../src/lib/note'
import { documentExtensions } from '../src/editor/extensions'
import { createFenceEnterTransaction, createFencedCodePlugin, createFencedPasteTransaction, fenceAuthoringKey, fencedTextNodes, FencedCodeAuthoring, parseCompletedFences } from '../src/editor/fencedCode'

const schema = getSchema([...documentExtensions(), FencedCodeAuthoring])
function stateWith(doc: ReturnType<typeof schema.node>, caret = doc.content.size - 1) {
  return EditorState.create({ schema, doc, selection: TextSelection.create(doc, caret), plugins: [history(), createFencedCodePlugin()] })
}
function plainState(text = '', caret = text.length + 1) {
  return stateWith(schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(null, text ? schema.text(text) : undefined)), caret)
}
function applyPaste(text: string, state = plainState()) {
  const transaction = createFencedPasteTransaction(state, text)
  assert.ok(transaction)
  transaction.doc.check()
  parseNote(transaction.doc.toJSON())
  return state.apply(transaction)
}
function openFence(language = 'd2', length = 3) {
  const state = plainState(`${'`'.repeat(length)}${language}`)
  return state.apply(createFenceEnterTransaction(state)!)
}
function blocks(state: EditorState) {
  const result: { type: string; text: string; attrs: Record<string, unknown> }[] = []
  state.doc.forEach(node => result.push({ type: node.type.name, text: node.textContent, attrs: { ...node.attrs } }))
  return result
}

test('parser retains exact UTF-16 source, language info, indentation and CRLF', () => {
  const input = 'Before 👩🏽‍💻\r\n  ````C++ custom-info\r\n  α\tβ\r\n```\r\n\r\n  `````  \r\nAfter'
  assert.deepEqual(parseCompletedFences(input), [{
    from: input.indexOf('  ````'), to: input.indexOf('\r\nAfter'), language: 'C++ custom-info',
    source: '  α\tβ\r\n```\r\n', fenceLength: 4,
  }])
  for (const text of ['```d2\na -> b', '```', 'inline ```d2\na -> b\n```', '    ```d2\na -> b\n    ```', '```we`ird\nx\n```']) assert.deepEqual(parseCompletedFences(text), [])
})

test('plain paste builds direct Tiptap diagrams and arbitrary code with surrounding prose', () => {
  const input = 'Before\n```d2\na -> b\n```\nBetween\n```mermaid\nflowchart LR\n  A --> B\n```\n```C++\nint x = 1;\n```\n```\nplain code\n```\nAfter'
  const state = applyPaste(input)
  assert.deepEqual(blocks(state).map(node => node.type), ['paragraph', 'paragraph', 'paragraph', 'paragraph', 'codeBlock', 'codeBlock', 'paragraph'])
  const d2 = state.doc.child(1).firstChild!, mermaid = state.doc.child(3).firstChild!
  assert.equal(d2.type.name, 'component')
  assert.equal(d2.attrs.component.kind, 'diagram')
  assert.equal(d2.attrs.component.source, 'a -> b')
  assert.equal(mermaid.attrs.component.kind, 'mermaid')
  assert.equal(mermaid.attrs.component.source, 'flowchart LR\n  A --> B')
  assert.notEqual(d2.attrs.component.id, mermaid.attrs.component.id)
  assert.deepEqual([state.doc.child(0).textContent, state.doc.child(2).textContent, state.doc.child(6).textContent], ['Before', 'Between', 'After'])
  assert.deepEqual(blocks(state).filter(node => node.type === 'codeBlock'), [
    { type: 'codeBlock', attrs: { language: 'C++' }, text: 'int x = 1;' },
    { type: 'codeBlock', attrs: { language: '' }, text: 'plain code' },
  ])
})

test('paste joins prose edges without merging code into or deleting existing text', () => {
  const result = applyPaste('intro\n```swift\nlet a = 1\n```\nend', plainState('beforeafter', 7))
  assert.deepEqual(blocks(result).map(node => [node.type, node.text]), [['paragraph', 'beforeintro'], ['codeBlock', 'let a = 1'], ['paragraph', 'endafter']])
})

test('source CRLF and blank lines survive; empty fences and unclosed remainder stay editable', () => {
  const input = 'start\r\n```shell\r\nprintf "hi"\r\n\r\n```\r\n```\r\n```\r\n```d2\r\nnot closed'
  const state = applyPaste(input)
  const code = blocks(state).filter(node => node.type === 'codeBlock')
  assert.deepEqual(code.map(node => node.text), ['printf "hi"\r\n', ''])
  assert.deepEqual(blocks(state).slice(-2).map(node => node.text), ['```d2', 'not closed'])
  assert.equal(createFencedPasteTransaction(plainState(), '```d2\na -> b'), undefined)
  assert.equal(fencedTextNodes(schema, 'plain prose'), undefined)
})

test('paste is one undoable transaction; redo restores stable component IDs', () => {
  const before = plainState('kept', 5)
  let state = applyPaste('\n```d2\na -> b\n```\n', before)
  const after = state.doc.toJSON()
  assert.ok(undo(state, transaction => { state = state.apply(transaction) }))
  assert.deepEqual(state.doc.toJSON(), before.doc.toJSON())
  assert.ok(redo(state, transaction => { state = state.apply(transaction) }))
  assert.deepEqual(state.doc.toJSON(), after)
})

test('existing code and inline code cannot consume pasted fence syntax', () => {
  const codeDoc = schema.nodes.doc!.create(null, schema.nodes.codeBlock!.create({ language: 'text' }, schema.text('existing')))
  assert.equal(createFencedPasteTransaction(stateWith(codeDoc), '```d2\na -> b\n```'), undefined)
  const markedDoc = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(null, schema.text('code', [schema.marks.code!.create()])))
  assert.equal(createFencedPasteTransaction(stateWith(markedDoc), '```d2\na -> b\n```'), undefined)
})

test('typed ownership is transient and a completed D2 fence converts only on Enter', () => {
  let state = openFence()
  assert.deepEqual({ ...state.doc.firstChild!.attrs }, { language: 'd2' })
  assert.equal(fenceAuthoringKey.getState(state)?.get(0), 3)
  assert.ok(!JSON.stringify(state.doc.toJSON()).includes('fenceAuthoring'))
  parseNote(state.doc.toJSON())
  state = state.apply(state.tr.insertText('a -> b\n```'))
  assert.equal(state.doc.firstChild!.type.name, 'codeBlock')
  state = state.apply(createFenceEnterTransaction(state)!)
  assert.equal(state.doc.firstChild!.firstChild!.attrs.component.source, 'a -> b')
  assert.equal(state.selection.$from.parent.type.name, 'paragraph')
  assert.equal(state.selection.$from.parentOffset, 0)
  assert.equal(fenceAuthoringKey.getState(state)?.size, 0)
})

test('undo closing restores ownership and permits closing again; redo keeps it closed', () => {
  let state = openFence()
  state = state.apply(state.tr.insertText('a -> b\n```'))
  const original = state.doc.toJSON()
  state = state.apply(createFenceEnterTransaction(state)!)
  assert.ok(undo(state, transaction => { state = state.apply(transaction) }))
  assert.deepEqual(state.doc.toJSON(), original)
  assert.equal(fenceAuthoringKey.getState(state)?.get(0), 3)
  assert.ok(createFenceEnterTransaction(state))
  assert.ok(redo(state, transaction => { state = state.apply(transaction) }))
  assert.equal(fenceAuthoringKey.getState(state)?.size, 0)
  assert.equal(state.doc.firstChild!.firstChild!.type.name, 'component')
})

test('ownership follows mapped positions without leaking to replacement code', () => {
  let state = openFence()
  state = state.apply(state.tr.insertText('a -> b\n```'))
  const prefix = schema.nodes.paragraph!.create(null, schema.text('before'))
  state = state.apply(state.tr.insert(0, prefix))
  assert.equal(fenceAuthoringKey.getState(state)?.get(prefix.nodeSize), 3)
  assert.ok(createFenceEnterTransaction(state))
  const replacement = schema.nodes.codeBlock!.create({ language: 'd2' }, schema.text('unowned\n```'))
  state = state.apply(state.tr.replaceWith(prefix.nodeSize, state.doc.content.size, replacement))
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)))
  assert.equal(fenceAuthoringKey.getState(state)?.size, 0)
  assert.equal(createFenceEnterTransaction(state), undefined)
})

test('export/reload does not carry authoring ownership or mutate literal closing fences', () => {
  let state = openFence()
  state = state.apply(state.tr.insertText('a -> b\n```'))
  const reloaded = stateWith(schema.nodeFromJSON(state.doc.toJSON()))
  assert.equal(fenceAuthoringKey.getState(reloaded)?.size, 0)
  assert.equal(createFenceEnterTransaction(reloaded), undefined)
  assert.equal(reloaded.doc.firstChild!.textContent, 'a -> b\n```')
})

test('Mermaid and arbitrary code retain source, and shorter fences remain source literals', () => {
  for (const [language, kind] of [['mermaid', 'component'], ['bash', 'codeBlock'], ['unknown-language+1', 'codeBlock'], ['', 'codeBlock']]) {
    let state = openFence(language, 4)
    state = state.apply(state.tr.insertText('source\n```'))
    assert.equal(createFenceEnterTransaction(state), undefined)
    state = state.apply(state.tr.insertText('\n`````'))
    state = state.apply(createFenceEnterTransaction(state)!)
    const node = state.doc.firstChild!
    assert.equal(kind === 'component' ? node.firstChild!.type.name : node.type.name, kind)
    assert.equal(kind === 'component' ? node.firstChild!.attrs.component.source : node.textContent, 'source\n```')
    if (kind === 'codeBlock') assert.equal(node.attrs.language, language)
  }
})

test('component and inline-code paragraphs never become authored fences', () => {
  const component = schema.nodes.component!.create({ component: defaultComponent('diagram') })
  const doc = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(null, [component, schema.text('```d2')]))
  assert.equal(createFenceEnterTransaction(stateWith(doc)), undefined)
  const marked = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(null, schema.text('```d2', [schema.marks.code!.create()])))
  assert.equal(createFenceEnterTransaction(stateWith(marked)), undefined)
})

test('selection or a caret before the authored end never closes the code', () => {
  let state = openFence()
  state = state.apply(state.tr.insertText('source\n```'))
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)))
  assert.equal(createFenceEnterTransaction(state), undefined)
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)))
  assert.equal(createFenceEnterTransaction(state), undefined)
})

test('component playback consumes the canonical discriminated union without URL rewriting', () => {
  const url = 'https://media.example.com/watch?token=a%2Fb'
  assert.deepEqual(playback({ title: 'Video', playback: { type: 'directVideo', url } }), { kind: 'video', url })
  assert.deepEqual(playback({ title: 'Player', playback: { type: 'embedURL', url } }), { kind: 'embed', url })
  assert.equal(webURL('https://user:password@example.com'), undefined)
  assert.equal(webURL('javascript:alert(1)'), undefined)
})
