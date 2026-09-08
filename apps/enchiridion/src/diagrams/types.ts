export type DiagramKind = 'excalidraw' | 'd2';

export interface DiagramExport {
  source: string;
  previewDataURL?: string;
}

export type DiagramExporter = () => Promise<DiagramExport>;

export interface DiagramEditorProps {
  source: string;
  onReady: (exporter: DiagramExporter | null) => void;
}

export interface DiagramDialogProps {
  kind: DiagramKind;
  source: string;
  onSave: (result: DiagramExport) => void | Promise<void>;
  onCancel: () => void;
}
