export type QueryViewMode = 'table' | 'list' | 'board';

export type ParsedQueryFence = {
  query: string;
  view: QueryViewMode;
  groupBy?: string;
  title?: string;
};

export type QueryFenceReplacement = ParsedQueryFence & {
  from: number;
  to: number;
};

export type QueryViewNodeAttributes = {
  query: string;
  view: QueryViewMode;
  groupBy: string | null;
  title: string | null;
  savedViewId: string | null;
};

export type QueryFenceTextBlock = {
  from: number;
  to: number;
  text: string;
  type: string;
};

type QueryFenceOpening = {
  view: QueryViewMode;
  groupBy?: string;
  title?: string;
};

export function parseQueryViewMode(value: unknown): QueryViewMode {
  return value === 'list' || value === 'board' ? value : 'table';
}

export function parseQueryFenceText(text: string): ParsedQueryFence | null {
  const lines = normalizeLines(text).split('\n');
  if (lines.length < 3) {
    return null;
  }

  const opening = parseQueryFenceOpening(lines[0]);
  if (!opening) {
    return null;
  }

  const closingIndex = lastNonEmptyLineIndex(lines);
  if (closingIndex <= 0 || lines[closingIndex].trim() !== '```') {
    return null;
  }

  const query = lines.slice(1, closingIndex).join('\n').trim();
  if (!query) {
    return null;
  }

  return { query, view: opening.view, ...queryFenceOptionalAttributes(opening) };
}

export function parseQueryCodeBlock(language: unknown, text: string): ParsedQueryFence | null {
  const opening = parseQueryFenceInfo(language);
  if (!opening) {
    return null;
  }

  const lines = normalizeLines(text).split('\n');
  const closingIndex = lastNonEmptyLineIndex(lines);
  if (closingIndex < 0 || lines[closingIndex].trim() !== '```') {
    return null;
  }

  const query = lines.slice(0, closingIndex).join('\n').trim();
  if (!query) {
    return null;
  }

  return { query, view: opening.view, ...queryFenceOptionalAttributes(opening) };
}

export function parseQueryFenceOpening(text: string): QueryFenceOpening | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return null;
  }

  return parseQueryFenceInfo(trimmed.slice(3));
}

export function findParagraphQueryFenceReplacement(
  blocks: QueryFenceTextBlock[]
): QueryFenceReplacement | null {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type !== 'paragraph') {
      continue;
    }

    const singleBlockFence = parseQueryFenceText(block.text);
    if (singleBlockFence) {
      return {
        from: block.from,
        to: block.to,
        ...singleBlockFence,
      };
    }

    const opening = parseQueryFenceOpening(block.text);
    if (!opening) {
      continue;
    }

    const queryLines: string[] = [];
    for (let closingIndex = index + 1; closingIndex < blocks.length; closingIndex += 1) {
      const nextBlock = blocks[closingIndex];
      if (nextBlock.type !== 'paragraph') {
        break;
      }

      if (nextBlock.text.trim() === '```') {
        const query = queryLines.join('\n').trim();
        if (!query) {
          break;
        }

        return {
          from: block.from,
          to: nextBlock.to,
          query,
          view: opening.view,
          ...queryFenceOptionalAttributes(opening),
        };
      }

      queryLines.push(nextBlock.text);
    }
  }

  return null;
}

export function queryFenceReplacementToNodeAttributes(
  replacement: QueryFenceReplacement
): QueryViewNodeAttributes {
  return {
    query: replacement.query,
    view: replacement.view,
    groupBy: replacement.groupBy ?? null,
    title: replacement.title ?? null,
    savedViewId: null,
  };
}

function parseQueryFenceInfo(info: unknown): QueryFenceOpening | null {
  if (typeof info !== 'string') {
    return null;
  }

  const trimmed = info.trim();
  if (!trimmed) {
    return null;
  }

  const [language = '', ...rawAttributes] = trimmed.split(/\s+/);
  if (language.toLowerCase() !== 'ql') {
    return null;
  }

  return parseQueryFenceAttributes(rawAttributes.join(' '));
}

function parseQueryFenceAttributes(attributes: string): QueryFenceOpening {
  const viewMatch = attributes.match(
    /(?:^|\s|\{)view\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s}]+))/i
  );
  const groupMatch = attributes.match(
    /(?:^|\s|\{)(?:group|groupBy)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s}]+))/i
  );
  const titleMatch = attributes.match(
    /(?:^|\s|\{)(?:title|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s}]+))/i
  );
  const groupBy = groupMatch?.[1] ?? groupMatch?.[2] ?? groupMatch?.[3];
  const title = titleMatch?.[1] ?? titleMatch?.[2] ?? titleMatch?.[3];

  return {
    view: parseQueryViewMode(viewMatch?.[1] ?? viewMatch?.[2] ?? viewMatch?.[3]),
    ...(groupBy ? { groupBy: groupBy.trim() } : {}),
    ...(title ? { title: title.trim() } : {}),
  };
}

function queryFenceOptionalAttributes(opening: QueryFenceOpening) {
  return {
    ...(opening.groupBy ? { groupBy: opening.groupBy } : {}),
    ...(opening.title ? { title: opening.title } : {}),
  };
}

function normalizeLines(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function lastNonEmptyLineIndex(lines: string[]) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim().length > 0) {
      return index;
    }
  }

  return -1;
}
