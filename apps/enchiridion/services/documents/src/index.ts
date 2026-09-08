import { WorkerEntrypoint } from 'cloudflare:workers';
import { RpcTarget, newWorkersRpcResponse } from 'capnweb';
import type { SaveDocument } from '@enchiridion/documents';
import { DocumentStore } from './store';
interface Env {
	DB: D1Database;
}
class DocumentsSession extends RpcTarget {
	#store: DocumentStore;
	constructor(env: Env, owner: string) {
		super();
		this.#store = new DocumentStore(env.DB, owner);
	}
	load(key: string) {
		return this.#store.load(key);
	}
	save(input: SaveDocument) {
		return this.#store.save(input);
	}
}
/** Trusted website service binding only; owner identity never comes from browser headers. */
export class Documents extends WorkerEntrypoint<Env> {
	forOwner(owner: string) {
		return new DocumentsSession(this.env, owner);
	}
	fetch(request: Request) {
		if (request.method !== 'POST')
			return new Response('Method not allowed', { status: 405 });
		const owner = request.headers.get('X-Enchiridion-Owner');
		if (!owner) return new Response('Unauthorized', { status: 401 });
		return newWorkersRpcResponse(request, this.forOwner(owner));
	}
}
export default {
	fetch(request: Request) {
		return new URL(request.url).pathname === '/health'
			? Response.json({ service: 'documents', status: 'ok' })
			: new Response('Not found', { status: 404 });
	},
};
