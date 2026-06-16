export type QueryViewMode = 'table' | 'list' | 'board';

export type ParsedQueryFence = {
  query: string;
  view: QueryViewMode;
};

export type QueryFenceReplacement = ParsedQueryFence & {
  from: number;
  to: number;
};

export type QueryFenceTextBlock = {
  from: number;
  to: number;
  text: string;
  type: string;
};

type QueryFenceOpening = {
  view: QueryViewMode;
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

  return { query, view: opening.view };
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

  return { query, view: opening.view };
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
        };
      }

      queryLines.push(nextBlock.text);
    }
  }

  return null;
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

  return { view: parseQueryFenceAttributes(rawAttributes.join(' ')).view };
}

function parseQueryFenceAttributes(attributes: string): QueryFenceOpening {
  const viewMatch = attributes.match(
    /(?:^|\s|\{)view\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s}]+))/i
  );

  return { view: parseQueryViewMode(viewMatch?.[1] ?? viewMatch?.[2] ?? viewMatch?.[3]) };
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
