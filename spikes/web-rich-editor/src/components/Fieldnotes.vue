<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { Editor, EditorContent, VueNodeViewRenderer } from "@tiptap/vue-3";
import Placeholder from "@tiptap/extension-placeholder";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import ComponentView from "./ComponentView.vue";
import { defaultComponent } from "../lib/component";
import { NOTE_LIMITS, parseNote, type NoteDocument } from "../lib/note";
import { ComponentNode, documentExtensions, applyBlockStyle } from "../editor/extensions";
import { FencedCodeAuthoring } from "../editor/fencedCode";
import { draftSchema, loadDocument, saveDocument } from '../editor/persistence';
import { nativeHost } from '../editor/nativeHost';

const STORAGE = "fieldnotes.web.tiptap";
const editor = shallowRef<Editor>();
const fileInput = ref<HTMLInputElement>();
const replaceNoteDialog = ref<HTMLDialogElement>();
const pendingReplacement = shallowRef<
	{ kind: "new" } | { kind: "import"; note: NoteDocument; filename: string }
>();
const filename = ref("Untitled.native-note");
const status = ref("Stored only in this browser");
const error = ref("");
const importing = ref(false);
const saveBlocked = ref(false);
const slash = ref<{
	from: number;
	to: number;
	query: string;
	x: number;
	y: number;
}>();
const slashIndex = ref(0);
const insertOpen = ref(false);
const revision = ref(0);
let importGeneration = 0;

type Block = { label: string; detail: string; icon: string; run: () => void };
const blocks: Block[] = [
	{
		label: "Text",
		detail: "Ordinary paragraph",
		icon: "T",
		run: () => paragraph(),
	},
	...([1, 2, 3] as const).map((level) => ({
		label: `Heading ${level}`,
		detail: ["Large heading", "Medium heading", "Small heading"][level - 1]!,
		icon: `H${level}`,
		run: () => setStyle(`heading${level}`),
	})),
	{
		label: "Quote",
		detail: "Quoted text",
		icon: "“",
		run: () => setStyle("quote"),
	},
	{
		label: "Bulleted list",
		detail: "Type - followed by space",
		icon: "•",
		run: () => editor.value?.chain().focus().toggleBulletList().run(),
	},
	{
		label: "Numbered list",
		detail: "Type 1. followed by space",
		icon: "1.",
		run: () => editor.value?.chain().focus().toggleOrderedList().run(),
	},
	{
		label: "To-do list",
		detail: "Type [] followed by space",
		icon: "☐",
		run: () => editor.value?.chain().focus().toggleTaskList().run(),
	},
	{
		label: "Code block",
		detail: "Code stays editable",
		icon: "<>",
		run: () => setStyle("code"),
	},
	{
		label: "D2 diagram",
		detail: "A diagram from source",
		icon: "D2",
		run: () => insertComponent("diagram"),
	},
	{
		label: "Mermaid diagram",
		detail: "Flows and sequences",
		icon: "M",
		run: () => insertComponent("mermaid"),
	},
	{
		label: "Drawing",
		detail: "Pen, shapes, and text",
		icon: "✎",
		run: () => insertComponent("drawing"),
	},
	{
		label: "Link or video",
		detail: "Discover a preview and player",
		icon: "↗",
		run: () => insertComponent("link"),
	},
];
const matches = computed(() =>
	blocks.filter((block) =>
		block.label.toLowerCase().includes(slash.value?.query.toLowerCase() ?? ""),
	),
);
const activeStyle = computed(() => {
	void revision.value;
	if (!editor.value) return "paragraph";
	for (const level of [1, 2, 3])
		if (editor.value.isActive("heading", { level })) return `heading${level}`;
	if (editor.value.isActive("blockquote")) return "quote";
	if (editor.value.isActive("codeBlock")) return "code";
	return "paragraph";
});
const componentExtension = ComponentNode.extend({
	addNodeView: () =>
		VueNodeViewRenderer(ComponentView, {
			stopEvent: ({ event }) =>
				event.target instanceof Element &&
				!!event.target.closest("[data-component-ui]"),
		}),
});

function active(name: string) {
	void revision.value;
	return !!editor.value?.isActive(name);
}
function setStyle(style: Parameters<typeof applyBlockStyle>[1]) {
	const current = editor.value;
	if (!current) return;
	current.commands.focus();
	if (!applyBlockStyle(current, style))
		error.value =
			"This block contains content that cannot be converted safely. Move the component to its own paragraph first.";
}
function paragraph() {
	setStyle("paragraph");
}
function styleChanged(event: Event) {
	setStyle(
		(event.target as HTMLSelectElement).value as Parameters<
			typeof applyBlockStyle
		>[1],
	);
}
function insertComponent(kind: "diagram" | "mermaid" | "drawing" | "link") {
	editor.value
		?.chain()
		.focus()
		.insertContent({
			type: "component",
			attrs: { component: defaultComponent(kind) },
		})
		.run();
}
function choose(block: Block) {
	if (slash.value)
		editor.value
			?.chain()
			.focus()
			.deleteRange({ from: slash.value.from, to: slash.value.to })
			.run();
	slash.value = undefined;
	insertOpen.value = false;
	block.run();
}
function updateSlash() {
	const current = editor.value;
	if (!current) return;
	const { $from, empty, from } = current.state.selection;
	const before = $from.parent.textBetween(
		0,
		$from.parentOffset,
		"\n",
		"\ufffc",
	);
	if (
		!empty ||
		$from.parent.type.name !== "paragraph" ||
		!/^\/[\w ]{0,30}$/.test(before)
	) {
		slash.value = undefined;
		return;
	}
	const rectangle = current.view.coordsAtPos(from);
	if (slash.value?.query !== before.slice(1)) slashIndex.value = 0;
	slash.value = {
		from: from - before.length,
		to: from,
		query: before.slice(1),
		x: Math.max(12, Math.min(rectangle.left, innerWidth - 290)),
		y: Math.min(rectangle.bottom + 8, Math.max(80, innerHeight - 370)),
	};
}
let saveRevision = 0;
async function saveDraft() {
	if (!editor.value || saveBlocked.value) return;
	const revision = ++saveRevision;
	try {
		const note = parseNote(editor.value.getJSON());
		const draft = draftSchema.parse({ filename: filename.value, note });
		if (nativeHost.available) {
			status.value = "Saving on this Mac…";
			await nativeHost.save(draft);
		} else {
			localStorage.setItem(STORAGE, JSON.stringify(draft));
		}
		if (revision !== saveRevision) return;
		status.value = nativeHost.available ? "Saved on this Mac" : "Saved in this browser";
		error.value = "";
	} catch (failure) {
		if (revision !== saveRevision) return;
		status.value = "Changes not saved";
		error.value =
			failure instanceof Error
				? failure.message
				: "Could not save this draft. Export a copy before closing.";
	}
}
async function download(contents: string, name: string) {
	if (nativeHost.available) {
		await nativeHost.export(contents, name);
		return;
	}
	const url = URL.createObjectURL(
		new Blob([contents], { type: "application/json" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function replaceDocument(content: NoteDocument) {
	const current = editor.value;
	if (!current) return;
	loadDocument(current, content);
	slash.value = undefined;
	revision.value++;
}
function freshPastedIDs(fragment: Fragment): Fragment {
	const nodes: PMNode[] = [];
	fragment.forEach((node) => {
		if (node.type.name === "component")
			nodes.push(
				node.type.create(
					{
						...node.attrs,
						component: { ...node.attrs.component, id: crypto.randomUUID() },
					},
					null,
					node.marks,
				),
			);
		else if (node.content.size)
			nodes.push(node.copy(freshPastedIDs(node.content)));
		else nodes.push(node);
	});
	return Fragment.from(nodes);
}
async function exportNote() {
	try {
		if (!editor.value) return;
		await download(
			saveDocument(editor.value),
			filename.value.replace(/(?:\.native-note)?$/, ".native-note"),
		);
		status.value = "Exported a portable copy";
	} catch (failure) {
		error.value =
			failure instanceof Error ? failure.message : "Could not export note.";
	}
}
async function importNote(event: Event) {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	if (!file) return;
	const generation = ++importGeneration;
	const previousDocument = editor.value?.state.doc;
	importing.value = true;
	try {
		if (file.size > NOTE_LIMITS.bytes)
			throw new Error(`Notes must be smaller than ${NOTE_LIMITS.bytes / 1024 / 1024} MiB.`);
		const note = parseNote(JSON.parse(await file.text()));
		if (
			generation !== importGeneration ||
			editor.value?.state.doc !== previousDocument
		) {
			throw new Error(
				"Your note changed while this file was opening. Nothing was replaced. Open the file again when you are ready.",
			);
		}
		pendingReplacement.value = { kind: "import", note, filename: file.name };
		replaceNoteDialog.value?.showModal();
	} catch (failure) {
		error.value =
			failure instanceof Error
				? failure.message
				: "Could not open note. Your current draft is unchanged.";
	} finally {
		importing.value = false;
		input.value = "";
	}
}
function requestNewNote() {
	importGeneration++;
	pendingReplacement.value = { kind: "new" };
	replaceNoteDialog.value?.showModal();
}
function confirmReplacement() {
	const replacement = pendingReplacement.value;
	if (!replacement || !editor.value) return;
	// Retain the current draft, filename, and undo history until validation and
	// replacement have succeeded. Opening the dialog alone never changes them.
	try {
		replaceDocument(replacement.kind === "import"
			? replacement.note
			: { type: "doc", content: [{ type: "paragraph" }] });
	} catch (failure) {
		error.value = failure instanceof Error ? failure.message : "Could not open note. Your current draft is unchanged.";
		return;
	}
	importGeneration++;
	pendingReplacement.value = undefined;
	replaceNoteDialog.value?.close();
	saveBlocked.value = false;
	filename.value = replacement.kind === "import" ? replacement.filename : "Untitled.native-note";
	saveDraft();
	editor.value?.commands.focus();
}
function recover() {
	const raw = localStorage.getItem(STORAGE);
	if (raw) download(raw, "Fieldnotes-recovered-draft.json");
}

onMounted(async () => {
	let initial = parseNote({ type: "doc", content: [
		{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Room to think." }] },
		{ type: "paragraph", content: [{ type: "text", text: "The same note, a different window. Write here, or open a note from the native app." }] },
		{ type: "paragraph" },
		{ type: "paragraph", content: [{ type: "text", text: "Type / for a block. Use - and space for a list." }] },
	] });
	try {
		const raw = nativeHost.available ? await nativeHost.load() : localStorage.getItem(STORAGE);
		if (raw) {
			const saved = draftSchema.parse(nativeHost.available ? raw : JSON.parse(raw as string));
			initial = saved.note;
			filename.value = saved.filename;
		}
		if (nativeHost.available) status.value = "Loaded from this Mac";
	} catch (failure) {
		saveBlocked.value = true;
		error.value = nativeHost.available
			? "The saved draft could not be opened. It has not been overwritten. Back up draft.json in the app’s data directory before opening a valid note or starting a new one."
			: "The saved draft could not be opened. It has not been overwritten. Download it for recovery, then open a valid note or start a new one.";
	}
	editor.value = new Editor({
		extensions: [
			...documentExtensions(componentExtension),
			Placeholder.configure({
				placeholder: "Write something, or type / for blocks…",
			}),
			FencedCodeAuthoring,
		],
		content: initial,
		editorProps: {
			attributes: {
				"aria-label": "Note editor",
				role: "textbox",
				"aria-multiline": "true",
				spellcheck: "true",
			},
			transformPasted: (slice, view) =>
				view.dragging?.move
					? slice
					: new Slice(
							freshPastedIDs(slice.content),
							slice.openStart,
							slice.openEnd,
						),
			handleKeyDown: (_view, event) => {
				if (
					(event.metaKey || event.ctrlKey) &&
					event.altKey &&
					/^[0-3]$/.test(event.key)
				) {
					event.preventDefault();
					setStyle(
						event.key === "0"
							? "paragraph"
							: (`heading${event.key}` as "heading1" | "heading2" | "heading3"),
					);
					return true;
				}
				if (slash.value) {
					if (event.key === "Escape") {
						slash.value = undefined;
						return true;
					}
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						slashIndex.value =
							(slashIndex.value +
								(event.key === "ArrowDown" ? 1 : -1) +
								Math.max(1, matches.value.length)) %
							Math.max(1, matches.value.length);
						return true;
					}
					if (
						(event.key === "Enter" || event.key === "Tab") &&
						matches.value[slashIndex.value]
					) {
						choose(matches.value[slashIndex.value]!);
						return true;
					}
				}
				if (event.key === "Tab" && editor.value) {
					const item = editor.value.isActive("taskItem")
						? "taskItem"
						: editor.value.isActive("listItem")
							? "listItem"
							: null;
					if (item) {
						event.preventDefault();
						return event.shiftKey
							? editor.value.commands.liftListItem(item)
							: editor.value.commands.sinkListItem(item);
					}
				}
				return false;
			},
		},
		onUpdate: () => {
			saveDraft();
			updateSlash();
			revision.value++;
		},
		onSelectionUpdate: () => {
			updateSlash();
			revision.value++;
		},
	});
});
onBeforeUnmount(() => editor.value?.destroy());
</script>

<template>
	<div class="app-shell">
		<header class="app-header">
			<a class="wordmark" href="/" aria-label="Fieldnotes home"
				><svg aria-hidden="true" viewBox="0 0 24 24">
					<path
						d="M6 3h11a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M8 3v18 M11 8h5 M11 12h5"
					/></svg
				>Fieldnotes <span>Web</span></a
			>
			<div class="file-actions">
				<button @click="requestNewNote">New note</button>
				<button :disabled="importing" @click="fileInput?.click()">
					{{ importing ? "Opening…" : "Open note" }}
				</button>
				<button class="primary" @click="exportNote">
					Export note <span aria-hidden="true">↗</span>
				</button>
				<input
					ref="fileInput"
					class="file-input"
					type="file"
					accept=".native-note,.json,application/json"
					aria-label="Open portable note file"
					@change="importNote"
				/>
			</div>
		</header>
		<div class="document-meta">
			<span class="filename">{{ filename }}</span
			><span role="status" aria-live="polite">{{ status }}</span>
		</div>
		<nav v-if="editor" class="editor-toolbar" aria-label="Text formatting">
			<select
				aria-label="Paragraph style"
				:value="activeStyle"
				@change="styleChanged"
			>
				<option value="paragraph">Text</option>
				<option value="heading1">Heading 1</option>
				<option value="heading2">Heading 2</option>
				<option value="heading3">Heading 3</option>
				<option value="quote">Quote</option>
				<option value="code">Code block</option>
			</select>
			<span class="toolbar-divider" />
			<button
				aria-label="Bold"
				title="Bold (⌘B)"
				:aria-pressed="active('bold')"
				@click="editor.chain().focus().toggleBold().run()"
			>
				<b>B</b>
			</button>
			<button
				aria-label="Italic"
				title="Italic (⌘I)"
				:aria-pressed="active('italic')"
				@click="editor.chain().focus().toggleItalic().run()"
			>
				<i>I</i>
			</button>
			<button
				aria-label="Underline"
				title="Underline (⌘U)"
				:aria-pressed="active('underline')"
				@click="editor.chain().focus().toggleUnderline().run()"
			>
				<u>U</u>
			</button>
			<button
				aria-label="Strikethrough"
				:aria-pressed="active('strike')"
				@click="editor.chain().focus().toggleStrike().run()"
			>
				<s>S</s>
			</button>
			<button
				aria-label="Inline code"
				:aria-pressed="active('code')"
				@click="editor.chain().focus().toggleCode().run()"
			>
				&lt;&gt;
			</button>
			<span class="toolbar-divider" />
			<button
				aria-label="Bulleted list"
				title="Bulleted list"
				:aria-pressed="active('bulletList')"
				@click="editor.chain().focus().toggleBulletList().run()"
			>
				• ≡
			</button>
			<button
				aria-label="Numbered list"
				title="Numbered list"
				:aria-pressed="active('orderedList')"
				@click="editor.chain().focus().toggleOrderedList().run()"
			>
				1. ≡
			</button>
			<button
				aria-label="To-do list"
				title="To-do list"
				:aria-pressed="active('taskList')"
				@click="editor.chain().focus().toggleTaskList().run()"
			>
				☐
			</button>
			<span class="toolbar-divider" />
			<button aria-label="Undo" @click="editor.chain().focus().undo().run()">
				↶</button
			><button aria-label="Redo" @click="editor.chain().focus().redo().run()">
				↷
			</button>
			<button
				class="insert-button"
				:aria-expanded="insertOpen"
				@click="insertOpen = !insertOpen"
			>
				＋ Insert
			</button>
		</nav>
		<div v-if="error" class="error-message" role="alert">
			<p>{{ error }}</p>
			<button v-if="saveBlocked && !nativeHost.available" @click="recover">
				Download recovered draft</button
			><button v-else @click="error = ''">Dismiss</button>
		</div>
		<main>
			<EditorContent v-if="editor" :editor="editor" />
			<div v-else class="loading-note" aria-label="Loading editor">
				<div />
				<div />
				<div />
			</div>
		</main>
		<footer>
			<span>Type <kbd>/</kbd> for blocks</span
			><span>Portable notes. No account or cloud sync.</span>
		</footer>
		<dialog
			ref="replaceNoteDialog"
			class="new-note-dialog"
			aria-labelledby="new-note-heading"
			@close="pendingReplacement = undefined"
		>
			<h2 id="new-note-heading">{{ pendingReplacement?.kind === 'import' ? 'Open this note?' : 'Start a new note?' }}</h2>
			<p v-if="pendingReplacement?.kind === 'import'">Opening {{ pendingReplacement.filename }} will replace the current draft.</p>
			<p>Export the current note first to keep a copy. Replacing it clears its undo history.</p>
			<div>
				<button @click="replaceNoteDialog?.close()">Keep editing</button
				><button @click="exportNote">Export current note</button
				><button class="primary" @click="confirmReplacement">{{ pendingReplacement?.kind === 'import' ? 'Open note' : 'Start new note' }}</button>
			</div>
		</dialog>
		<div
			v-if="slash"
			class="block-menu"
			role="listbox"
			aria-label="Insert block"
			:style="{ left: `${slash.x}px`, top: `${slash.y}px` }"
		>
			<div class="menu-title">Insert a block</div>
			<button
				v-for="(block, index) in matches"
				:key="block.label"
				role="option"
				:aria-selected="index === slashIndex"
				@mousedown.prevent="choose(block)"
			>
				<span class="block-icon">{{ block.icon }}</span
				><span
					>{{ block.label }}<small>{{ block.detail }}</small></span
				>
			</button>
			<p v-if="!matches.length">No matching blocks</p>
		</div>
		<div
			v-if="insertOpen"
			class="insert-backdrop"
			@click.self="insertOpen = false"
		>
			<div
				class="block-menu insert-menu"
				role="dialog"
				aria-label="Insert a block"
			>
				<div class="menu-title">
					Insert a block
					<button aria-label="Close insert menu" @click="insertOpen = false">
						×
					</button>
				</div>
				<button
					v-for="block in blocks"
					:key="block.label"
					@click="choose(block)"
				>
					<span class="block-icon">{{ block.icon }}</span
					><span
						>{{ block.label }}<small>{{ block.detail }}</small></span
					>
				</button>
			</div>
		</div>
	</div>
</template>
