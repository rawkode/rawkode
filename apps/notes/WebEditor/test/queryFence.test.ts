import { describe, expect, test } from 'bun:test';
import { Schema } from '@tiptap/pm/model';
import {
  findParagraphQueryFenceReplacement,
  parseQueryCodeBlock,
  parseQueryFenceOpening,
  parseQueryFenceText,
  parseQueryViewMode,
  queryFenceReplacementToNodeAttributes,
} from '../src/queryFence';

describe('query fence parsing', () => {
  test('parses a ql fence with an explicit board view', () => {
    expect(
      parseQueryFenceText(`\`\`\`ql view=board
SELECT * FROM bookmarks
\`\`\``)
    ).toEqual({
      query: 'SELECT * FROM bookmarks',
      view: 'board',
    });
  });

  test('defaults ql fences to the table view', () => {
    expect(
      parseQueryFenceText(`\`\`\`ql
SELECT name FROM projects
\`\`\``)
    ).toEqual({
      query: 'SELECT name FROM projects',
      view: 'table',
    });
  });

  test('accepts quoted and braced view attributes', () => {
    expect(parseQueryFenceOpening('```ql view="list"')?.view).toBe('list');
    expect(parseQueryFenceOpening('```ql {view=board}')?.view).toBe('board');
  });

  test('parses query board grouping attributes', () => {
    expect(
      parseQueryFenceText(`\`\`\`ql view=board group=status
SELECT * FROM projects
\`\`\``)
    ).toEqual({
      query: 'SELECT * FROM projects',
      view: 'board',
      groupBy: 'status',
    });

    expect(parseQueryFenceOpening('```ql view=board groupBy="lane"')?.groupBy).toBe('lane');
  });

  test('parses query titles from title or name attributes', () => {
    expect(
      parseQueryFenceText(`\`\`\`ql view=board group=status title="Active Bookmarks"
SELECT * FROM bookmarks
\`\`\``)
    ).toEqual({
      query: 'SELECT * FROM bookmarks',
      view: 'board',
      groupBy: 'status',
      title: 'Active Bookmarks',
    });

    expect(parseQueryFenceOpening("```ql name='Weekly Planning'")?.title).toBe('Weekly Planning');
  });

  test('ignores incomplete or non-query fences', () => {
    expect(parseQueryFenceText('```ts\nconst value = 1;\n```')).toBeNull();
    expect(parseQueryFenceText('```ql\nSELECT * FROM bookmarks')).toBeNull();
    expect(parseQueryFenceText('```ql\n```')).toBeNull();
  });

  test('parses completed ql code blocks', () => {
    expect(parseQueryCodeBlock('ql view=board', 'SELECT * FROM bookmarks\n```')).toEqual({
      query: 'SELECT * FROM bookmarks',
      view: 'board',
    });
  });

  test('normalizes unknown query view modes', () => {
    expect(parseQueryViewMode('kanban')).toBe('table');
  });

  test('uses ProseMirror top-level paragraph positions for pasted fences', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'text*', group: 'block' },
        text: { group: 'inline' },
      },
    });
    const document = schema.node('doc', null, [
      schema.node('paragraph', null, schema.text('```ql view=board group=status')),
      schema.node('paragraph', null, schema.text('SELECT * FROM bookmarks')),
      schema.node('paragraph', null, schema.text('```')),
    ]);
    const blocks: Array<{ from: number; to: number; text: string; type: string }> = [];

    document.forEach((node, offset) => {
      blocks.push({
        from: offset,
        to: offset + node.nodeSize,
        text: node.textContent,
        type: node.type.name,
      });
    });

    expect(blocks[0].from).toBe(0);
    expect(findParagraphQueryFenceReplacement(blocks)).toEqual({
      from: 0,
      to: document.content.size,
      query: 'SELECT * FROM bookmarks',
      view: 'board',
      groupBy: 'status',
    });
  });

  test('preserves parsed group attrs when building query view node attrs', () => {
    expect(
      queryFenceReplacementToNodeAttributes({
        from: 0,
        to: 42,
        query: 'SELECT * FROM projects',
        view: 'board',
        groupBy: 'status',
        title: 'Project Board',
      })
    ).toEqual({
      query: 'SELECT * FROM projects',
      view: 'board',
      groupBy: 'status',
      title: 'Project Board',
    });

    expect(
      queryFenceReplacementToNodeAttributes({
        from: 0,
        to: 42,
        query: 'SELECT * FROM projects',
        view: 'table',
      })
    ).toEqual({
      query: 'SELECT * FROM projects',
      view: 'table',
      groupBy: null,
      title: null,
    });
  });
});
