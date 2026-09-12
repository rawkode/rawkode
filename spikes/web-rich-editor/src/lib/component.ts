import {
	safeURL,
	type Component,
	type DrawingElement,
	type DrawingDocument,
	type DrawingPoint,
	type DrawingInk,
	type LinkMetadata,
	type Playback,
} from "./note";
export type {
	DrawingElement,
	DrawingDocument,
	DrawingPoint,
	DrawingInk,
	LinkMetadata,
};
export type NoteComponent = Component;
export type ComponentKind = Component["kind"];
export type DrawingKind = DrawingElement["kind"];
export type LinkPlayback = Playback;

export const inks: Record<DrawingInk, string> = {
	graphite: "#20242b",
	blue: "#1766bd",
	purple: "#8544b5",
	orange: "#b65e08",
	green: "#25763f",
	red: "#c23435",
};

export function defaultComponent(kind: ComponentKind): NoteComponent {
	const component: NoteComponent = {
		id: crypto.randomUUID(),
		kind,
		title: {
			diagram: "D2 diagram",
			mermaid: "Mermaid diagram",
			drawing: "Drawing",
			link: "Link",
		}[kind],
		source:
			kind === "diagram"
				? "direction: right\nIdea -> Note: write\nNote -> Diagram: visualize"
				: kind === "mermaid"
					? "flowchart LR\n  Idea --> Note\n  Note --> Diagram"
					: "",
	};
	if (kind === "drawing") component.drawing = { elements: [] };
	return component;
}

export function webURL(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		return safeURL(value);
	} catch {
		return undefined;
	}
}

export function playback(
	metadata: LinkMetadata | undefined,
): { kind: "video" | "embed"; url: string } | undefined {
	const candidate = metadata?.playback;
	if (!candidate) return undefined;
	const url = webURL(candidate.url);
	if (!url) return undefined;
	return { kind: candidate.type === "directVideo" ? "video" : "embed", url };
}

export function elementBounds(element: DrawingElement) {
	const first = element.points[0] ?? { x: 0, y: 0 };
	if (element.kind === "text")
		return {
			x: first.x,
			y: first.y,
			width: Math.max(36, element.text.length * 12),
			height: 30,
		};
	const xs = element.points.map((point) => point.x),
		ys = element.points.map((point) => point.y);
	const x = xs.length ? Math.min(...xs) : 0,
		y = ys.length ? Math.min(...ys) : 0;
	return {
		x,
		y,
		width: xs.length ? Math.max(...xs) - x : 0,
		height: ys.length ? Math.max(...ys) - y : 0,
	};
}

export function elementPath(element: DrawingElement): string {
	const first = element.points[0];
	if (!first) return "";
	if (element.kind === "pen")
		return (
			`M ${first.x} ${first.y} ` +
			(element.points.length === 1
				? `l .1 0`
				: element.points
						.slice(1)
						.map((point) => `L ${point.x} ${point.y}`)
						.join(" "))
		);
	if (element.kind !== "arrow") return "";
	const last = element.points.at(-1) ?? first;
	const angle = Math.atan2(last.y - first.y, last.x - first.x);
	return (
		`M ${first.x} ${first.y} L ${last.x} ${last.y} ` +
		[-0.45, 0.45]
			.map(
				(offset) =>
					`M ${last.x} ${last.y} L ${last.x - Math.cos(angle + offset) * 18} ${last.y - Math.sin(angle + offset) * 18}`,
			)
			.join(" ")
	);
}

/** Constructed only from numeric geometry and escaped text, never stored SVG markup. */
export function drawingSVG(document: DrawingDocument): string {
	const escape = (text: string) =>
		text.replace(
			/[&<>"']/g,
			(character) =>
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&apos;",
				})[character]!,
		);
	const elements = document.elements
		.map((element) => {
			const bounds = elementBounds(element),
				first = element.points[0];
			const style = `stroke="${inks[element.ink] ?? inks.graphite}" stroke-width="${Number(element.lineWidth) || 3}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
			if (element.kind === "text" && first)
				return `<text x="${Number(first.x)}" y="${Number(first.y) + 21}" font-family="system-ui,sans-serif" font-size="21" font-weight="500" fill="${inks[element.ink] ?? inks.graphite}">${escape(element.text)}</text>`;
			if (element.kind === "rectangle")
				return `<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" rx="10" ${style}/>`;
			if (element.kind === "ellipse")
				return `<ellipse cx="${bounds.x + bounds.width / 2}" cy="${bounds.y + bounds.height / 2}" rx="${bounds.width / 2}" ry="${bounds.height / 2}" ${style}/>`;
			return `<path d="${escape(elementPath(element))}" ${style}/>`;
		})
		.join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 420">${elements}</svg>`;
}

export function svgImage(svg: string | undefined): string | undefined {
	return svg
		? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
		: undefined;
}
