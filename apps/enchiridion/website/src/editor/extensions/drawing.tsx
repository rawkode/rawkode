import { createRoot } from 'react-dom/client';
import {
	Excalidraw,
	MainMenu,
	serializeAsJSON,
	exportToBlob,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import type { ExtensionSession } from './registry';

export async function mount(
	element: HTMLElement,
	source: string,
): Promise<ExtensionSession> {
	Object.assign(window, { EXCALIDRAW_ASSET_PATH: '/diagram-assets/' });
	element.className = 'drawing-workspace';
	const root = createRoot(element);
	let api: ExcalidrawImperativeAPI | undefined;
	root.render(
		<Excalidraw
			initialData={
				source ? JSON.parse(source) : { appState: { currentItemFontFamily: 1 } }
			}
			excalidrawAPI={(value) => {
				api = value;
			}}
			validateEmbeddable={() => false}
			onLinkOpen={(_, event) => event.preventDefault()}
			UIOptions={{
				tools: { image: false },
				canvasActions: {
					loadScene: false,
					saveToActiveFile: false,
					export: false,
					saveAsImage: false,
				},
			}}
		>
			<MainMenu>
				<MainMenu.DefaultItems.ClearCanvas />
				<MainMenu.DefaultItems.ChangeCanvasBackground />
			</MainMenu>
		</Excalidraw>,
	);
	return {
		async read() {
			if (!api) throw new Error('Drawing is still loading');
			const elements = api.getSceneElements(),
				appState = api.getAppState(),
				files = api.getFiles();
			const serialized = serializeAsJSON(elements, appState, files, 'local');
			if (serialized.length > 750_000)
				throw new Error('Drawing exceeds document size limit');
			const blob = await exportToBlob({
				elements,
				appState,
				files,
				mimeType: 'image/png',
				maxWidthOrHeight: 1200,
			});
			const preview = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = reject;
				reader.readAsDataURL(blob);
			});
			return { source: serialized, preview };
		},
		destroy() {
			root.unmount();
		},
	};
}
