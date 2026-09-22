import { z } from "zod";

/** The persisted note is the editor document itself, not another projection. */
export const NOTE_LIMITS = {
	bytes: 16 * 1024 * 1024,
	text: 4 * 1024 * 1024,
	nodes: 20_000,
	depth: 32,
	components: 1_000,
} as const;
const validText = (max: number) =>
	z
		.string()
		.max(max)
		.refine(
			(value) => !/[\uD800-\uDFFF]/u.test(value),
			"Unpaired UTF-16 surrogates are not valid Unicode",
		);
const uuid = z.guid();
// Reject whitespace and control characters in persisted URLs.
// deno-lint-ignore no-control-regex
const noControls = /^[^\u0000-\u0020\u007f]+$/u;
const httpURLSchema = validText(8_192)
	.regex(noControls, "URLs cannot contain whitespace or control characters")
	.pipe(z.url({ protocol: /^https?$/ }))
	.refine((value) => {
		try {
			const url = new URL(value);
			return /^https?:\/\//i.test(value) && !url.username && !url.password;
		} catch {
			return false;
		}
	}, "Use an absolute HTTP(S) URL without credentials");
const linkURLSchema = z.union([
	httpURLSchema,
	validText(8_192)
		.regex(noControls)
		.pipe(z.url({ protocol: /^mailto$/ })),
]);

export class NoteFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoteFormatError";
	}
}
const result = <T>(schema: z.ZodType<T>, value: unknown): T => {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new NoteFormatError(
			parsed.error.issues
				.slice(0, 3)
				.map((issue) => `${issue.path.join(".") || "note"}: ${issue.message}`)
				.join("; "),
		);
	}
	return parsed.data;
};
export const safeURL = (value: unknown, allowMailto = false): string => {
	return result(allowMailto ? linkURLSchema : httpURLSchema, value);
};

export const drawingPointSchema = z.strictObject({
	x: z.number().min(-100_000).max(100_000),
	y: z.number().min(-100_000).max(100_000),
});
export const drawingInkSchema = z.enum([
	"graphite",
	"blue",
	"purple",
	"orange",
	"green",
	"red",
]);
export const drawingElementSchema = z.strictObject({
	id: uuid,
	kind: z.enum(["pen", "rectangle", "ellipse", "arrow", "text"]),
	ink: drawingInkSchema,
	points: z.array(drawingPointSchema).max(100_000),
	text: validText(100_000),
	lineWidth: z.number().min(0.1).max(100),
});
export const drawingDocumentSchema = z
	.strictObject({ elements: z.array(drawingElementSchema).max(2_000) })
	.superRefine((drawing, context) => {
		if (
			drawing.elements.reduce(
				(sum, element) => sum + element.points.length,
				0,
			) > 100_000
		) {
			context.addIssue({
				code: "custom",
				message: "Drawing exceeds 100,000 points",
			});
		}
		const ids = new Set<string>();
		drawing.elements.forEach((element, index) => {
			const id = element.id.toLowerCase();
			if (ids.has(id)) {
				context.addIssue({
					code: "custom",
					path: ["elements", index, "id"],
					message: "Duplicate drawing element ID",
				});
			}
			ids.add(id);
		});
	});
export const playbackSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("directVideo"), url: httpURLSchema }),
	z.strictObject({ type: z.literal("embedURL"), url: httpURLSchema }),
]);
export const linkMetadataSchema = z.strictObject({
	title: validText(10_000),
	summary: validText(100_000).optional(),
	imageURL: httpURLSchema.optional(),
	playback: playbackSchema.optional(),
	discoveryNote: validText(10_000).optional(),
});
export const componentSchema = z
	.strictObject({
		id: uuid,
		kind: z.enum(["diagram", "mermaid", "drawing", "link"]),
		title: validText(10_000),
		source: validText(200_000),
		svg: validText(8 * 1024 * 1024).optional(),
		drawing: drawingDocumentSchema.optional(),
		metadata: linkMetadataSchema.optional(),
	})
	.superRefine((component, context) => {
		if (
			component.kind === "link" &&
			component.source &&
			!httpURLSchema.safeParse(component.source).success
		) {
			context.addIssue({
				code: "custom",
				path: ["source"],
				message: "A link component requires an HTTP(S) URL without credentials",
			});
		}
	});

const namedColors = [
	"black",
	"silver",
	"gray",
	"white",
	"maroon",
	"red",
	"purple",
	"fuchsia",
	"green",
	"lime",
	"olive",
	"yellow",
	"navy",
	"blue",
	"teal",
	"aqua",
	"transparent",
] as const;
const channel = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const alpha = "(?:0(?:\\.\\d+)?|1(?:\\.0+)?)";
export const colorSchema = z.union([
	z.enum(namedColors),
	z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i),
	z
		.string()
		.max(80)
		.regex(
			new RegExp(
				`^rgb\\(\\s*${channel}\\s*,\\s*${channel}\\s*,\\s*${channel}\\s*\\)$`,
				"i",
			),
		),
	z
		.string()
		.max(100)
		.regex(
			new RegExp(
				`^rgba\\(\\s*${channel}\\s*,\\s*${channel}\\s*,\\s*${channel}\\s*,\\s*${alpha}\\s*\\)$`,
				"i",
			),
		),
]);
export const textStyleAttributesSchema = z.strictObject({
	fontFamily: validText(128)
		.regex(/^[\p{L}\p{N} ._+'",\-]+$/u)
		.nullable()
		.optional(),
	fontSize: z
		.string()
		.max(16)
		.regex(/^(?:\d+(?:\.\d+)?)px$/)
		.refine(
			(value) => parseFloat(value) >= 1 && parseFloat(value) <= 512,
			"Font size must be between 1px and 512px",
		)
		.nullable()
		.optional(),
	color: colorSchema.nullable().optional(),
	backgroundColor: colorSchema.nullable().optional(),
});
export const linkAttributesSchema = z.strictObject({
	href: linkURLSchema,
	target: z.enum(["_blank", "_self"]).nullable().optional(),
	rel: z
		.string()
		.max(128)
		.regex(/^(?:(?:noopener|noreferrer|nofollow|ugc|sponsored)(?:\s+|$))*$/)
		.nullable()
		.optional(),
	class: validText(256)
		.regex(/^[\w \-]*$/)
		.nullable()
		.optional(),
	title: validText(10_000).nullable().optional(),
});
const emptyAttributes = z.strictObject({}).optional();
const markSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("bold"), attrs: emptyAttributes }),
	z.strictObject({ type: z.literal("italic"), attrs: emptyAttributes }),
	z.strictObject({ type: z.literal("underline"), attrs: emptyAttributes }),
	z.strictObject({ type: z.literal("strike"), attrs: emptyAttributes }),
	z.strictObject({ type: z.literal("code"), attrs: emptyAttributes }),
	z.strictObject({
		type: z.literal("textStyle"),
		attrs: textStyleAttributesSchema,
	}),
	z.strictObject({
		type: z.literal("link"),
		attrs: linkAttributesSchema,
	}),
]);
const marksSchema = z
	.array(markSchema)
	.max(7)
	.superRefine((marks, context) => {
		const seen = new Set<string>();
		marks.forEach((mark, index) => {
			if (seen.has(mark.type)) {
				context.addIssue({
					code: "custom",
					path: [index],
					message: "A node cannot repeat the same mark type",
				});
			}
			seen.add(mark.type);
		});
	});
export const textNodeSchema = z.strictObject({
	type: z.literal("text"),
	text: validText(NOTE_LIMITS.text).min(1),
	marks: marksSchema.optional(),
});
export const providerEntityReferenceSchema = z.strictObject({
	provider: z.enum(["google", "github"]),
	kind: z.enum(["person", "event", "issue", "pullRequest", "discussion"]),
	// deno-lint-ignore no-control-regex
	id: validText(512).min(1).regex(/^[^\u0000-\u001f\u007f]+$/u),
	label: validText(1_000).min(1),
	avatarURL: httpURLSchema.optional(),
	meta: validText(4_096).optional(),
});
export const canonicalEntityReferenceSchema = z.strictObject({
	version: z.literal(1),
	entityId: uuid,
	fallbackLabel: validText(1_000).min(1),
	displayText: validText(1_000).min(1),
	presentation: z.enum(["link", "mention"]),
});
export const entityReferenceSchema = z.union([
	providerEntityReferenceSchema,
	canonicalEntityReferenceSchema,
]);
const inlineNodeSchema = z.discriminatedUnion("type", [
	textNodeSchema,
	z.strictObject({
		type: z.literal("hardBreak"),
		marks: marksSchema.optional(),
	}),
	z.strictObject({
		type: z.literal("component"),
		attrs: z.strictObject({ component: componentSchema }),
		marks: marksSchema.optional(),
	}),
	z.strictObject({
		type: z.literal("entity"),
		attrs: z.strictObject({ entity: entityReferenceSchema }),
		marks: marksSchema.optional(),
	}),
]);
const alignmentSchema = z
	.enum(["left", "center", "right", "justify"])
	.nullable()
	.optional();
export const paragraphSchema = z.strictObject({
	type: z.literal("paragraph"),
	attrs: z.strictObject({ textAlign: alignmentSchema }).optional(),
	content: z.array(inlineNodeSchema).max(NOTE_LIMITS.nodes).optional(),
});
const headingSchema = z.strictObject({
	type: z.literal("heading"),
	attrs: z.strictObject({
		level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
		textAlign: alignmentSchema,
	}),
	content: z.array(inlineNodeSchema).max(NOTE_LIMITS.nodes).optional(),
});
const codeBlockSchema = z.strictObject({
	type: z.literal("codeBlock"),
	attrs: z
		.strictObject({ language: validText(128).nullable().optional() })
		.optional(),
	content: z
		.array(
			z.strictObject({
				type: z.literal("text"),
				text: validText(NOTE_LIMITS.text).min(1),
				marks: z.array(markSchema).length(0).optional(),
			}),
		)
		.max(NOTE_LIMITS.nodes)
		.optional(),
});
const blockquoteSchema = z.strictObject({
	type: z.literal("blockquote"),
	get content(): z.ZodArray<typeof blockSchema> {
		return z.array(blockSchema).min(1).max(NOTE_LIMITS.nodes);
	},
});
const listItemSchema = z.strictObject({
	type: z.literal("listItem"),
	get content(): z.ZodTuple<[typeof paragraphSchema], typeof blockSchema> {
		return z.tuple([paragraphSchema]).rest(blockSchema);
	},
});
const taskItemSchema = z.strictObject({
	type: z.literal("taskItem"),
	attrs: z.strictObject({ checked: z.boolean() }),
	get content(): z.ZodTuple<[typeof paragraphSchema], typeof blockSchema> {
		return z.tuple([paragraphSchema]).rest(blockSchema);
	},
});
export const orderedListAttributesSchema = z.strictObject({
	start: z.int().min(1).max(1_000_000).optional(),
	type: z.literal("1").nullable().optional(),
});
export const blockSchema = z.discriminatedUnion("type", [
	paragraphSchema,
	headingSchema,
	codeBlockSchema,
	blockquoteSchema,
	z.strictObject({
		type: z.literal("bulletList"),
		content: z.array(listItemSchema).min(1).max(NOTE_LIMITS.nodes),
	}),
	z.strictObject({
		type: z.literal("orderedList"),
		attrs: orderedListAttributesSchema.optional(),
		content: z.array(listItemSchema).min(1).max(NOTE_LIMITS.nodes),
	}),
	z.strictObject({
		type: z.literal("taskList"),
		content: z.array(taskItemSchema).min(1).max(NOTE_LIMITS.nodes),
	}),
]);

// Resource guard before recursive Zod evaluation, not another document model.
const boundedJSONSchema = z.unknown().superRefine((value, context) => {
	const stack: { value: unknown; depth: number; leave?: boolean }[] = [
		{ value, depth: 0 },
	];
	const ancestors = new Set<object>();
	let count = 0,
		stringUnits = 0;
	while (stack.length) {
		const entry = stack.pop()!;
		if (entry.leave) {
			ancestors.delete(entry.value as object);
			continue;
		}
		if (++count > 400_000 || entry.depth > 96) {
			context.addIssue({
				code: "custom",
				message: "Document JSON exceeds its size or nesting limit",
			});
			return;
		}
		if (typeof entry.value === "string") {
			stringUnits += entry.value.length;
			if (stringUnits > NOTE_LIMITS.bytes) {
				context.addIssue({
					code: "custom",
					message: "Note exceeds the 16 MiB file limit",
				});
				return;
			}
		}
		if (entry.value && typeof entry.value === "object") {
			if (ancestors.has(entry.value)) {
				context.addIssue({
					code: "custom",
					message: "Circular documents are not JSON",
				});
				return;
			}
			const prototype = Object.getPrototypeOf(entry.value);
			if (
				!Array.isArray(entry.value) &&
				prototype !== Object.prototype &&
				prototype !== null
			) {
				context.addIssue({
					code: "custom",
					message: "Expected plain JSON objects",
				});
				return;
			}
			ancestors.add(entry.value);
			stack.push({ ...entry, leave: true });
			for (
				const descriptor of Object.values(
					Object.getOwnPropertyDescriptors(entry.value),
				)
			) {
				if (descriptor.get || descriptor.set) {
					context.addIssue({
						code: "custom",
						message: "JSON cannot contain accessors",
					});
					return;
				}
				stack.push({ value: descriptor.value, depth: entry.depth + 1 });
			}
		} else if (
			typeof entry.value === "function" ||
			typeof entry.value === "symbol" ||
			typeof entry.value === "bigint"
		) {
			context.addIssue({ code: "custom", message: "Expected JSON values" });
			return;
		}
	}
	const encoded = JSON.stringify(value);
	if (
		!encoded ||
		new TextEncoder().encode(encoded).byteLength > NOTE_LIMITS.bytes
	) {
		context.addIssue({
			code: "custom",
			message: "Note exceeds the 16 MiB file limit",
		});
	}
});
const documentObjectSchema = z.strictObject({
	type: z.literal("doc"),
	content: z.array(blockSchema).min(1).max(NOTE_LIMITS.nodes),
});
export const documentSchema = boundedJSONSchema
	.pipe(documentObjectSchema)
	.superRefine((document, context) => {
		const stack: {
			node: {
				type: string;
				text?: string;
				content?: unknown[];
				attrs?: Record<string, unknown>;
			};
			depth: number;
		}[] = [{ node: document, depth: 0 }];
		const ids = new Set<string>();
		let nodes = 0,
			text = 0,
			components = 0;
		while (stack.length) {
			const { node, depth } = stack.pop()!;
			if (++nodes > NOTE_LIMITS.nodes || depth > NOTE_LIMITS.depth) {
				context.addIssue({
					code: "custom",
					message: "Document exceeds 20,000 nodes or 32 nesting levels",
				});
				return;
			}
			text += node.text?.length ?? 0;
			if (text > NOTE_LIMITS.text) {
				context.addIssue({
					code: "custom",
					message: "Document text exceeds 4 Mi characters",
				});
				return;
			}
			if (node.type === "component") {
				const component = node.attrs!.component as Component;
				const id = component.id.toLowerCase();
				if (ids.has(id)) {
					context.addIssue({
						code: "custom",
						message: `Duplicate component ID ${component.id}`,
					});
				}
				ids.add(id);
				if (++components > NOTE_LIMITS.components) {
					context.addIssue({
						code: "custom",
						message: "Document exceeds 1,000 components",
					});
					return;
				}
			}
			for (const child of node.content ?? []) {
				stack.push({ node: child as typeof node, depth: depth + 1 });
			}
		}
	});

export type NoteDocument = z.infer<typeof documentSchema>;
export type Component = z.infer<typeof componentSchema>;
export type EntityReference = z.infer<typeof entityReferenceSchema>;
export type ProviderEntityReference = z.infer<
	typeof providerEntityReferenceSchema
>;
export type CanonicalEntityReference = z.infer<
	typeof canonicalEntityReferenceSchema
>;
export type LinkMetadata = z.infer<typeof linkMetadataSchema>;
export type Playback = z.infer<typeof playbackSchema>;
export type DrawingDocument = z.infer<typeof drawingDocumentSchema>;
export type DrawingElement = z.infer<typeof drawingElementSchema>;
export type DrawingPoint = z.infer<typeof drawingPointSchema>;
export type DrawingInk = z.infer<typeof drawingInkSchema>;
export type TextStyleAttributes = z.infer<typeof textStyleAttributesSchema>;
export const parseComponent = (value: unknown): Component => {
	return result(boundedJSONSchema.pipe(componentSchema), value);
};
export const parseEntity = (value: unknown): EntityReference => {
	return result(boundedJSONSchema.pipe(entityReferenceSchema), value);
};
export const parseNote = (value: unknown): NoteDocument => {
	if (typeof value === "string") {
		if (new TextEncoder().encode(value).byteLength > NOTE_LIMITS.bytes) {
			throw new NoteFormatError("Note exceeds the 16 MiB file limit");
		}
		try {
			value = JSON.parse(value);
		} catch {
			throw new NoteFormatError("The note is not valid JSON");
		}
	}
	return result(documentSchema, value);
};
