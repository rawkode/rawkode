import type { DiagramKind } from './types';

export const MAX_D2_SOURCE_BYTES = 512 * 1024;
export const MAX_DRAWING_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
export const MAX_PREVIEW_EDGE = 1600;

export function validateD2Source(source: string): void {
  if (new TextEncoder().encode(source).byteLength > MAX_D2_SOURCE_BYTES) {
    throw new Error('D2 source must be 512 KiB or smaller.');
  }
  if (source.includes('\0')) throw new Error('D2 source cannot contain null characters.');
}

export function parseDrawing(source: string): Record<string, unknown> {
  if (!source) return { elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} };
  if (new TextEncoder().encode(source).byteLength > MAX_DRAWING_SOURCE_BYTES) {
    throw new Error('This drawing exceeds the 8 MiB source limit.');
  }
  const value: unknown = JSON.parse(source);
  if (!isRecord(value) || value.type !== 'excalidraw' || value.version !== 2 ||
      !Array.isArray(value.elements) || !isRecord(value.appState)) {
    throw new Error('This drawing has an unsupported format.');
  }
  if (value.elements.length > 50_000 || value.elements.some(element => !isRecord(element))) {
    throw new Error('This drawing contains unsupported elements.');
  }
  const files = value.files ?? {};
  if (!isRecord(files) || Object.values(files).some(file =>
    !isRecord(file) || typeof file.dataURL !== 'string' || !file.dataURL.startsWith('data:image/'))) {
    throw new Error('Drawing images must be embedded in the document.');
  }
  return { ...value, files, scrollToContent: true };
}

export function isDiagramEmpty(kind: DiagramKind, source: string): boolean {
  if (kind === 'd2') return !source.trim();
  const drawing = parseDrawing(source);
  return (drawing.elements as Record<string, unknown>[]).every(element => element.isDeleted === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
