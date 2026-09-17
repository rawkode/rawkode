import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { validateDiagram } from './schema';

export const BINDING_VERSION = '0.4.4';
export const DOCUMENT_VERSION = 4;
export function unsupported(message: string): never {
	throw new Error(`${message} The saved note has not been changed.`);
}
export function record(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		!(value instanceof Uint8Array)
	);
}
export function exactKeys(value: Record<string, unknown>, keys: string[]) {
	if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0'))
		unsupported('Unsupported document fields.');
}
export function safeLink(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^(https?:\/\/|mailto:)/i.test(value) &&
		!/[\u0000-\u001f]/.test(value)
	);
}
function attributes(
	name: string,
	value: Record<string, unknown>,
	allowed: Record<string, unknown>,
) {
	for (const key of Object.keys(value))
		if (!(key in allowed))
			unsupported(`Unsupported ${name} attribute: ${key}.`);
	if (name === 'diagram')
		validateDiagram(value.kind, value.source, value.id, value.version);
	if (name === 'link' && !safeLink(value.href))
		unsupported('Unsupported link URL.');
	if (
		name === 'heading' &&
		(!Number.isInteger(value.level) ||
			Number(value.level) < 1 ||
			Number(value.level) > 6)
	)
		unsupported('Unsupported heading level.');
	if (name === 'taskItem' && typeof value.checked !== 'boolean')
		unsupported('Unsupported checkbox state.');
	if (
		name === 'orderedList' &&
		value.start !== undefined &&
		(!Number.isInteger(value.start) || Number(value.start) < 1)
	)
		unsupported('Unsupported list start.');
	for (const key of ['rowspan', 'colspan']) {
		if (
			value[key] !== undefined &&
			(!Number.isInteger(value[key]) ||
				Number(value[key]) < 1 ||
				Number(value[key]) > 1000)
		)
			unsupported('Unsupported table span.');
	}
	if (
		value.colwidth !== undefined &&
		value.colwidth !== null &&
		(!Array.isArray(value.colwidth) ||
			!value.colwidth.every(
				(width) => Number.isInteger(width) && width >= 0 && width <= 100_000,
			))
	)
		unsupported('Unsupported table column width.');
	for (const key of ['href', 'target', 'rel', 'class', 'language']) {
		if (
			value[key] !== undefined &&
			value[key] !== null &&
			typeof value[key] !== 'string'
		)
			unsupported(`Unsupported ${key} value.`);
	}
}

/** The binding filters failed node/mark conversions. Validate every container first. */
export function preflightSnapshot(
	doc: LoroDoc,
	day: string,
	schema: Schema,
): PMNode {
	const roots = doc.getShallowValue();
	exactKeys(roots, ['metadata', 'doc']);
	if (
		roots.metadata !== 'cid:root-metadata:Map' ||
		roots.doc !== 'cid:root-doc:Map'
	)
		unsupported('Unsupported document root containers.');
	const metadata = doc.getMap('metadata').toJSON();
	exactKeys(metadata, [
		'schemaVersion',
		'day',
		'binding',
		'bindingVersion',
		'editorSchema',
	]);
	if (
		metadata.schemaVersion !== DOCUMENT_VERSION ||
		metadata.day !== day ||
		metadata.binding !== 'loro-prosemirror' ||
		metadata.bindingVersion !== BINDING_VERSION ||
		metadata.editorSchema !== 1
	)
		unsupported('This note requires a different editor version.');
	const seen = new Set<string>();
	const diagramIds = new Set<string>();
	let count = 0;
	const visit = (container: unknown, depth: number): PMNode[] => {
		if (++count > 100_000 || depth > 100)
			unsupported('This note is too complex for this editor.');
		if (!(container instanceof LoroMap || container instanceof LoroText))
			unsupported('Unsupported editor container.');
		if (seen.has(container.id))
			unsupported('Repeated or cyclic editor container.');
		seen.add(container.id);
		if (container instanceof LoroText) {
			return container.toDelta().map((delta) => {
				if (typeof delta.insert !== 'string' || delta.insert.length === 0)
					unsupported('Unsupported text run.');
				const marks = Object.entries(delta.attributes ?? {}).map(
					([name, attrs]) => {
						const type = schema.marks[name];
						if (!type || !record(attrs))
							unsupported(`Unsupported text mark: ${name}.`);
						attributes(name, attrs, type.spec.attrs ?? {});
						return type.create(attrs);
					},
				);
				return schema.text(delta.insert, marks);
			});
		}
		exactKeys(container.getShallowValue(), [
			'nodeName',
			'attributes',
			'children',
		]);
		const name = container.get('nodeName');
		const attrs = container.get('attributes');
		const children = container.get('children');
		if (
			typeof name !== 'string' ||
			!schema.nodes[name] ||
			!(attrs instanceof LoroMap) ||
			!(children instanceof LoroList)
		)
			unsupported('Unsupported editor node.');
		const values = attrs.toJSON();
		attributes(name, values, schema.nodes[name].spec.attrs ?? {});
		if (name === 'diagram') {
			if (diagramIds.has(values.id as string))
				unsupported('Duplicate diagram identity.');
			diagramIds.add(values.id as string);
		}
		const node = schema.nodes[name].createChecked(
			values,
			children.toArray().flatMap((child) => visit(child, depth + 1)),
		);
		node.check();
		return [node];
	};
	const [node] = visit(doc.getMap('doc'), 0);
	if (node.type !== schema.topNodeType)
		unsupported('Unsupported editor document node.');
	return node;
}
