import { useEffect, useState } from 'react';
import { Excalidraw, MainMenu, exportToBlob, serializeAsJSON } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { MAX_DRAWING_SOURCE_BYTES, MAX_PREVIEW_EDGE, parseDrawing } from './limits';
import { pngDataURL } from './exportPreview';
import type { DiagramEditorProps } from './types';

Object.assign(window, { EXCALIDRAW_ASSET_PATH: `${import.meta.env.BASE_URL}diagram-assets/` });

export default function DrawingEditor({ source, onReady }: DiagramEditorProps) {
  const [api, setAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [initial] = useState(() => parseDrawing(source) as ExcalidrawInitialDataState);

  useEffect(() => {
    if (!api) return;
    onReady(async () => {
      const elements = api.getSceneElements();
      const appState = api.getAppState();
      const files = api.getFiles();
      const serialized = serializeAsJSON(elements, appState, files, 'local');
      if (new TextEncoder().encode(serialized).byteLength > MAX_DRAWING_SOURCE_BYTES) {
        throw new Error('This drawing exceeds the 8 MiB source limit.');
      }
      if (!elements.length) return { source: serialized };
      const blob = await exportToBlob({
        elements, appState: { ...appState, exportBackground: true }, files,
        mimeType: 'image/png', maxWidthOrHeight: MAX_PREVIEW_EDGE,
      });
      return { source: serialized, previewDataURL: await pngDataURL(blob) };
    });
    return () => onReady(null);
  }, [api, onReady]);

  return (
    <div className="diagram-drawing" aria-label="Drawing canvas">
      <Excalidraw
        excalidrawAPI={setAPI}
        initialData={initial}
        validateEmbeddable={() => false}
        onLinkOpen={(_element, event) => event.preventDefault()}
        UIOptions={{ canvasActions: {
          loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false,
        } }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
