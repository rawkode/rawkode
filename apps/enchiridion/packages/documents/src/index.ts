export const DOCUMENT_FORMAT = 'loro-prosemirror-v4';
export const MAX_SNAPSHOT_BYTES = 1_500_000;
export interface ExtensionDescriptor {
	id: string;
	version: number;
}
export interface DocumentSnapshot {
	revision: number;
	snapshot: string;
	format: typeof DOCUMENT_FORMAT;
	extensions: ExtensionDescriptor[];
	updatedAt: number;
}
export interface SaveDocument {
	key: string;
	expectedRevision: number;
	mutationId: string;
	snapshot: string;
	format: typeof DOCUMENT_FORMAT;
	extensions: ExtensionDescriptor[];
}
export interface DocumentsApi {
	load(key: string): Promise<DocumentSnapshot | null>;
	save(input: SaveDocument): Promise<{ revision: number; updatedAt: number }>;
}
export interface DocumentsBinding {
	forOwner(owner: string): Promise<DocumentsApi & Disposable>;
}
export function validateKey(key: unknown): asserts key is string {
	if (
		typeof key !== 'string' ||
		!/^[a-zA-Z0-9][a-zA-Z0-9:/_-]{0,199}$/.test(key)
	)
		throw new Error('Invalid document key');
}
export function validateSave(input: SaveDocument) {
	validateKey(input.key);
	if (
		input.format !== DOCUMENT_FORMAT ||
		!Number.isSafeInteger(input.expectedRevision) ||
		input.expectedRevision < 0 ||
		typeof input.mutationId !== 'string' ||
		!/^[a-zA-Z0-9-]{16,80}$/.test(input.mutationId)
	)
		throw new Error('Unsupported document envelope');
	if (
		typeof input.snapshot !== 'string' ||
		input.snapshot.length > (MAX_SNAPSHOT_BYTES * 4) / 3 ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(input.snapshot) ||
		input.snapshot.length % 4 !== 0
	)
		throw new Error('Invalid or oversized snapshot');
	if (!Array.isArray(input.extensions) || input.extensions.length > 64)
		throw new Error('Invalid extension manifest');
	const ids = new Set<string>();
	for (const item of input.extensions) {
		if (
			!item ||
			typeof item.id !== 'string' ||
			!/^[a-z][a-z0-9.-]{0,63}$/.test(item.id) ||
			!Number.isSafeInteger(item.version) ||
			item.version < 1 ||
			ids.has(item.id)
		)
			throw new Error('Invalid extension descriptor');
		ids.add(item.id);
	}
}
