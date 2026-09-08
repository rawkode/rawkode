import { newHttpBatchRpcSession } from 'capnweb';
import {
	DOCUMENT_FORMAT,
	MAX_SNAPSHOT_BYTES,
	type DocumentsApi,
	type ExtensionDescriptor,
	type DocumentSnapshot,
} from '@enchiridion/documents';

interface Recovery {
	snapshot: string;
	revision: number;
	mutationId: string;
	dirty: boolean;
	extensions: ExtensionDescriptor[];
}
function rpc() {
	return newHttpBatchRpcSession<DocumentsApi>(
		`${location.origin}/api/documents/rpc`,
	);
}
export function encodeSnapshot(bytes: Uint8Array) {
	let text = '';
	for (let i = 0; i < bytes.length; i += 8192)
		text += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return btoa(text);
}
export const decodeSnapshot = (value: string) =>
	Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const database = new Promise<IDBDatabase>((resolve, reject) => {
	const request = indexedDB.open('enchiridion-recovery', 2);
	request.onupgradeneeded = () => {
		if (!request.result.objectStoreNames.contains('documents'))
			request.result.createObjectStore('documents');
		if (!request.result.objectStoreNames.contains('previews'))
			request.result.createObjectStore('previews');
	};
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error);
});
export async function previewCache(
	kind: string,
	source: string,
	value?: string,
): Promise<string | null> {
	const hash = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${kind}:${source}`),
	);
	const key = `${document.body.dataset.owner}:${Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('')}`;
	const db = await database;
	return new Promise((resolve, reject) => {
		const tx = db.transaction('previews', value ? 'readwrite' : 'readonly');
		const store = tx.objectStore('previews');
		const request = value ? store.put(value, key) : store.get(key);
		tx.oncomplete = () => resolve(value || request.result || null);
		tx.onerror = () => reject(tx.error);
	});
}
async function recovery(
	key: string,
	value?: Recovery,
): Promise<Recovery | undefined> {
	const db = await database;
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(
			'documents',
			value ? 'readwrite' : 'readonly',
		);
		const store = transaction.objectStore('documents');
		const request = value ? store.put(value, key) : store.get(key);
		transaction.oncomplete = () => resolve(value || request.result);
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}

export class DocumentPersistence {
	#revision = 0;
	#pending?: Recovery;
	#inflight?: Promise<void>;
	#localWrites: Promise<unknown> = Promise.resolve();
	#timer?: ReturnType<typeof setTimeout>;
	#conflict = false;
	#storageFailed = false;
	#oversized = false;
	#localKey: string;
	constructor(
		private key: string,
		owner: string,
		private status: (message: string) => void,
	) {
		// Separate recovery branches prevent one tab from replacing another tab's unsynced work.
		let tab = sessionStorage.getItem('enchiridion-tab');
		if (!tab) {
			tab = crypto.randomUUID();
			sessionStorage.setItem('enchiridion-tab', tab);
		}
		this.#localKey = `${owner}:${key}:${tab}`;
	}
	get dirty() {
		return Boolean(this.#pending || this.#inflight || this.#oversized);
	}
	async load() {
		const local = await recovery(this.#localKey);
		let remote: DocumentSnapshot | null;
		try {
			using api = rpc();
			remote = await api.load(this.key);
		} catch {
			if (!local)
				throw new Error(
					'Documents service unavailable. Retry before opening this note.',
				);
			this.#revision = local.revision;
			if (local.dirty) this.#pending = local;
			this.status('Offline · recovered on this device');
			return decodeSnapshot(local.snapshot);
		}
		this.#revision = remote?.revision ?? 0;
		if (local?.dirty) {
			if (remote?.snapshot === local.snapshot) {
				await recovery(this.#localKey, {
					...local,
					revision: this.#revision,
					dirty: false,
				});
			} else {
				this.#pending = local;
				this.#conflict = local.revision !== this.#revision;
				this.status(
					this.#conflict
						? 'Conflicting edits · export local copy'
						: 'Recovered unsaved changes',
				);
				return decodeSnapshot(local.snapshot);
			}
		}
		this.status(remote ? 'All changes saved' : 'Ready when you are');
		return remote ? decodeSnapshot(remote.snapshot) : undefined;
	}
	queue(bytes: Uint8Array, extensions: ExtensionDescriptor[]) {
		this.#oversized = bytes.length > MAX_SNAPSHOT_BYTES;
		if (bytes.length > MAX_SNAPSHOT_BYTES) {
			this.status('Document too large · export a copy');
			throw new Error(
				'Document exceeds the 1.5 MB snapshot limit. Export before leaving.',
			);
		}
		const entry: Recovery = {
			snapshot: encodeSnapshot(bytes),
			revision: this.#revision,
			dirty: true,
			mutationId: crypto.randomUUID(),
			extensions,
		};
		this.#pending = entry;
		this.status('Saving…');
		this.#writeRecovery(entry);
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			void this.flush();
		}, 600);
	}
	#writeRecovery(entry: Recovery) {
		this.#localWrites = this.#localWrites.then(async () => {
			try {
				await recovery(this.#localKey, entry);
				this.#storageFailed = false;
			} catch {
				this.#storageFailed = true;
				this.status('Device storage failed · keep this tab open');
			}
		});
	}
	flush(): Promise<void> {
		if (!this.#inflight) {
			this.#inflight = this.#drain().finally(() => {
				this.#inflight = undefined;
			});
		}
		return this.#inflight;
	}
	async #drain(): Promise<void> {
		clearTimeout(this.#timer);
		await this.#localWrites;
		if (!this.#pending) return;
		if (this.#conflict) {
			this.status('Conflicting edits · export local copy');
			return;
		}
		const entry = this.#pending;
		await (async () => {
			try {
				using api = rpc();
				const result = await api.save({
					key: this.key,
					expectedRevision: this.#revision,
					mutationId: entry.mutationId,
					snapshot: entry.snapshot,
					extensions: entry.extensions,
					format: DOCUMENT_FORMAT,
				});
				this.#revision = result.revision;
				if (this.#pending === entry) this.#pending = undefined;
				const latest = this.#pending;
				if (latest) latest.revision = result.revision;
				this.#writeRecovery(
					latest || { ...entry, revision: result.revision, dirty: false },
				);
				await this.#localWrites;
				this.status(latest ? 'Saving…' : 'All changes saved');
			} catch (error) {
				this.#conflict =
					error instanceof Error && error.message.includes('DOCUMENT_CONFLICT');
				this.status(
					this.#conflict
						? 'Conflicting edits · export local copy'
						: this.#storageFailed
							? 'Not saved · keep this tab open and export'
							: 'Saved on this device · server unavailable',
				);
			}
		})();
		if (this.#pending && this.#pending !== entry && !this.#conflict)
			await this.#drain();
	}
}
