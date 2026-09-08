export interface ExtensionValue {
	source: string;
	preview?: string;
}
export interface ExtensionSession {
	read(): Promise<ExtensionValue>;
	destroy(): void;
}
export interface ExtensionImplementation {
	mount(element: HTMLElement, source: string): Promise<ExtensionSession>;
}
export interface DocumentExtension {
	id: string;
	version: number;
	label: string;
	description: string;
	initialSource: string;
	validate(source: string): void;
	load(): Promise<ExtensionImplementation>;
}

/** Only trusted application code can register implementations, never document content. */
export class ExtensionRegistry {
	#extensions = new Map<string, DocumentExtension>();
	register(extension: DocumentExtension) {
		const key = `${extension.id}@${extension.version}`;
		if (this.#extensions.has(key))
			throw new Error(`Extension already registered: ${key}`);
		this.#extensions.set(key, extension);
		return () => {
			this.#extensions.delete(key);
		};
	}
	get(id: string, version = 1) {
		return this.#extensions.get(`${id}@${version}`);
	}
	list() {
		return [...this.#extensions.values()];
	}
}
export const extensions = new ExtensionRegistry();

export function validateExtension(
	kind: unknown,
	source: unknown,
	id: unknown,
	version: unknown = 1,
) {
	if (
		typeof kind !== 'string' ||
		!/^[a-z][a-z0-9.-]{0,63}$/.test(kind) ||
		typeof source !== 'string' ||
		source.includes('\0') ||
		new TextEncoder().encode(source).length > 750_000 ||
		typeof id !== 'string' ||
		!id ||
		id.length > 128 ||
		!Number.isSafeInteger(version) ||
		Number(version) < 1
	)
		throw new Error(
			'Unsupported extension envelope. Original content is preserved.',
		);
	// Unknown extensions remain opaque, selectable blocks and round-trip unchanged.
	extensions.get(kind, Number(version))?.validate(source);
}
