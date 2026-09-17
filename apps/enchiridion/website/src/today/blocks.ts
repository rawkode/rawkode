import type { DailyEditorHandle, DiagramEditRequest } from '../editor';
import {
	extensions,
	type ExtensionSession,
} from '../editor/extensions/registry';
import { previewCache } from './persistence';

export function blockController(
	getEditor: () => DailyEditorHandle,
	previews: Map<string, string>,
) {
	const dialog =
		document.querySelector<HTMLDialogElement>('#extension-dialog')!;
	const root = document.querySelector<HTMLElement>('#extension-root')!;
	const save = document.querySelector<HTMLButtonElement>('#extension-save')!;
	const error = document.querySelector<HTMLElement>('#extension-error')!;
	let session: ExtensionSession | undefined,
		request: DiagramEditRequest | undefined,
		generation = 0;
	const close = () => {
		generation++;
		session?.destroy();
		session = undefined;
		dialog.close();
		getEditor().editor.commands.focus();
	};
	dialog.addEventListener('cancel', (event) => {
		event.preventDefault();
		close();
	});
	document.querySelector('#extension-cancel')!.addEventListener('click', close);
	save.addEventListener('click', async () => {
		if (!session || !request) return;
		save.disabled = true;
		try {
			const result = await session.read();
			extensions.get(request.kind, request.version)!.validate(result.source);
			if (result.preview) {
				previews.set(`${request.kind}:${result.source}`, result.preview);
				await previewCache(request.kind, result.source, result.preview).catch(
					() => {},
				);
			}
			getEditor().updateDiagram(request.id, request.source, result.source);
			document.dispatchEvent(new Event('document-extension-preview'));
			close();
		} catch (failure) {
			error.textContent =
				failure instanceof Error ? failure.message : 'Could not save block';
		} finally {
			save.disabled = false;
		}
	});
	return async (value: DiagramEditRequest) => {
		const extension = extensions.get(value.kind, value.version);
		if (!extension) return;
		const ticket = ++generation;
		request = value;
		root.replaceChildren();
		error.textContent = '';
		save.disabled = true;
		document.querySelector('#extension-title')!.textContent = extension.label;
		dialog.showModal();
		try {
			const implementation = await extension.load();
			if (ticket !== generation) return;
			const mounted = await implementation.mount(root, value.source);
			if (ticket !== generation) {
				mounted.destroy();
				return;
			}
			session = mounted;
			save.disabled = false;
		} catch {
			error.textContent =
				'This extension could not load. The original block is unchanged.';
		}
	};
}
