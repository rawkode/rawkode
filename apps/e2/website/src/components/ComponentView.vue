<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { NodeViewWrapper, nodeViewProps } from "@tiptap/vue-3";
import type Hls from "hls.js";
import DrawingEditor from "./DrawingEditor.vue";
import {
	drawingSVG,
	playback,
	svgImage,
	webURL,
	type DrawingDocument,
	type LinkMetadata,
	type NoteComponent,
} from "../lib/component";
import { renderDiagram } from "../lib/diagram";
import { parseComponent } from "@e2/documents/note";

const props = defineProps(nodeViewProps);
const component = computed(() => props.node.attrs.component as NoteComponent);
const kindLabel = computed(
	() =>
		({ diagram: "D2", mermaid: "Mermaid", drawing: "Drawing", link: "Link" })[
			component.value.kind
		],
);
const isDiagram = computed(
	() =>
		component.value.kind === "diagram" || component.value.kind === "mermaid",
);
const editing = ref(false),
	busy = ref(false),
	error = ref("");
const title = ref(""),
	source = ref(""),
	draftMetadata = ref<LinkMetadata>();
const renderedSVG = ref<string>(),
	renderedSource = ref<string>();
const localSVG = ref<string>(),
	previewError = ref(""),
	previewBusy = ref(false);
const sourceInput = ref<HTMLTextAreaElement | HTMLInputElement>();
const editButton = ref<HTMLButtonElement>();
const loadingImage = ref(false),
	playing = ref(false),
	video = ref<HTMLVideoElement>();
const playerError = ref("");
let hls: Hls | undefined;
let renderGeneration = 0,
	previewGeneration = 0,
	playerGeneration = 0;

let mediaProbeAbort: AbortController | undefined;
const preview = computed(() => {
	if (component.value.kind === "drawing")
		return svgImage(drawingSVG(component.value.drawing ?? { elements: [] }));
	return svgImage(component.value.svg || localSVG.value);
});
const media = computed(() => playback(component.value.metadata));
const safeLink = computed(() => webURL(component.value.source));
const linkHostname = computed(() =>
	safeLink.value ? new URL(safeLink.value).hostname : "",
);
const remoteImage = computed(() =>
	loadingImage.value ? webURL(component.value.metadata?.imageURL) : undefined,
);
const canSaveDiagram = computed(
	() =>
		!busy.value &&
		renderedSVG.value !== undefined &&
		renderedSource.value === source.value,
);
const dirtyDiagram = computed(() => renderedSource.value !== source.value);

watch(
	() => [component.value.kind, component.value.source, component.value.svg],
	async () => {
		const generation = ++previewGeneration;
		localSVG.value = undefined;
		previewError.value = "";
		previewBusy.value = false;
		if (
			!isDiagram.value ||
			component.value.svg ||
			!component.value.source.trim()
		)
			return;
		const { kind, source } = component.value;
		previewBusy.value = true;
		try {
			const svg = await renderDiagram(kind as "diagram" | "mermaid", source);
			if (generation === previewGeneration) localSVG.value = svg;
		} catch (cause) {
			if (generation === previewGeneration) previewError.value = message(cause);
		} finally {
			if (generation === previewGeneration) previewBusy.value = false;
		}
	},
	{ immediate: true },
);

watch(
	() => component.value.metadata?.playback,
	() => stopPlayback(),
);

const message = (cause: unknown) => {
	return cause instanceof Error ? cause.message : String(cause);
};
const beginEdit = async () => {
	stopPlayback();
	title.value = component.value.title;
	source.value = component.value.source;
	draftMetadata.value = component.value.metadata
		? JSON.parse(JSON.stringify(component.value.metadata))
		: undefined;
	renderedSVG.value = component.value.svg || localSVG.value;
	renderedSource.value = renderedSVG.value ? component.value.source : undefined;
	error.value = "";
	editing.value = true;
	await nextTick();
	sourceInput.value?.focus();
};
const closeEditor = async () => {
	renderGeneration++;
	
	busy.value = false;
	editing.value = false;
	await nextTick();
	editButton.value?.focus();
};
const saveComponent = (update: Partial<NoteComponent>) => {
	try {
		props.updateAttributes({ component: parseComponent({ ...component.value, ...update }) });
		closeEditor();
	} catch (cause) {
		error.value = message(cause);
	}
};
const renderDraft = async () => {
	if (!isDiagram.value) return;
	const generation = ++renderGeneration,
		input = source.value;
	busy.value = true;
	error.value = "";
	try {
		const svg = await renderDiagram(
			component.value.kind as "diagram" | "mermaid",
			input,
		);
		if (generation !== renderGeneration || !editing.value) return;
		renderedSVG.value = svg;
		renderedSource.value = input;
	} catch (cause) {
		if (generation === renderGeneration) error.value = message(cause);
	} finally {
		if (generation === renderGeneration) busy.value = false;
	}
};
const saveDiagram = () => {
	if (!canSaveDiagram.value) return;
	saveComponent({
		title: title.value.trim() || kindLabel.value,
		source: source.value,
		svg: renderedSVG.value,
	});
};
const saveDrawing = (document: DrawingDocument) => {
	saveComponent({ title: title.value.trim() || "Drawing", drawing: document });
};
const linkSourceChanged = () => {
	draftMetadata.value = undefined;
	
	
	busy.value = false;
	error.value = "";
};
const saveLink = () => {
	const url = webURL(source.value.trim());
	if (!url) {
		error.value = "Enter an HTTP or HTTPS URL without a username or password.";
		return;
	}
	saveComponent({
		title:
			title.value.trim() || draftMetadata.value?.title || new URL(url).hostname,
		source: url,
		metadata: draftMetadata.value,
	});
};
const stopPlayback = () => {
	playerGeneration++;
	hls?.destroy();
	hls = undefined;
	mediaProbeAbort?.abort();
	if (video.value) {
		video.value.pause();
		video.value.removeAttribute("src");
		video.value.load();
	}
	playing.value = false;
	playerError.value = "";
};
const play = async () => {
	if (!media.value) return;
	const item = media.value;
	if (
		item.kind === "embed" &&
		new URL(item.url).origin === window.location.origin
	) {
		playerError.value =
			"Embedded players must be hosted outside this editor. Open the original link instead.";
		return;
	}
	playing.value = true;
	playerError.value = "";
	const generation = ++playerGeneration;
	await nextTick();
	if (item.kind !== "video" || !video.value) return;
	const element = video.value;
	try {
		// Native HLS is preferred; MSE supplies the same generic direct-media path elsewhere.
		const nativeHLS = Boolean(
			element.canPlayType("application/vnd.apple.mpegurl"),
		);
		let isHLS = new URL(item.url).pathname.toLowerCase().endsWith(".m3u8");
		// The shared playback union has no MIME field.
		// Probe extensionless streams after Play, without making CORS a prerequisite
		// for ordinary video URLs that the browser can play directly.
		if (!nativeHLS && !isHLS) {
			const controller = new AbortController();
			mediaProbeAbort = controller;
			const timeout = window.setTimeout(() => controller.abort(), 3_000);
			try {
				const response = await fetch(item.url, {
					method: "HEAD",
					credentials: "omit",
					signal: controller.signal,
				});
				isHLS =
					/(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)/i.test(
						response.headers.get("content-type") ?? "",
					);
			} catch {
				/* Native video loading may work even when a CORS probe does not. */
			} finally {
				window.clearTimeout(timeout);
			}
		}
		if (generation !== playerGeneration) return;
		if (isHLS && !nativeHLS) {
			const { default: HLS } = await import("hls.js");
			if (generation !== playerGeneration) return;
			if (!HLS.isSupported())
				throw new Error(
					"This browser cannot play this HLS stream. Open the original link instead.",
				);
			hls = new HLS({ enableWorker: true });
			hls.on(HLS.Events.ERROR, (_event, data) => {
				if (data.fatal && generation === playerGeneration)
					playerError.value = `Playback failed (${data.details}). The site may require permission or disallow playback here.`;
			});
			hls.loadSource(item.url);
			hls.attachMedia(element);
		} else element.src = item.url;
		await element.play();
	} catch (cause) {
		if (generation === playerGeneration) playerError.value = message(cause);
	}
};
const videoFailed = () => {
	if (playing.value)
		playerError.value =
			video.value?.error?.message ||
			"The video could not be loaded. Try the original link; it may require permission or a different format.";
};
const editorKey = (event: KeyboardEvent) => {
	if (event.key === "Escape") {
		event.preventDefault();
		closeEditor();
	}
	if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
		event.preventDefault();
		if (isDiagram.value) {
			if (canSaveDiagram.value) saveDiagram();
			else if (!busy.value) renderDraft();
		} else if (component.value.kind === "link") saveLink();
	}
};
onBeforeUnmount(() => {
	previewGeneration++;
	renderGeneration++;
	
	stopPlayback();
});
</script>

<template>
	<NodeViewWrapper
		as="span"
		class="note-component"
		:class="{ 'is-selected': selected }"
		contenteditable="false"
		:data-component-id="component.id"
	>
		<span class="component-heading" data-component-ui>
			<span
				><span class="component-kind">{{ kindLabel }}</span
				><strong>{{ component.title }}</strong></span
			>
			<button v-if="!editing" ref="editButton" type="button" @click="beginEdit">
				{{
					isDiagram
						? "Edit source"
						: component.kind === "drawing"
							? "Edit drawing"
							: "Edit link"
				}}
			</button>
		</span>
		<span
			v-if="editing"
			class="component-editor"
			data-component-ui
			@keydown.stop="editorKey"
			@input.stop
			@paste.stop
			@mousedown.stop
		>
			<label class="field"
				>Title<input
					v-model="title"
					aria-label="Component title"
					maxlength="300"
			/></label>
			<template v-if="isDiagram">
				<label class="field"
					>{{ kindLabel }} source<textarea
						ref="sourceInput"
						v-model="source"
						rows="8"
						spellcheck="false"
						autocapitalize="off"
						autocorrect="off"
						:aria-label="`${kindLabel} source`"
					></textarea>
				</label>
				<span class="draft-controls"
					><button type="button" :disabled="busy" @click="renderDraft">
						{{ busy ? "Rendering…" : "Render preview" }}</button
					><span v-if="dirtyDiagram" class="hint"
						>Render the current source before saving.</span
					></span
				>
				<img
					v-if="renderedSVG"
					class="diagram-image draft-image"
					:src="svgImage(renderedSVG)"
					:alt="`Preview of ${title || kindLabel}`"
				/>
				<p v-if="error" class="component-error" role="alert">{{ error }}</p>
				<span class="component-actions"
					><button type="button" @click="closeEditor">Cancel</button
					><button
						type="button"
						class="primary"
						:disabled="!canSaveDiagram"
						@click="saveDiagram"
					>
						Save diagram
					</button></span
				>
			</template>
			<DrawingEditor
				v-else-if="component.kind === 'drawing'"
				:document="component.drawing ?? { elements: [] }"
				@save="saveDrawing"
				@cancel="closeEditor"
			/>
			<template v-else>
				<label class="field"
					>URL<input
						ref="sourceInput"
						v-model="source"
						type="url"
						placeholder="https://example.com"
						aria-label="Link URL"
						@input="linkSourceChanged"
				/></label>
				<p class="hint">Automatic previews are not available yet. Add a title and save the link.</p>
				<span v-if="draftMetadata" class="metadata-result"
					><strong>{{ draftMetadata.title }}</strong
					><span v-if="draftMetadata.summary">{{ draftMetadata.summary }}</span
					><span class="hint">{{
						playback(draftMetadata)
							? "Video playback is available."
							: draftMetadata.discoveryNote ||
								"Saved as a link preview. No playable video was advertised."
					}}</span></span
				>
				<p v-if="error" class="component-error" role="alert">{{ error }}</p>
				<span class="component-actions"
					><button type="button" @click="closeEditor">Cancel</button
					><button
						type="button"
						class="primary"
						:disabled="!webURL(source.trim())"
						@click="saveLink"
					>
						Save link
					</button></span
				>
			</template>
			<p v-if="error && component.kind === 'drawing'" class="component-error" role="alert">{{ error }}</p>
		</span>
		<template v-else-if="isDiagram || component.kind === 'drawing'">
			<button
				v-if="preview"
				type="button"
				class="preview-button"
				:aria-label="`Edit ${component.title}`"
				data-component-ui
				@click="beginEdit"
			>
				<img
					:src="preview"
					:class="
						component.kind === 'drawing' ? 'drawing-image' : 'diagram-image'
					"
					:alt="
						component.kind === 'drawing'
							? `${component.title}, ${component.drawing?.elements.length ?? 0} elements`
							: component.title
					"
				/>
			</button>
			<span v-else class="empty-preview" :aria-busy="previewBusy"
				><span v-if="previewBusy">Rendering {{ kindLabel }}…</span
				><span v-else-if="previewError" role="status">{{ previewError }}</span
				><span v-else>Choose Edit source to add a diagram.</span></span
			>
		</template>
		<span v-else class="link-preview" data-component-ui>
			<span v-if="playing && media" class="media-area">
				<video
					v-if="media.kind === 'video'"
					ref="video"
					controls
					playsinline
					preload="none"
					:aria-label="component.title"
					@error="videoFailed"
				></video>
				<iframe
					v-else
					:src="media.url"
					:title="component.title"
					sandbox="allow-scripts allow-same-origin allow-presentation"
					allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
					allowfullscreen
					referrerpolicy="strict-origin-when-cross-origin"
				></iframe>
			</span>
			<img
				v-else-if="remoteImage"
				class="link-image"
				:src="remoteImage"
				alt=""
				referrerpolicy="no-referrer"
				@error="loadingImage = false"
			/>
			<p v-if="component.metadata?.summary" class="link-summary">
				{{ component.metadata.summary }}
			</p>
			<span class="link-controls">
				<button
					v-if="media && !playing"
					type="button"
					class="play-button"
					@click="play"
				>
					▶ Play video
				</button>
				<button v-if="playing" type="button" @click="stopPlayback">
					Stop video
				</button>
				<button
					v-if="
						!playing && !loadingImage && webURL(component.metadata?.imageURL)
					"
					type="button"
					@click="loadingImage = true"
				>
					Load preview image
				</button>
				<a
					v-if="safeLink"
					:href="safeLink"
					target="_blank"
					rel="noopener noreferrer"
					>Open {{ linkHostname }} ↗</a
				>
				<span v-else class="hint">Edit this link to add a valid URL.</span>
			</span>
			<p v-if="media && !playing" class="hint privacy-hint">
				The video provider is contacted only when you play.
			</p>
			<p v-if="playerError" class="component-error" role="alert">
				{{ playerError }}
			</p>
			<p v-if="playing && media?.kind === 'embed'" class="hint privacy-hint">
				If this provider blocks embedded playback, use the original link.
			</p>
		</span>
	</NodeViewWrapper>
</template>

<style scoped>
.note-component {
	display: block;
	margin: 1.15rem 0;
	border: 1px solid var(--line);
	border-radius: 8px;
	overflow: clip;
	background: var(--surface);
	font-family: system-ui, sans-serif;
	color: var(--ink);
	white-space: normal;
	font-size: 0.9rem;
	font-weight: 400;
	line-height: 1.45;
}
.note-component.is-selected {
	outline: 2px solid var(--primary);
	outline-offset: 2px;
}
.component-heading {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 1rem;
	padding: 0.65rem 0.9rem;
	border-bottom: 1px solid var(--line);
}
.component-heading > span {
	display: flex;
	align-items: baseline;
	gap: 0.65rem;
	min-width: 0;
}
.component-heading strong {
	font-size: 0.85rem;
	overflow-wrap: anywhere;
	font-weight: 550;
}
.component-kind {
	color: var(--muted);
	font-size: 0.75rem;
	flex-shrink: 0;
}
button {
	font: inherit;
	font-size: 0.8rem;
	color: var(--ink);
	background: var(--surface);
	border: 1px solid var(--line);
	border-radius: 5px;
	padding: 0.35rem 0.65rem;
	cursor: pointer;
}
button:hover {
	background: color-mix(in oklch, var(--primary) 7%, var(--surface));
}
button:disabled {
	opacity: 0.45;
	cursor: not-allowed;
}
button:focus-visible,
input:focus-visible,
textarea:focus-visible,
a:focus-visible {
	outline: 2px solid var(--primary);
	outline-offset: 3px;
}
.component-heading button {
	flex-shrink: 0;
	border: 0;
	color: var(--primary);
}
.preview-button {
	display: block;
	width: 100%;
	padding: 0.8rem;
	background: white;
	border: 0;
	border-radius: 0;
}
.preview-button:focus-visible {
	outline-offset: -3px;
}
.diagram-image {
	display: block;
	width: 100%;
	max-height: 380px;
	object-fit: contain;
	background: white;
}
.drawing-image {
	display: block;
	width: 100%;
	aspect-ratio: 900 / 420;
}
.empty-preview {
	display: block;
	min-height: 6rem;
	padding: 1.5rem;
	color: var(--muted);
	font-size: 0.85rem;
}
.component-editor {
	display: block;
	padding: 0.9rem;
}
.field {
	display: flex;
	flex-direction: column;
	gap: 0.35rem;
	margin-bottom: 0.8rem;
	font-size: 0.8rem;
	font-weight: 550;
}
.field input,
.field textarea {
	border: 1px solid var(--line);
	border-radius: 5px;
	background: var(--surface);
	color: var(--ink);
	padding: 0.6rem 0.7rem;
	width: 100%;
	font: inherit;
	font-weight: 400;
	box-sizing: border-box;
}
.field textarea {
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 0.85rem;
	line-height: 1.55;
	resize: vertical;
	tab-size: 2;
}
.draft-controls,
.component-actions,
.link-controls {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.6rem;
}
.component-actions {
	justify-content: flex-end;
	margin-top: 1rem;
}
.primary {
	background: var(--primary);
	color: var(--on-primary);
	border-color: var(--primary);
}
.draft-image {
	margin-top: 1rem;
	padding: 0.5rem;
	box-sizing: border-box;
}
.hint {
	color: var(--muted);
	font-size: 0.78rem;
	font-weight: 400;
}
.component-error {
	color: var(--error);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	font:
		0.82rem/1.5 ui-monospace,
		monospace;
	margin: 0.8rem 0;
}
.metadata-result {
	display: flex;
	flex-direction: column;
	gap: 0.45rem;
	margin-top: 0.8rem;
	font-size: 0.85rem;
}
.link-preview {
	display: block;
	padding: 0.9rem;
}
.link-summary {
	margin: 0 0 0.75rem;
	font-size: 0.85rem;
}
.link-controls a {
	color: var(--primary);
	text-decoration: none;
	font-size: 0.8rem;
	overflow-wrap: anywhere;
}
.link-controls a:hover {
	text-decoration: underline;
}
.play-button {
	color: var(--primary);
}
.privacy-hint {
	margin: 0.6rem 0 0;
}
.media-area {
	display: block;
	aspect-ratio: 16 / 9;
	background: black;
	margin: -0.9rem -0.9rem 0.9rem;
}
.media-area video,
.media-area iframe {
	display: block;
	width: 100%;
	height: 100%;
	border: 0;
}
.link-image {
	display: block;
	max-width: 100%;
	max-height: 260px;
	object-fit: contain;
	margin: 0 auto 0.9rem;
}
@media (max-width: 500px) {
	.component-heading {
		gap: 0.3rem;
		padding: 0.55rem 0.65rem;
	}
	.component-heading > span {
		flex-wrap: wrap;
		gap: 0.2rem 0.5rem;
	}
	.component-editor {
		padding: 0.65rem;
	}
}
</style>
