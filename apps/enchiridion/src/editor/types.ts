import type { Editor } from '@tiptap/core';

export type DiagramKind = 'excalidraw' | 'd2';
export interface DiagramEditRequest {
  id: string;
  kind: DiagramKind;
  source: string;
}
export interface DailyEditorOptions {
  element: HTMLElement;
  day: string;
  snapshot?: Uint8Array | null;
  legacy?: Uint8Array | null;
  onChange(snapshot: Uint8Array): void;
  loadPreview?(kind: DiagramKind, source: string): Promise<string | null>;
  onDiagramEdit(request: DiagramEditRequest): void;
  onSelection?(selection: { empty: boolean; rect: DOMRect | null; formats: string[] }): void;
}
export interface DailyEditorHandle {
  editor: Editor;
  ready: Promise<void>;
  exportSnapshot(): Uint8Array;
  prepareForTransition(): void;
  insertDiagram(kind: DiagramKind, source?: string): string;
  updateDiagram(id: string, expectedSource: string, source: string): void;
  destroy(): void;
}
