<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { Editor, EditorContent, VueNodeViewRenderer } from "@tiptap/vue-3";
import Placeholder from "@tiptap/extension-placeholder";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import ComponentView from "./ComponentView.vue";
import TodaySidebar from "./TodaySidebar.vue";
import { defaultComponent } from "../lib/component";
import { NOTE_LIMITS, parseEntity, parseNote, type EntityReference, type NoteDocument } from "@e2/documents/note";
import { ComponentNode, documentExtensions, applyBlockStyle } from "../editor/extensions";
import { FencedCodeAuthoring } from "../editor/fencedCode";
import { canonicalEntityReference, closeEntityComposer, createLatestEntitySearch, EntityComposer, entityComposerKey, type EntityComposerMatch } from "../editor/entityComposer";
import { loadDocument, saveDocument } from '../editor/persistence';
import { createDocumentSaver, readDocument, todayBounds, todayDocumentId, type SaveState } from '../editor/documents';
import { createCanonicalEntity, editorRegistry, listCanonicalSupertags, searchCanonicalEntities, type CanonicalEntitySummary, type CanonicalSupertag } from "../editor/registry";
import { paneSearchParams } from "../editor/paneStack";

const props = withDefaults(defineProps<{
	documentId?: string;
	title?: string;
	showSidebar?: boolean;
	embedded?: boolean;
	showHeading?: boolean;
	showFileActions?: boolean;
}>(), {
	title: "Today",
	showSidebar: true,
	embedded: false,
	showHeading: true,
	showFileActions: false,
});
const emit = defineEmits<{ openEntity: [entityId: string] }>();

const day = new Date();
const documentId = props.documentId ?? todayDocumentId(day);
const dayBounds = todayBounds(day);
const dayLabel = props.title ?? day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
let saver: ReturnType<typeof createDocumentSaver> | undefined;
const loading = ref(true);
const invalidChanges = ref(false);
const saveState = ref<SaveState>("idle");
const editor = shallowRef<Editor>();
const heading = ref<HTMLHeadingElement>();
const fileInput = ref<HTMLInputElement>();
const replaceNoteDialog = ref<HTMLDialogElement>();
const pendingReplacement = shallowRef<
	{ kind: "new" } | { kind: "import"; note: NoteDocument; filename: string }
>();
const filename = ref(`${props.title === "Today" ? documentId.slice(6) : props.title}.native-note`);
const status = ref("Loading today…");
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
const entityMenu = ref<EntityComposerMatch & {
	x: number;
	y: number;
}>();
const entityMatches = ref<CanonicalEntitySummary[]>([]);
const entityIndex = ref(0);
const entitySearchLoading = ref(false);
const entitySearchError = ref("");
const entityCreateMode = ref(false);
const entityCreating = ref(false);
const entityCreateError = ref("");
const entityTags = ref<CanonicalSupertag[]>([]);
const entityTagId = ref("");
const entityTagSelect = ref<HTMLSelectElement>();
const paletteOpen = ref(false);
const paletteQuery = ref("");
const paletteIndex = ref(0);
const paletteInput = ref<HTMLInputElement>();
const revision = ref(0);
let importGeneration = 0;
const pendingExternalEntities: EntityReference[] = [];
let dismissedEntityToken: Pick<EntityComposerMatch, "from" | "trigger"> | undefined;
const canonicalEntitySearch = createLatestEntitySearch(
	(input: { query: string; rootId?: string }, signal) =>
		searchCanonicalEntities(input.query, input.rootId, signal),
);

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
		detail: "Save a link or play imported media",
		icon: "↗",
		run: () => insertComponent("link"),
	},
];
const matches = computed(() =>
	blocks.filter((block) =>
		block.label.toLowerCase().includes(slash.value?.query.toLowerCase() ?? ""),
	),
);
const commandMatches = computed(() => {
	const query = paletteQuery.value.toLocaleLowerCase().trim();
	return editorRegistry.commands.filter((command) =>
		!query || [command.label, command.detail, ...command.keywords].some((value) =>
			value.toLocaleLowerCase().includes(query)
		)
	);
});
const entityChoiceCount = computed(() =>
	entityMatches.value.length +
	(entityMenu.value?.trigger === "#" && entityMenu.value.query ? 1 : 0)
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

const active = (name: string) => {
	void revision.value;
	return !!editor.value?.isActive(name);
};
const activateEntity = (entityId: string) => {
	if (props.embedded) {
		emit("openEntity", entityId);
		return;
	}
	const params = paneSearchParams(new URLSearchParams(), [
		{ kind: "document", id: documentId },
		{ kind: "entity", id: entityId },
	]);
	window.location.assign(`/?${params.toString()}`);
};
const setStyle = (style: Parameters<typeof applyBlockStyle>[1]) => {
	const current = editor.value;
	if (!current) return;
	current.commands.focus();
	if (!applyBlockStyle(current, style))
		error.value =
			"This block contains content that cannot be converted safely. Move the component to its own paragraph first.";
};
const paragraph = () => {
	setStyle("paragraph");
};
const styleChanged = (event: Event) => {
	setStyle(
		(event.target as HTMLSelectElement).value as Parameters<
			typeof applyBlockStyle
		>[1],
	);
};
const insertComponent = (kind: "diagram" | "mermaid" | "drawing" | "link") => {
	editor.value
		?.chain()
		.focus()
		.insertContent({
			type: "component",
			attrs: { component: defaultComponent(kind) },
		})
		.run();
};
const choose = (block: Block) => {
	if (slash.value)
		editor.value
			?.chain()
			.focus()
			.deleteRange({ from: slash.value.from, to: slash.value.to })
			.run();
	slash.value = undefined;
	insertOpen.value = false;
	block.run();
};
const setEntityAutocomplete = (open: boolean) => {
	const dom = editor.value?.view.dom;
	if (!dom) return;
	if (!open) {
		dom.removeAttribute("aria-autocomplete");
		dom.removeAttribute("aria-expanded");
		dom.removeAttribute("aria-controls");
		dom.removeAttribute("aria-activedescendant");
		return;
	}
	dom.setAttribute("aria-autocomplete", "list");
	dom.setAttribute("aria-expanded", "true");
	dom.setAttribute("aria-controls", "entity-composer-listbox");
	if (entityChoiceCount.value) {
		dom.setAttribute(
			"aria-activedescendant",
			`entity-composer-option-${entityIndex.value}`,
		);
	} else dom.removeAttribute("aria-activedescendant");
};
const closeEntityMenu = (dispatch = true) => {
	canonicalEntitySearch.cancel();
	entityMenu.value = undefined;
	entityMatches.value = [];
	entityCreateMode.value = false;
	entitySearchLoading.value = false;
	entitySearchError.value = "";
	entityCreateError.value = "";
	setEntityAutocomplete(false);
	const current = editor.value;
	if (dispatch && current) {
		current.view.dispatch(closeEntityComposer(current.state.tr));
	}
};
const dismissEntityMenu = () => {
	const menu = entityMenu.value;
	dismissedEntityToken = menu?.mode === "typed"
		? { from: menu.from, trigger: menu.trigger }
		: undefined;
	closeEntityMenu();
};
const insertCanonicalEntity = (
	entity: Pick<CanonicalEntitySummary, "id" | "label">,
) => {
	const current = editor.value;
	const menu = entityMenu.value;
	if (!current || !menu) return;
	const reference = canonicalEntityReference(menu, entity);
	current.chain().focus().deleteRange({ from: menu.from, to: menu.to }).insertContent({
		type: "entity",
		attrs: { entity: reference },
	}).run();
	closeEntityMenu(false);
};
const beginEntityCreate = async () => {
	if (!entityMenu.value?.query || entityMenu.value.trigger !== "#") return;
	entityCreateMode.value = true;
	entityCreateError.value = "";
	setEntityAutocomplete(false);
	if (!entityTags.value.length) {
		try {
			entityTags.value = (await listCanonicalSupertags()).filter((tag) =>
				!tag.archived && tag.kind !== "integration"
			);
			entityTagId.value = entityTags.value.find((tag) => tag.kind === "base")?.id ?? "";
		} catch (failure) {
			entityCreateError.value = failure instanceof Error
				? failure.message
				: "Supertags are unavailable.";
		}
	}
	void nextTick(() => entityTagSelect.value?.focus());
};
const cancelEntityCreate = () => {
	entityCreateMode.value = false;
	entityCreateError.value = "";
	setEntityAutocomplete(true);
	editor.value?.commands.focus();
};
const createEntityFromMenu = async () => {
	const menu = entityMenu.value;
	if (!menu?.query || !entityTagId.value || entityCreating.value) return;
	entityCreating.value = true;
	entityCreateError.value = "";
	try {
		const created = await createCanonicalEntity(menu.query, entityTagId.value);
		if (entityMenu.value !== menu) return;
		insertCanonicalEntity(created);
	} catch (failure) {
		entityCreateError.value = failure instanceof Error
			? failure.message
			: "The entity could not be created.";
	} finally {
		entityCreating.value = false;
	}
};
const insertExternalEntity = (event: Event) => {
	if (!(event instanceof CustomEvent)) return;
	try {
		const entity = parseEntity(event.detail);
		if (!editor.value) {
			pendingExternalEntities.push(entity);
			return;
		}
		editor.value.chain().focus().insertContent({
			type: "entity",
			attrs: { entity },
		}).run();
	} catch {
		error.value = "That linked entity could not be inserted.";
	}
};
const updateEntityMenu = async (match: EntityComposerMatch | null) => {
	const current = editor.value;
	if (!current || !match) {
		if (entityMenu.value) closeEntityMenu(false);
		return;
	}
	if (
		match.mode === "typed" && dismissedEntityToken?.from === match.from &&
		dismissedEntityToken.trigger === match.trigger
	) return;
	dismissedEntityToken = undefined;
	const rectangle = current.view.coordsAtPos(match.to);
	entityMenu.value = {
		...match,
		x: Math.max(12, Math.min(rectangle.left, innerWidth - 330)),
		y: Math.min(rectangle.bottom + 8, Math.max(80, innerHeight - 390)),
	};
	entityCreateMode.value = false;
	entityCreateError.value = "";
	entitySearchError.value = "";
	entitySearchLoading.value = true;
	setEntityAutocomplete(true);
	let currentResult = false;
	try {
		const result = await canonicalEntitySearch.run({
			query: match.query,
			rootId: match.trigger === "@" ? "base:person" : undefined,
		});
		if (!result.accepted) return;
		currentResult = true;
		entityMatches.value = result.value;
		entityIndex.value = 0;
		setEntityAutocomplete(true);
	} catch (failure) {
		currentResult = true;
		entityMatches.value = [];
		entitySearchError.value = failure instanceof Error
			? failure.message
			: "Entity search is unavailable.";
	} finally {
		if (currentResult) entitySearchLoading.value = false;
	}
};
const openPalette = () => {
	paletteOpen.value = true;
	paletteQuery.value = "";
	paletteIndex.value = 0;
	void nextTick(() => paletteInput.value?.focus());
};
const runCommand = async (command: (typeof editorRegistry.commands)[number]) => {
	paletteOpen.value = false;
	await command.run({
		notify: (message) => {
			status.value = message;
			error.value = "";
		},
	});
};
const paletteKey = (event: KeyboardEvent) => {
	if (event.key === "Escape") {
		paletteOpen.value = false;
		return;
	}
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		paletteIndex.value =
			(paletteIndex.value + (event.key === "ArrowDown" ? 1 : -1) +
				Math.max(1, commandMatches.value.length)) %
			Math.max(1, commandMatches.value.length);
		return;
	}
	if (event.key === "Enter" && commandMatches.value[paletteIndex.value]) {
		event.preventDefault();
		void runCommand(commandMatches.value[paletteIndex.value]!);
	}
};
const updateSlash = () => {
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
};
const saveDraft = () => {
	if (!editor.value || saveBlocked.value || !saver) return;
	try {
		const note = parseNote(editor.value.getJSON());
		invalidChanges.value = false;
		saver.schedule(note);
	}
	catch (failure) { invalidChanges.value = true; status.value = "Changes not saved"; error.value = failure instanceof Error ? failure.message : "Could not save this note. Export a copy before leaving."; }
};
const prepareForTransition = async (): Promise<boolean> => {
	// Do not schedule an unchanged lazy document merely because its pane closes.
	// Composition must finish so the editor's normal update hook has captured the
	// final DOM input before the pending save is flushed.
	if (editor.value?.view.composing || invalidChanges.value) return false;
	return await saver?.flush() ?? true;
};
const focusHeading = () => {
	void nextTick(() => heading.value?.focus());
};
defineExpose({ prepareForTransition, focusHeading });
const download = (contents: string, name: string) => {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const replaceDocument = (content: NoteDocument) => {
	const current = editor.value;
	if (!current) return;
	loadDocument(current, content);
	slash.value = undefined;
	revision.value++;
};
const freshPastedIDs = (fragment: Fragment): Fragment => {
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
};
const exportNote = async () => {
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
};
const importNote = async (event: Event) => {
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
};
const requestNewNote = () => {
	importGeneration++;
	pendingReplacement.value = { kind: "new" };
	replaceNoteDialog.value?.showModal();
};
const confirmReplacement = () => {
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
	
	
	saveDraft();
	editor.value?.commands.focus();
};
const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
  if (!invalidChanges.value && !saver?.hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = "";
};
const loadToday = async () => {
  loading.value = true;
  error.value = "";
  saveBlocked.value = true;
  let initial = parseNote({ type: "doc", content: [{ type: "paragraph" }] });
  try {
    const saved = await readDocument(documentId);
    initial = saved?.note ?? initial;
	    saver = createDocumentSaver({ id: documentId, revision: saved?.revision ?? null,
	      onState: (state, message) => {
	        saveState.value = state;
	        if (invalidChanges.value) {
	          if (state === "conflict") {
	            status.value = "Changes need attention";
	            error.value = message ?? "This note changed in another window. Export your changes, then reload to open the saved version.";
	            return;
	          }
	          status.value = "Changes not saved";
	          return;
	        }
	        status.value = ({ idle: "Start writing to save today's note", pending: "Unsaved changes", saving: "Saving…", saved: "All changes saved", error: "Changes not saved", conflict: "Changes need attention" })[state];
	        error.value = message ?? "";
	      },
	    });
    status.value = saved ? "All changes saved" : "Start writing to save today's note";
    saveBlocked.value = false;
  } catch (failure) {
    status.value = "Note unavailable";
    error.value = failure instanceof Error ? failure.message : "Could not load today's note.";
    loading.value = false;
    return;
  }
	editor.value = new Editor({
		extensions: [
			...documentExtensions(componentExtension),
			EntityComposer.configure({
				onChange: (match) => void updateEntityMenu(match),
			}),
			Placeholder.configure({
				placeholder: "Write something, type / for blocks, or # to link…",
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
			handleClickOn: (_view, _position, node, _nodePosition, event, direct) => {
					const entity = node.type.name === "entity" ? node.attrs.entity : null;
					if (!direct || entity?.version !== 1) return false;
					event.preventDefault();
					activateEntity(entity.entityId);
					return true;
				},
			handleKeyDown: (_view, event) => {
					if (
						event.key === "Enter" &&
						editor.value?.state.selection instanceof NodeSelection
					) {
						const node = editor.value.state.selection.node;
						const entity = node.type.name === "entity" ? node.attrs.entity : null;
						if (entity?.version === 1) {
							event.preventDefault();
							activateEntity(entity.entityId);
							return true;
						}
					}
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
				if (entityMenu.value) {
					if (event.key === "Escape") {
						dismissEntityMenu();
						return true;
					}
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						entityIndex.value =
							(entityIndex.value + (event.key === "ArrowDown" ? 1 : -1) +
								Math.max(1, entityChoiceCount.value)) %
							Math.max(1, entityChoiceCount.value);
						setEntityAutocomplete(true);
						return true;
					}
					if (event.key === "Enter" || event.key === "Tab") {
						const entity = entityMatches.value[entityIndex.value];
						const createSelected = !entity &&
							entityMenu.value.trigger === "#" && !!entityMenu.value.query &&
							entityIndex.value === entityMatches.value.length;
						if (!entity && !createSelected) {
							return false;
						}
						event.preventDefault();
						if (entity) insertCanonicalEntity(entity);
						else void beginEntityCreate();
						return true;
					}
				}
				if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
					event.preventDefault();
					openPalette();
					return true;
				}
				if (paletteOpen.value) {
					if (event.key === "Escape") {
						paletteOpen.value = false;
						return true;
					}
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						paletteIndex.value =
							(paletteIndex.value + (event.key === "ArrowDown" ? 1 : -1) +
								Math.max(1, commandMatches.value.length)) %
							Math.max(1, commandMatches.value.length);
						return true;
					}
					if (event.key === "Enter" && commandMatches.value[paletteIndex.value]) {
						event.preventDefault();
						void runCommand(commandMatches.value[paletteIndex.value]!);
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
	void updateEntityMenu(entityComposerKey.getState(editor.value.state) ?? null);
	pendingExternalEntities.splice(0).forEach((entity) => {
		editor.value?.chain().focus().insertContent({
			type: "entity",
			attrs: { entity },
		}).run();
	});
  loading.value = false;
};
onMounted(() => {
	window.addEventListener("beforeunload", warnBeforeLeaving);
	window.addEventListener("e2-insert-entity", insertExternalEntity);
	void loadToday();
});
onBeforeUnmount(() => {
	window.removeEventListener("beforeunload", warnBeforeLeaving);
	window.removeEventListener("e2-insert-entity", insertExternalEntity);
  saver?.dispose();
  editor.value?.destroy();
});
</script>

<template>
	<div :class="['app-shell', { 'document-editor': props.embedded }]">
		<header v-if="!props.embedded" class="app-header">
			<a class="wordmark" href="/" aria-label="Apsides today"
				><svg aria-hidden="true" viewBox="0 0 24 24">
					<path
						d="M6 3h11a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M8 3v18 M11 8h5 M11 12h5"
					/></svg
				>Apsides <span>{{ props.title }}</span></a
			>
			<div class="file-actions">
				<a href="/admin/oauth">Accounts</a>
        <a href="/admin/google">Contacts &amp; events</a>
        <button type="button" @click="openPalette">Commands <kbd>⌘K</kbd></button>
        <button :disabled="!editor || saveBlocked || saveState === 'conflict'" @click="requestNewNote">Clear today</button>
				<button :disabled="importing || !editor || saveBlocked || saveState === 'conflict'" @click="fileInput?.click()">
					{{ importing ? "Opening…" : "Open note" }}
				</button>
				<button class="primary" :disabled="!editor" @click="exportNote">
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
		<div v-if="props.embedded && props.showFileActions" class="embedded-file-actions" aria-label="Document actions">
			<button type="button" @click="openPalette">Commands <kbd>⌘K</kbd></button>
			<button :disabled="!editor || saveBlocked || saveState === 'conflict'" @click="requestNewNote">Clear today</button>
			<button :disabled="importing || !editor || saveBlocked || saveState === 'conflict'" @click="fileInput?.click()">
				{{ importing ? "Opening…" : "Open note" }}
			</button>
			<button class="primary" :disabled="!editor" @click="exportNote">Export note <span aria-hidden="true">↗</span></button>
			<input
				ref="fileInput"
				class="file-input"
				type="file"
				accept=".native-note,.json,application/json"
				aria-label="Open portable note file"
				@change="importNote"
			/>
		</div>
		<div class="document-meta">
			<span class="filename">{{ dayLabel }}</span
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
			<button v-if="saveBlocked && !loading" @click="loadToday">Try loading again</button
      ><button v-if="saveState === 'error'" @click="saver?.retry()">Retry saving</button
      ><button v-if="editor" @click="exportNote">Export your changes</button>
		</div>
		<div class="today-layout">
			<main :id="props.embedded ? undefined : 'main'">
				<h1 v-if="props.showHeading" ref="heading" class="today-heading" tabindex="-1">{{ props.title }}</h1>
        <p v-if="loading" role="status">Opening your note…</p>
				<EditorContent v-if="editor" :editor="editor" />
				<div v-else-if="loading" class="loading-note" aria-label="Loading editor">
					<div />
					<div />
					<div />
				</div>
			</main>
			<TodaySidebar v-if="props.showSidebar" :date="dayBounds.date" :from="dayBounds.from" :to="dayBounds.to" />
		</div>
		<footer v-if="!props.embedded">
			<span>Type <kbd>/</kbd> for blocks or <kbd>#</kbd> to link</span
			><span>Your note saves after the first edit.</span>
		</footer>
		<dialog
			ref="replaceNoteDialog"
			class="new-note-dialog"
			aria-labelledby="new-note-heading"
			@close="pendingReplacement = undefined"
		>
			<h2 id="new-note-heading">{{ pendingReplacement?.kind === 'import' ? 'Open this note?' : 'Clear today’s note?' }}</h2>
			<p v-if="pendingReplacement?.kind === 'import'">Opening {{ pendingReplacement.filename }} will replace today’s note.</p>
			<p>Export the current note first to keep a copy. Replacing it clears its undo history.</p>
			<div>
				<button @click="replaceNoteDialog?.close()">Keep editing</button
				><button @click="exportNote">Export current note</button
				><button class="primary" @click="confirmReplacement">{{ pendingReplacement?.kind === 'import' ? 'Open note' : 'Clear today' }}</button>
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
			v-if="entityMenu"
			id="entity-composer-listbox"
			class="block-menu entity-menu"
			:role="entityCreateMode ? 'dialog' : 'listbox'"
			:aria-label="entityCreateMode ? 'Create an entity' : entityMenu.trigger === '@' ? 'Mention a person' : 'Link or create an entity'"
			:style="{ left: `${entityMenu.x}px`, top: `${entityMenu.y}px` }"
		>
			<template v-if="!entityCreateMode">
				<div class="menu-title">{{ entityMenu.trigger === "@" ? "Mention a person" : "Link or create an entity" }}</div>
				<p v-if="entitySearchLoading" class="menu-empty" role="status">Searching entities…</p>
				<p v-else-if="entitySearchError" class="menu-empty" role="alert">{{ entitySearchError }}</p>
				<button
					v-for="(entity, index) in entityMatches"
					:id="`entity-composer-option-${index}`"
					:key="entity.id"
					role="option"
					tabindex="-1"
					:aria-selected="index === entityIndex"
					@mousedown.prevent="insertCanonicalEntity(entity)"
				>
					<span class="block-icon">{{ entityMenu.trigger }}</span>
					<span><strong>{{ entity.label }}</strong><small>{{ entity.rootId.replace(/^base:/, "") }}</small></span>
				</button>
				<button
					v-if="entityMenu.trigger === '#' && entityMenu.query"
					:id="`entity-composer-option-${entityMatches.length}`"
					role="option"
					tabindex="-1"
					:aria-selected="entityIndex === entityMatches.length"
					@mousedown.prevent="beginEntityCreate"
				>
					<span class="block-icon">＋</span>
					<span><strong>Create “{{ entityMenu.query }}”</strong><small>Choose a Supertag</small></span>
				</button>
				<p v-if="!entitySearchLoading && !entitySearchError && !entityMatches.length && entityMenu.trigger === '@'" class="menu-empty">No matching people</p>
			</template>
			<form v-else class="entity-create" @submit.prevent="createEntityFromMenu" @keydown.esc.prevent="cancelEntityCreate">
				<div class="menu-title">Create “{{ entityMenu.query }}”</div>
				<label for="entity-supertag">Supertag</label>
				<select id="entity-supertag" ref="entityTagSelect" v-model="entityTagId" :disabled="entityCreating || !entityTags.length">
					<option value="" disabled>Choose a Supertag</option>
					<option v-for="tag in entityTags" :key="tag.id" :value="tag.id">{{ tag.name }}{{ tag.kind === "base" ? " (base)" : "" }}</option>
				</select>
				<p v-if="entityCreateError" class="menu-empty" role="alert">{{ entityCreateError }}</p>
				<div class="entity-create-actions">
					<button type="button" :disabled="entityCreating" @click="cancelEntityCreate">Back</button>
					<button class="primary" type="submit" :disabled="entityCreating || !entityTagId">{{ entityCreating ? "Creating…" : "Create entity" }}</button>
				</div>
			</form>
		</div>
		<div v-if="paletteOpen" class="palette-backdrop" @mousedown.self="paletteOpen = false">
			<div class="block-menu command-palette" role="dialog" aria-label="Command palette">
				<div class="menu-title"><span>Command palette</span><button type="button" aria-label="Close command palette" @click="paletteOpen = false">×</button></div>
				<input ref="paletteInput" v-model="paletteQuery" aria-label="Search commands" placeholder="Search commands…" @keydown="paletteKey" />
				<button
					v-for="(command, index) in commandMatches"
					:key="command.id"
					:aria-selected="index === paletteIndex"
					@click="runCommand(command)"
				>
					<span class="block-icon">⌘</span><span><strong>{{ command.label }}</strong><small>{{ command.detail }}</small></span>
				</button>
				<p v-if="!commandMatches.length" class="menu-empty">No commands match that search.</p>
			</div>
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
