import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor, getSchema, type JSONContent } from '@tiptap/core';
import { DOMParser } from '@tiptap/pm/model';
import { documentExtensions } from '../src/editor/extensions';
import { saveDocument } from '../src/editor/persistence';
import { parseNote } from '../src/lib/note';

function pastedDocument(html: string): JSONContent {
  const dom = new JSDOM(`<body>${html}</body>`);
  let editor: Editor | undefined;
  try {
    const content = DOMParser.fromSchema(getSchema(documentExtensions())).parse(dom.window.document.body).toJSON();
    editor = new Editor({ element: null, extensions: documentExtensions(), content });
    // Include the editor's own defaults, not just the DOM parser's intermediate JSON.
    return JSON.parse(saveDocument(editor));
  } finally {
    editor?.destroy();
    dom.window.close();
  }
}

function firstText(note: JSONContent): JSONContent {
  if (note.type === 'text') return note;
  for (const child of note.content ?? []) {
    const found = firstText(child);
    if (found.type === 'text') return found;
  }
  return {};
}

test('a styled HTML span does not turn missing style properties into unsavable empty strings', () => {
  const text = firstText(pastedDocument('<p><span style="color: #336699">Pasted text</span></p>'));
  assert.equal(text.text, 'Pasted text');
  assert.deepEqual(text.marks?.find(mark => mark.type === 'textStyle')?.attrs, {
    fontFamily: null, fontSize: null, color: '#336699', backgroundColor: null,
  });
});

test('unsupported clipboard CSS is dropped without dropping text or supported marks', () => {
  const text = firstText(pastedDocument('<p><strong><em><span style="font-size:1.25em;color:tomato;background-color:var(--page)">Keep this</span></em></strong></p>'));
  assert.equal(text.text, 'Keep this');
  assert.ok(text.marks?.some(mark => mark.type === 'bold'));
  assert.ok(text.marks?.some(mark => mark.type === 'italic'));
  assert.deepEqual(text.marks?.find(mark => mark.type === 'textStyle')?.attrs, {
    fontFamily: null, fontSize: null, color: null, backgroundColor: null,
  });
});

test('supported style values and combined rich text marks survive actual DOM parsing', () => {
  const text = firstText(pastedDocument('<p><strong><em><u><s><code><span style="font-family:Helvetica Neue;font-size:18px;color:rgba(10, 20, 30, 0.5);background-color:#fff">Styled code</span></code></s></u></em></strong></p>'));
  assert.equal(text.text, 'Styled code');
  for (const type of ['bold', 'italic', 'underline', 'strike', 'code']) assert.ok(text.marks?.some(mark => mark.type === type), type);
  assert.deepEqual(text.marks?.find(mark => mark.type === 'textStyle')?.attrs, {
    fontFamily: 'Helvetica Neue', fontSize: '18px', color: 'rgba(10, 20, 30, 0.5)', backgroundColor: '#fff',
  });
});

test('nested spans keep inherited supported formatting and their own overrides', () => {
  const note = pastedDocument('<p><span style="font-size:18px;color:#336699">Outer <strong><span style="background-color:#fff">Inner</span></strong></span></p>');
  const inner = note.content![0]!.content!.find(node => node.text === 'Inner')!;
  assert.ok(inner.marks?.some(mark => mark.type === 'bold'));
  assert.deepEqual(inner.marks?.find(mark => mark.type === 'textStyle')?.attrs, {
    fontFamily: null, fontSize: '18px', color: '#336699', backgroundColor: '#fff',
  });
});

test('HTML lists keep valid numeric starts and normalize unsupported styles and malformed starts', () => {
  for (const [attributes, start, type] of [
    ['', 1, null], ['start="4" type="1"', 4, '1'], ['start="0"', 1, null],
    ['start="-4"', 1, null], ['start="nope"', 1, null], ['start="1000001"', 1, null],
    ['start="3" type="A"', 3, null], ['style="list-style-type:lower-roman"', 1, null],
  ] as const) {
    const list = pastedDocument(`<ol ${attributes}><li><p>First</p><p>More detail</p></li><li>Second</li></ol>`).content![0]!;
    assert.equal(list.type, 'orderedList');
    assert.deepEqual(list.attrs, { start, type }, attributes);
    assert.equal(list.content![0]!.content!.length, 2);
    assert.equal(firstText(list).text, 'First');
  }
});

test('HTML links preserve safe URLs, titles, and supported link attributes', () => {
  const text = firstText(pastedDocument('<p><a href="https://example.test/watch?signature=a%2Fb&amp;range=1" target="_self" rel="ugc nofollow" class="reference-link" title="Watch this">Watch</a></p>'));
  assert.equal(text.text, 'Watch');
  assert.deepEqual(text.marks?.find(mark => mark.type === 'link')?.attrs, {
    href: 'https://example.test/watch?signature=a%2Fb&range=1', target: '_self', rel: 'ugc nofollow', class: 'reference-link', title: 'Watch this',
  });
  const defaultLink = firstText(pastedDocument('<p><a href="mailto:person@example.test">Email</a></p>')).marks?.find(mark => mark.type === 'link');
  assert.equal(defaultLink?.attrs?.href, 'mailto:person@example.test');
  assert.equal(defaultLink?.attrs?.target, '_blank');
  assert.equal(defaultLink?.attrs?.title, null);
});

test('unsupported HTML link presentation attributes fall back to safe editor defaults', () => {
  const text = firstText(pastedDocument(`<p><a href="https://example.test" target="_parent" rel="external bookmark" class="unsupported:class" title="${'x'.repeat(10_001)}">Link text</a></p>`));
  assert.equal(text.text, 'Link text');
  assert.deepEqual(text.marks?.find(mark => mark.type === 'link')?.attrs, {
    href: 'https://example.test', target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: null,
  });
});

test('unsafe or unsupported HTML links become plain text rather than unsavable URLs', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,bad', 'file:///private/note', 'ftp://example.test/file', '/relative', 'https://name:secret@example.test']) {
    const text = firstText(pastedDocument(`<p><strong><a href="${href}">Keep label</a></strong></p>`));
    assert.equal(text.text, 'Keep label');
    assert.ok(text.marks?.some(mark => mark.type === 'bold'));
    assert.equal(text.marks?.some(mark => mark.type === 'link'), false, href);
  }
});

test('unsupported saved-file attributes still reject instead of being silently normalized', () => {
  const marked = (attrs: Record<string, unknown>) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'File text', marks: [{ type: 'textStyle', attrs }] }] }] });
  for (const attrs of [{ fontFamily: '' }, { fontSize: '1.25em' }, { color: 'tomato' }, { backgroundColor: '' }]) assert.throws(() => parseNote(marked(attrs)));
  assert.throws(() => parseNote({ type: 'doc', content: [{ type: 'orderedList', attrs: { start: 0, type: 'A' }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] }));
  assert.throws(() => parseNote({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'File link', marks: [{ type: 'link', attrs: { href: 'https://example.test', target: '_parent' } }] }] }] }));
});
