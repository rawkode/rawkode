import { LoroDoc, LoroMap, LoroMovableList, LoroText } from 'loro-crdt';
import type { JSONContent } from '@tiptap/core';
import { exactKeys, record, safeLink, unsupported } from './validation';
import { validateDiagram } from './schema';

type Mark = { type: string; attrs?: Record<string, unknown> };
function fontMarks(value: unknown, depth = 0): Mark[] {
  if (!record(value) || depth > 8) unsupported('Unsupported legacy font.');
  exactKeys(value, ['tag', 'value']);
  const tag = value.tag;
  const content = value.value;
  if (!record(tag) || !record(content)) unsupported('Unsupported legacy font.');
  if ('staticModifier' in tag) {
    const modifier = tag.staticModifier;
    if (!record(modifier) || !record(modifier._0) || !record(modifier._0.do) || !record(modifier._0.do._0)) unsupported('Unsupported legacy font modifier.');
    exactKeys(tag, ['staticModifier']);
    exactKeys(modifier, ['_0']);
    exactKeys(modifier._0, ['do']);
    exactKeys(modifier._0.do, ['_0']);
    const names = Object.keys(modifier._0.do._0);
    const name = names[0];
    if (names.length !== 1 || !['bold', 'italic'].includes(name) ||
        !record(modifier._0.do._0[name]) || Object.keys(modifier._0.do._0[name]).length) unsupported('Unsupported legacy font modifier.');
    return [...fontMarks(content, depth + 1), { type: name }];
  }
  const empty = (input: unknown) => record(input) && Object.keys(input).length === 0;
  if ('system' in tag) {
    exactKeys(tag, ['system']);
    exactKeys(content, ['design', 'size', 'weight']);
    if (!empty(tag.system) || content.size !== 17 || !empty(content.design) || !empty(content.weight)) unsupported('Unsupported legacy system font.');
  } else {
    exactKeys(tag, ['style']);
    exactKeys(content, ['design', 'style', 'weight']);
    if (!empty(tag.style) || !record(content.style) || !empty(content.style.body) ||
        Object.keys(content.style).length !== 1 || !empty(content.design) || !empty(content.weight)) unsupported('Unsupported legacy text style.');
  }
  return [];
}
function marksFromLegacy(values: Record<string, unknown>): Mark[] {
  const marks: Mark[] = [];
  for (const [key, encoded] of Object.entries(values)) {
    if (typeof encoded !== 'string') unsupported('Unsupported legacy text attribute.');
    const value: unknown = JSON.parse(encoded);
    if (key === 'font') marks.push(...fontMarks(value));
    else if (key === 'underline' || key === 'strikethrough') {
      if (!record(value)) unsupported('Unsupported legacy line style.');
      exactKeys(value, ['style']);
      if (value.style !== 1) unsupported('Unsupported legacy line style.');
      marks.push({ type: key === 'underline' ? 'underline' : 'strike' });
    } else if (key === 'link') {
      if (!record(value)) unsupported('Unsupported legacy link.');
      exactKeys(value, ['relative']);
      if (!safeLink(value.relative)) unsupported('Unsupported legacy link URL.');
      marks.push({ type: 'link', attrs: { href: value.relative } });
    } else unsupported(`Unsupported legacy text attribute: ${key}.`);
  }
  return marks.filter((mark, index) => marks.findIndex(other => other.type === mark.type) === index);
}
function plainParagraph(text: string): JSONContent {
  return { type: 'paragraph', content: text.split('\n').flatMap((line, index) => [
    ...(index ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : []),
  ]) };
}
interface LegacyBlock { id: string; kind: string; text: string; indent: number; checked: boolean }
const listTypes: Record<string, string> = { bullet: 'bulletList', numbered: 'orderedList', checklist: 'taskList' };

/** Project only explicitly supported v1/v2 fields into a fresh v3 document. */
export function projectLegacy(snapshot: Uint8Array, day: string): JSONContent {
  const old = new LoroDoc();
  try {
    old.import(snapshot);
    const roots = old.getShallowValue();
    if (roots.metadata !== 'cid:root-metadata:Map' || roots.body !== 'cid:root-body:Text') unsupported('Unsupported legacy roots.');
    const metadata = old.getMap('metadata').toJSON();
    exactKeys(metadata, ['schemaVersion', 'day']);
    if ((metadata.schemaVersion !== 1 && metadata.schemaVersion !== 2) || metadata.day !== day) unsupported('Unsupported legacy note version or date.');
    exactKeys(roots, metadata.schemaVersion === 1 ? ['metadata', 'body'] : ['metadata', 'body', 'components']);
    const content: JSONContent[] = [];
    let paragraph: JSONContent = { type: 'paragraph', content: [] };
    const body = old.getText('body');
    for (const delta of body.toDelta()) {
      if (typeof delta.insert !== 'string') unsupported('Unsupported legacy body.');
      const marks = marksFromLegacy(delta.attributes ?? {});
      const lines = delta.insert.split('\n');
      lines.forEach((line, index) => {
        if (index) { content.push(paragraph); paragraph = { type: 'paragraph', content: [] }; }
        if (line) paragraph.content!.push({ type: 'text', text: line, marks });
      });
    }
    if (body.length > 0) content.push(paragraph);
    if (metadata.schemaVersion === 2) {
      if (roots.components !== 'cid:root-components:MovableList') unsupported('Unsupported legacy component list.');
      const list = old.getMovableList('components');
      if (!(list instanceof LoroMovableList) || list.length > 10_000) unsupported('Unsupported legacy components.');
      const ids = new Set<string>();
      const blocks: LegacyBlock[] = list.toArray().map(value => {
        if (!(value instanceof LoroMap)) unsupported('Unsupported legacy component.');
        exactKeys(value.getShallowValue(), ['id', 'kind', 'version', 'checked', 'indent', 'text']);
        const { id, kind, version, checked, indent } = value.toJSON();
        const text = value.get('text');
        if (typeof id !== 'string' || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) || ids.has(id) ||
            typeof kind !== 'string' || !['paragraph', 'bullet', 'numbered', 'checklist', 'excalidraw', 'd2'].includes(kind) ||
            version !== 1 || typeof checked !== 'boolean' || !Number.isInteger(indent) || Number(indent) < 0 || Number(indent) > 8 ||
            !(text instanceof LoroText)) unsupported('Unsupported legacy component fields.');
        if ((!listTypes[kind] && indent !== 0) || (kind !== 'checklist' && checked)) unsupported('Unsupported legacy component state.');
        ids.add(id);
        for (const delta of text.toDelta()) if (typeof delta.insert !== 'string' || Object.keys(delta.attributes ?? {}).length) unsupported('Unsupported legacy component formatting.');
        const source = text.toString();
        if (kind === 'excalidraw' || kind === 'd2') validateDiagram(kind, source, id);
        else if (new TextEncoder().encode(source).length > 1_048_576) unsupported('Legacy paragraph exceeds the supported size.');
        return { id, kind, text: source, indent: Number(indent), checked };
      });
      let index = 0;
      const readList = (depth: number): JSONContent => {
        const kind = blocks[index].kind;
        const items: JSONContent[] = [];
        while (index < blocks.length && blocks[index].kind === kind && blocks[index].indent === depth) {
          const block = blocks[index++];
          const item: JSONContent = {
            type: kind === 'checklist' ? 'taskItem' : 'listItem',
            ...(kind === 'checklist' ? { attrs: { checked: block.checked } } : {}),
            content: [plainParagraph(block.text)],
          };
          while (index < blocks.length && listTypes[blocks[index].kind] && blocks[index].indent > depth) {
            if (blocks[index].indent !== depth + 1) unsupported('Legacy list indentation cannot be migrated safely.');
            item.content!.push(readList(depth + 1));
          }
          items.push(item);
        }
        return { type: listTypes[kind], content: items };
      };
      while (index < blocks.length) {
        const block = blocks[index];
        if (listTypes[block.kind]) {
          if (block.indent !== 0) unsupported('Legacy list has no parent for its indentation.');
          content.push(readList(0));
        } else {
          index++;
          content.push(block.kind === 'paragraph' ? plainParagraph(block.text) : {
            type: 'diagram', attrs: { id: block.id, kind: block.kind, source: block.text },
          });
        }
      }
    }
    return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
  } finally { old.free(); }
}
