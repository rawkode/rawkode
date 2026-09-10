<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
	elementBounds,
	elementPath,
	inks,
	type DrawingDocument,
	type DrawingElement,
	type DrawingInk,
	type DrawingKind,
	type DrawingPoint,
} from "../lib/component";

const props = defineProps<{ document: DrawingDocument }>();
const emit = defineEmits<{ save: [document: DrawingDocument]; cancel: [] }>();
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const drawing = ref<DrawingDocument>(copy(props.document));
const tool = ref<DrawingKind | "select">("pen");
const ink = ref<DrawingInk>("graphite");
const text = ref("New text");
const selected = ref<string>();
const active = ref<DrawingElement>();
const canvas = ref<SVGSVGElement>();
const undo = ref<DrawingDocument[]>([]),
	redo = ref<DrawingDocument[]>([]);
const selectedElement = computed(() =>
	drawing.value.elements.find((element) => element.id === selected.value),
);
const selectedBounds = computed(() =>
	selectedElement.value ? elementBounds(selectedElement.value) : undefined,
);
watch(selectedElement, (element) => {
	if (element?.kind === "text") text.value = element.text;
});
let gesture:
	| {
			start: DrawingPoint;
			original?: DrawingElement;
			before: DrawingDocument;
			pointerId: number;
	  }
	| undefined;
const tools: { value: DrawingKind | "select"; label: string }[] = [
	{ value: "select", label: "Select" },
	{ value: "pen", label: "Pen" },
	{ value: "rectangle", label: "Rectangle" },
	{ value: "ellipse", label: "Ellipse" },
	{ value: "arrow", label: "Arrow" },
	{ value: "text", label: "Text" },
];

const checkpoint = (before: DrawingDocument) => {
	if (JSON.stringify(before) === JSON.stringify(drawing.value)) return;
	undo.value = [...undo.value.slice(-99), before];
	redo.value = [];
};
const undoChange = () => {
	const previous = undo.value.pop();
	if (!previous) return;
	redo.value.push(copy(drawing.value));
	drawing.value = previous;
	selected.value = undefined;
};
const redoChange = () => {
	const next = redo.value.pop();
	if (!next) return;
	undo.value.push(copy(drawing.value));
	drawing.value = next;
	selected.value = undefined;
};
const deleteSelected = () => {
	if (!selectedElement.value) return;
	const before = copy(drawing.value);
	drawing.value.elements = drawing.value.elements.filter(
		(element) => element.id !== selected.value,
	);
	selected.value = undefined;
	checkpoint(before);
};
const point = (event: PointerEvent): DrawingPoint => {
	const matrix = canvas.value?.getScreenCTM();
	const transformed = matrix
		? new DOMPoint(event.clientX, event.clientY).matrixTransform(
				matrix.inverse(),
			)
		: new DOMPoint();
	return {
		x: Math.min(900, Math.max(0, transformed.x)),
		y: Math.min(420, Math.max(0, transformed.y)),
	};
};
const hit = (element: DrawingElement, point: DrawingPoint): boolean => {
	const bounds = elementBounds(element);
	if (!["pen", "arrow"].includes(element.kind))
		return (
			point.x >= bounds.x - 8 &&
			point.x <= bounds.x + bounds.width + 8 &&
			point.y >= bounds.y - 8 &&
			point.y <= bounds.y + bounds.height + 8
		);
	const points = element.points;
	return points.some((start, index) => {
		const end = points[index + 1] ?? start;
		const dx = end.x - start.x,
			dy = end.y - start.y;
		const t = Math.max(
			0,
			Math.min(
				1,
				((point.x - start.x) * dx + (point.y - start.y) * dy) /
					(dx * dx + dy * dy || 1),
			),
		);
		return (
			Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy) <=
			Math.max(8, element.lineWidth)
		);
	});
};
const moveElement = (
	element: DrawingElement,
	dx: number,
	dy: number,
): DrawingElement => {
	const bounds = elementBounds(element);
	const x = Math.min(
		Math.max(dx, -bounds.x),
		Math.max(0, 900 - bounds.x - bounds.width),
	);
	const y = Math.min(
		Math.max(dy, -bounds.y),
		Math.max(0, 420 - bounds.y - bounds.height),
	);
	return {
		...element,
		points: element.points.map((point) => ({ x: point.x + x, y: point.y + y })),
	};
};
const pointerDown = (event: PointerEvent) => {
	if (event.button !== 0 || gesture) return;
	event.preventDefault();
	canvas.value?.focus();
	const start = point(event),
		before = copy(drawing.value);
	canvas.value?.setPointerCapture(event.pointerId);
	if (tool.value === "select") {
		const element = [...drawing.value.elements]
			.reverse()
			.find((element) => hit(element, start));
		selected.value = element?.id;
		gesture = {
			start,
			before,
			pointerId: event.pointerId,
			original: element ? copy(element) : undefined,
		};
	} else if (tool.value === "text") {
		if (!text.value.trim()) {
			canvas.value?.releasePointerCapture(event.pointerId);
			return;
		}
		const element: DrawingElement = {
			id: crypto.randomUUID(),
			kind: "text",
			ink: ink.value,
			points: [start],
			text: text.value,
			lineWidth: 3,
		};
		drawing.value.elements.push(element);
		selected.value = element.id;
		checkpoint(before);
		canvas.value?.releasePointerCapture(event.pointerId);
	} else {
		selected.value = undefined;
		active.value = {
			id: crypto.randomUUID(),
			kind: tool.value,
			ink: ink.value,
			points: [start],
			text: "",
			lineWidth: 3,
		};
		gesture = { start, before, pointerId: event.pointerId };
	}
};
const pointerMove = (event: PointerEvent) => {
	if (!gesture || gesture.pointerId !== event.pointerId) return;
	const current = point(event);
	if (active.value) {
		if (active.value.kind === "pen") active.value.points.push(current);
		else active.value.points = [gesture.start, current];
	} else if (gesture.original) {
		const moved = moveElement(
			gesture.original,
			current.x - gesture.start.x,
			current.y - gesture.start.y,
		);
		drawing.value.elements = drawing.value.elements.map((element) =>
			element.id === moved.id ? moved : element,
		);
	}
};
const pointerUp = (event: PointerEvent) => {
	if (!gesture || gesture.pointerId !== event.pointerId) return;
	pointerMove(event);
	if (active.value) drawing.value.elements.push(active.value);
	active.value = undefined;
	checkpoint(gesture.before);
	gesture = undefined;
	canvas.value?.releasePointerCapture(event.pointerId);
};
const pointerCancel = () => {
	if (gesture) drawing.value = gesture.before;
	gesture = undefined;
	active.value = undefined;
};
const selectElement = (event: Event) => {
	selected.value = (event.target as HTMLSelectElement).value || undefined;
	tool.value = "select";
};
const setInk = (value: DrawingInk) => {
	ink.value = value;
	if (!selectedElement.value || tool.value !== "select") return;
	const before = copy(drawing.value);
	selectedElement.value.ink = value;
	checkpoint(before);
};
const renameSelected = () => {
	if (selectedElement.value?.kind !== "text") return;
	const before = copy(drawing.value);
	selectedElement.value.text = text.value;
	checkpoint(before);
};
const keydown = (event: KeyboardEvent) => {
	if (event.key === "Escape") {
		event.preventDefault();
		emit("cancel");
		return;
	}
	if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
		event.preventDefault();
		emit("save", copy(drawing.value));
		return;
	}
	const target = event.target as HTMLElement;
	if (target.matches("input,textarea,select")) return;
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
		event.preventDefault();
		event.shiftKey ? redoChange() : undoChange();
		return;
	}
	if (event.key === "Delete" || event.key === "Backspace") {
		event.preventDefault();
		deleteSelected();
		return;
	}
	const vectors: Record<string, [number, number]> = {
		ArrowLeft: [-1, 0],
		ArrowRight: [1, 0],
		ArrowUp: [0, -1],
		ArrowDown: [0, 1],
	};
	const vector = vectors[event.key];
	if (vector && selectedElement.value) {
		event.preventDefault();
		const before = copy(drawing.value),
			amount = event.shiftKey ? 10 : 1;
		const moved = moveElement(
			selectedElement.value,
			vector[0] * amount,
			vector[1] * amount,
		);
		drawing.value.elements = drawing.value.elements.map((element) =>
			element.id === moved.id ? moved : element,
		);
		checkpoint(before);
	}
};
const visibleElements = computed(() =>
	active.value
		? [...drawing.value.elements, active.value]
		: drawing.value.elements,
);
</script>

<template>
	<div class="drawing-editor" @keydown.stop="keydown">
		<div class="drawing-tools" role="toolbar" aria-label="Drawing tools">
			<button
				v-for="item in tools"
				:key="item.value"
				type="button"
				:aria-pressed="tool === item.value"
				@click="tool = item.value"
			>
				{{ item.label }}
			</button>
			<span class="separator" aria-hidden="true"></span>
			<button type="button" :disabled="!undo.length" @click="undoChange">
				Undo
			</button>
			<button type="button" :disabled="!redo.length" @click="redoChange">
				Redo
			</button>
			<button
				type="button"
				:disabled="!selectedElement"
				@click="deleteSelected"
			>
				Delete
			</button>
		</div>
		<div class="drawing-options">
			<div class="ink-options" role="group" aria-label="Ink color">
				<button
					v-for="(color, name) in inks"
					:key="name"
					type="button"
					:aria-label="`${name} ink`"
					:aria-pressed="ink === name"
					:style="{ '--swatch': color }"
					@click="setInk(name)"
				>
					{{ ink === name ? "✓" : "" }}
				</button>
			</div>
			<label
				v-if="tool === 'text' || selectedElement?.kind === 'text'"
				class="text-option"
				>Text
				<input
					v-model="text"
					maxlength="500"
					aria-label="Drawing text"
				/><button
					v-if="selectedElement?.kind === 'text'"
					type="button"
					@click="renameSelected"
				>
					Update text
				</button></label
			>
			<label class="element-option"
				>Select element
				<select :value="selected ?? ''" @change="selectElement">
					<option value="">None</option>
					<option
						v-for="(element, index) in drawing.elements"
						:key="element.id"
						:value="element.id"
					>
						{{ index + 1 }}. {{ element.kind
						}}{{ element.text ? `: ${element.text.slice(0, 30)}` : "" }}
					</option>
				</select>
			</label>
		</div>
		<svg
			ref="canvas"
			class="drawing-canvas"
			viewBox="0 0 900 420"
			tabindex="0"
			role="img"
			:aria-label="`Editable drawing with ${drawing.elements.length} elements. Select an element above and use arrow keys to move it.`"
			@pointerdown="pointerDown"
			@pointermove="pointerMove"
			@pointerup="pointerUp"
			@pointercancel="pointerCancel"
		>
			<g
				v-for="element in visibleElements"
				:key="element.id"
				:stroke="inks[element.ink]"
				:stroke-width="element.lineWidth"
				stroke-linecap="round"
				stroke-linejoin="round"
				fill="none"
			>
				<rect
					v-if="element.kind === 'rectangle'"
					v-bind="elementBounds(element)"
					rx="10"
				/>
				<ellipse
					v-else-if="element.kind === 'ellipse'"
					:cx="elementBounds(element).x + elementBounds(element).width / 2"
					:cy="elementBounds(element).y + elementBounds(element).height / 2"
					:rx="elementBounds(element).width / 2"
					:ry="elementBounds(element).height / 2"
				/>
				<text
					v-else-if="element.kind === 'text' && element.points[0]"
					:x="element.points[0].x"
					:y="element.points[0].y + 21"
					:fill="inks[element.ink]"
					stroke="none"
					font-size="21"
					font-weight="500"
					font-family="system-ui,sans-serif"
				>
					{{ element.text }}
				</text>
				<path v-else :d="elementPath(element)" />
			</g>
			<rect
				v-if="selectedBounds"
				:x="selectedBounds.x - 8"
				:y="selectedBounds.y - 8"
				:width="selectedBounds.width + 16"
				:height="selectedBounds.height + 16"
				rx="5"
				fill="none"
				stroke="var(--primary)"
				stroke-width="1.5"
				stroke-dasharray="5 4"
			/>
		</svg>
		<p class="drawing-hint">
			{{
				tool === "text"
					? "Enter text above, then click the canvas to place it."
					: tool === "select"
						? "Select and drag an element. Arrow keys move it; Shift moves 10 points."
						: "Drag on the canvas to draw. Your changes stay here until you save."
			}}
		</p>
		<div class="drawing-actions">
			<button type="button" @click="emit('cancel')">Cancel</button
			><button
				type="button"
				class="primary"
				@click="emit('save', copy(drawing))"
			>
				Save drawing
			</button>
		</div>
	</div>
</template>

<style scoped>
.drawing-editor {
	display: block;
}
.drawing-tools,
.drawing-options,
.ink-options,
.drawing-actions,
.text-option,
.element-option {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 0.375rem;
}
.drawing-tools {
	padding-bottom: 0.65rem;
	border-bottom: 1px solid var(--line);
}
.drawing-options {
	gap: 1rem;
	margin: 0.75rem 0;
	font-size: 0.8rem;
}
.drawing-tools button,
.drawing-actions button,
.text-option button {
	background: var(--surface);
	border: 1px solid var(--line);
	border-radius: 5px;
	padding: 0.35rem 0.6rem;
	color: var(--ink);
	font: inherit;
	font-size: 0.8rem;
	cursor: pointer;
}
button:hover {
	background: color-mix(in oklch, var(--primary) 8%, var(--surface));
}
.drawing-tools button[aria-pressed="true"] {
	color: var(--primary);
	border-color: var(--primary);
}
button:disabled {
	opacity: 0.45;
	cursor: not-allowed;
}
button:focus-visible,
input:focus-visible,
select:focus-visible,
.drawing-canvas:focus-visible {
	outline: 2px solid var(--primary);
	outline-offset: 3px;
}
.separator {
	width: 1px;
	height: 1.1rem;
	margin: 0 0.3rem;
	background: var(--line);
}
.ink-options button {
	width: 1.7rem;
	height: 1.7rem;
	border: 0;
	background: var(--swatch);
	border-radius: 50%;
	color: white;
	font-weight: 700;
	cursor: pointer;
}
input,
select {
	background: var(--surface);
	color: var(--ink);
	border: 1px solid var(--line);
	border-radius: 4px;
	padding: 0.35rem;
	font: inherit;
	max-width: 15rem;
}
.drawing-canvas {
	width: 100%;
	display: block;
	background: white;
	border: 1px solid var(--line);
	border-radius: 6px;
	touch-action: none;
	cursor: crosshair;
}
.drawing-hint {
	color: var(--muted);
	font-size: 0.8rem;
	margin: 0.5rem 0 1rem;
}
.drawing-actions {
	justify-content: flex-end;
}
.drawing-actions .primary {
	background: var(--primary);
	color: white;
	border-color: var(--primary);
}
</style>
