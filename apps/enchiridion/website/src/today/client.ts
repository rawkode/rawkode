import '../editor/extensions/defaults';
import { createDailyEditor, type DailyEditorHandle } from '../editor';
import { extensions } from '../editor/extensions/registry';
import { DocumentPersistence, previewCache } from './persistence';
import { dayKey, parseDay, loadContext } from './context';
import { blockController } from './blocks';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
	document.querySelector<T>(selector)!;
const day =
	new URL(location.href).searchParams.get('day') || dayKey(new Date());
const date = parseDay(day),
	isToday = day === dayKey(new Date());
$('#day-label').textContent = date.toLocaleDateString(undefined, {
	weekday: 'long',
	month: 'long',
	day: 'numeric',
	year: 'numeric',
});
$('#day-title').replaceChildren(
	document.createTextNode(
		isToday ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'long' }),
	),
	Object.assign(document.createElement('span'), {
		className: 'title-dot',
		textContent: '.',
	}),
);
$('#breadcrumb-day').textContent = isToday
	? 'Today'
	: date.toLocaleDateString();
$('#choose-day').textContent = isToday
	? 'Today'
	: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
$('#timezone-label').textContent = Intl.DateTimeFormat()
	.resolvedOptions()
	.timeZone.replaceAll('_', ' ');
$<HTMLInputElement>('#note-date').value = day;
void loadContext(day);

const persistence = new DocumentPersistence(
	`day/${day}`,
	document.body.dataset.owner!,
	(text) => {
		$('#save-status').textContent = text;
	},
);
let handle: DailyEditorHandle;
let changed = false;
const previews = new Map<string, string>();
const editBlock = blockController(() => handle, previews);
function report(error: unknown) {
	$('#editor-error').hidden = false;
	$('#editor-error').textContent =
		error instanceof Error
			? error.message
			: 'Could not save. Keep this tab open and export a copy.';
}
function manifest() {
	const items = new Map<string, { id: string; version: number }>();
	handle.editor.state.doc.descendants((node) => {
		if (node.type.name === 'diagram')
			items.set(`${node.attrs.kind}@${node.attrs.version}`, {
				id: node.attrs.kind,
				version: node.attrs.version,
			});
	});
	return [...items.values()];
}
async function navigate(target: string) {
	try {
		parseDay(target);
		handle.prepareForTransition();
		await Promise.resolve();
		if (changed) persistence.queue(handle.exportSnapshot(), manifest());
		await persistence.flush();
		if (persistence.dirty) {
			handle.editor.setEditable(true);
			throw new Error(
				'This note is saved only on this device. Retry the server save or export a copy before switching days.',
			);
		}
		location.assign(target === dayKey(new Date()) ? '/' : `/?day=${target}`);
	} catch (error) {
		if (handle) handle.editor.setEditable(true);
		report(error);
	}
}
async function initialize() {
	try {
		const snapshot = await persistence.load();
		handle = createDailyEditor({
			element: $('#editor'),
			day,
			snapshot,
			onChange(bytes) {
				changed = true;
				try {
					persistence.queue(bytes, manifest());
				} catch (error) {
					report(error);
				}
				$('#word-count').textContent =
					`${handle.editor.getText().trim().split(/\s+/).filter(Boolean).length} words`;
			},
			loadPreview: async (kind, source) =>
				previews.get(`${kind}:${source}`) || (await previewCache(kind, source)),
			onDiagramEdit: (value) => {
				void editBlock(value);
			},
			onSelection(selection) {
				const tools = $('#selection-tools');
				if (selection.empty || !selection.rect) {
					tools.hidePopover();
					return;
				}
				tools.showPopover();
				tools.style.left = `${Math.max(8, Math.min(window.innerWidth - 190, selection.rect.left))}px`;
				tools.style.top = `${Math.max(8, selection.rect.top - 45)}px`;
			},
		});
		await handle.ready;
		$('#editor').setAttribute('aria-busy', 'false');
		if (persistence.dirty) await persistence.flush();
		installCommands();
	} catch (error) {
		report(error);
		$('#save-status').textContent = 'Document not opened';
	}
}
function download() {
	const url = URL.createObjectURL(
		new Blob([handle.exportSnapshot() as BlobPart], {
			type: 'application/octet-stream',
		}),
	);
	const link = document.createElement('a');
	link.href = url;
	link.download = `${day}.loro`;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function installCommands() {
	const commands = [
		{
			label: 'Heading',
			detail: 'Give a thought a title',
			icon: 'H',
			run: () =>
				handle.editor.chain().focus().toggleHeading({ level: 2 }).run(),
		},
		{
			label: 'Checklist',
			detail: 'Make room for your next steps',
			icon: '☑',
			run: () => handle.editor.chain().focus().toggleTaskList().run(),
		},
		{
			label: 'Bullet list',
			detail: 'Collect a few things',
			icon: '≡',
			run: () => handle.editor.chain().focus().toggleBulletList().run(),
		},
		{
			label: 'Table',
			detail: 'A little structure for your notes',
			icon: '▦',
			run: () =>
				handle.editor
					.chain()
					.focus()
					.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
					.run(),
		},
		...extensions.list().map((extension) => ({
			label: extension.label,
			detail: extension.description,
			icon: extension.id === 'd2' ? '◇' : '✎',
			run() {
				const id = handle.insertDiagram(
					extension.id,
					extension.initialSource,
					extension.version,
				);
				void editBlock({
					id,
					kind: extension.id,
					version: extension.version,
					source: extension.initialSource,
				});
			},
		})),
		{
			label: 'Export document',
			detail: 'Download a lossless Loro snapshot',
			icon: '↓',
			run: download,
		},
		{
			label: 'Retry save',
			detail: 'Send your device copy to Documents',
			icon: '↻',
			run: () => {
				void persistence.flush();
			},
		},
	];
	const dialog = $<HTMLDialogElement>('#command-dialog'),
		search = $<HTMLInputElement>('#command-search');
	function renderCommands() {
		$('#command-list').replaceChildren();
		for (const command of commands.filter((c) =>
			`${c.label} ${c.detail}`
				.toLowerCase()
				.includes(search.value.toLowerCase()),
		)) {
			const button = document.createElement('button');
			const icon = document.createElement('b');
			icon.textContent = command.icon;
			const text = document.createElement('div');
			text.textContent = command.label;
			const detail = document.createElement('span');
			detail.textContent = command.detail;
			text.append(detail);
			button.append(icon, text);
			button.onclick = () => {
				dialog.close();
				command.run();
			};
			$('#command-list').append(button);
		}
	}
	const open = () => {
		search.value = '';
		renderCommands();
		dialog.showModal();
		search.focus();
	};
	search.addEventListener('input', renderCommands);
	dialog.addEventListener('keydown', (event) => {
		const buttons = [...$('#command-list').querySelectorAll('button')];
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			buttons[
				(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
					buttons.length
			]?.focus();
		}
		if (event.key === 'Enter' && document.activeElement === search) {
			event.preventDefault();
			buttons[0]?.click();
		}
	});
	$('#commands-button').onclick = open;
	$('#insert-block').onclick = open;
	document.addEventListener('keydown', (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			if (!document.querySelector('dialog[open]')) open();
		}
		if ((event.metaKey || event.ctrlKey) && event.key === '1') {
			event.preventDefault();
			void navigate(dayKey(new Date()));
		}
	});
	for (const button of document.querySelectorAll<HTMLButtonElement>(
		'[data-format]',
	)) {
		button.onmousedown = (event) => event.preventDefault();
		button.onclick = () => {
			const chain = handle.editor.chain().focus();
			switch (button.dataset.format) {
				case 'bold':
					chain.toggleBold().run();
					break;
				case 'italic':
					chain.toggleItalic().run();
					break;
				case 'strike':
					chain.toggleStrike().run();
					break;
				case 'code':
					chain.toggleCode().run();
					break;
			}
		};
	}
}
for (const button of document.querySelectorAll<HTMLElement>('[data-close]'))
	button.onclick = () => button.closest('dialog')?.close();
$('#focus-mode').onclick = () => {
	const active = document.body.classList.toggle('focus-mode');
	$('#focus-mode').setAttribute('aria-pressed', String(active));
};
$('#layout-info').onclick = () =>
	$<HTMLDialogElement>('#layout-dialog').showModal();
const openDate = () => $<HTMLDialogElement>('#date-dialog').showModal();
$('#choose-day').onclick = openDate;
$('#open-date').onclick = openDate;
$('#date-form').onsubmit = (event) => {
	event.preventDefault();
	void navigate($<HTMLInputElement>('#note-date').value);
};
for (const [id, delta] of [
	['#previous-day', -1],
	['#next-day', 1],
] as const)
	$(id).onclick = () => {
		const next = new Date(date);
		next.setDate(next.getDate() + delta);
		void navigate(dayKey(next));
	};
window.addEventListener('beforeunload', (event) => {
	if (persistence.dirty) event.preventDefault();
});
document.addEventListener('click', (event) => {
	const anchor = (event.target as Element).closest('a');
	if (
		anchor &&
		handle &&
		changed &&
		anchor.origin === location.origin &&
		!anchor.hash &&
		!event.metaKey &&
		!event.ctrlKey
	) {
		event.preventDefault();
		void (async () => {
			try {
				handle.prepareForTransition();
				await Promise.resolve();
				persistence.queue(handle.exportSnapshot(), manifest());
				await persistence.flush();
				if (persistence.dirty)
					throw new Error('Export or retry saving before leaving this note.');
				location.assign(anchor.href);
			} catch (error) {
				handle.editor.setEditable(true);
				report(error);
			}
		})();
	}
});
void initialize();
