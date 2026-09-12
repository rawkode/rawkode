type D2Instance = InstanceType<(typeof import("@terrastruct/d2"))["D2"]>;
let d2: Promise<D2Instance> | undefined;
let mermaid: Promise<(typeof import("mermaid"))["default"]> | undefined;
let serial = Promise.resolve();
let d2Serial = Promise.resolve();

const validate = (source: string) => {
	if (!source.trim()) throw new Error("Write some diagram source first.");
	if (new TextEncoder().encode(source).length > 200_000) {
		throw new Error("Diagram source is limited to 200 KB.");
	}
};

export const renderDiagram = async (
	kind: "diagram" | "mermaid",
	source: string,
): Promise<string> => {
	validate(source);
	let svg: string;
	if (kind === "diagram") {
		// The pinned D2 wrapper has one response callback, not a request-ID map.
		// Keep compile and render atomic across every component in the document.
		const prior = d2Serial;
		let release!: () => void;
		d2Serial = new Promise<void>((resolve) => {
			release = resolve;
		});
		await prior;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			d2 ??= import("@terrastruct/d2").then(({ D2 }) => new D2());
			const renderer = await d2;
			const render = async () => {
				const result = await renderer.compile({
					fs: { index: source },
					inputPath: "index",
					options: { layout: "dagre" },
				});
				return renderer.render(result.diagram, result.renderOptions);
			};
			svg = await Promise.race([
				render(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						// 0.1.33 exposes its worker but no disposal method. Reset a stuck worker
						// so one malformed or oversized layout cannot block subsequent notes.
						(renderer as D2Instance & { worker?: Worker }).worker?.terminate();
						d2 = undefined;
						reject(
							new Error(
								"D2 rendering took longer than 20 seconds. Try a smaller diagram.",
							),
						);
					}, 20_000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			release();
		}
	} else {
		mermaid ??= import("mermaid").then(({ default: renderer }) => {
			renderer.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				theme: "neutral",
				suppressErrorRendering: true,
				maxTextSize: 200_000,
				maxEdges: 500,
				htmlLabels: false,
				flowchart: { htmlLabels: false },
				secure: [
					"secure",
					"securityLevel",
					"startOnLoad",
					"maxTextSize",
					"maxEdges",
					"suppressErrorRendering",
					"htmlLabels",
				],
			});
			return renderer;
		});
		// Mermaid uses a shared configuration and temporary document nodes during render.
		const prior = serial;
		let release!: () => void;
		serial = new Promise<void>((resolve) => {
			release = resolve;
		});
		await prior;
		try {
			const renderer = await mermaid;
			const result = await renderer.render(
				`diagram-${crypto.randomUUID()}`,
				source,
			);
			svg = result.svg;
		} finally {
			release();
		}
	}
	if (new TextEncoder().encode(svg).length > 8_000_000) {
		throw new Error("Rendered diagram exceeds 8 MB.");
	}
	return svg;
};
