import { DOCUMENT_FORMAT, validateKey, validateSave, type SaveDocument, type DocumentSnapshot } from '@enchiridion/documents';

export class DocumentStore {
  constructor(private db: D1Database, private owner: string) {
    if (!owner || owner.length > 200) throw new Error('Unauthorized');
  }
  async load(key: string): Promise<DocumentSnapshot | null> {
    validateKey(key);
    const row = await this.db.prepare('SELECT revision, snapshot, format, extensions, updated_at FROM documents WHERE owner = ? AND key = ?').bind(this.owner, key).first<{ revision: number; snapshot: string; format: typeof DOCUMENT_FORMAT; extensions: string; updated_at: number }>();
    return row ? { revision: row.revision, snapshot: row.snapshot, format: row.format, extensions: JSON.parse(row.extensions), updatedAt: row.updated_at } : null;
  }
  async save(input: SaveDocument) {
    validateSave(input);
    const now = Date.now();
    const result = await this.db.prepare(`INSERT INTO documents(owner, key, revision, mutation_id, snapshot, format, extensions, updated_at)
      SELECT ?, ?, 1, ?, ?, ?, ?, ? WHERE ? = 0 OR EXISTS(SELECT 1 FROM documents WHERE owner = ? AND key = ?)
      ON CONFLICT(owner, key) DO UPDATE SET revision = documents.revision + 1, mutation_id = excluded.mutation_id,
      snapshot = excluded.snapshot, format = excluded.format, extensions = excluded.extensions, updated_at = excluded.updated_at
      WHERE documents.revision = ?`)
      .bind(this.owner, input.key, input.mutationId, input.snapshot, input.format, JSON.stringify(input.extensions), now, input.expectedRevision, this.owner, input.key, input.expectedRevision).run();
    if (result.meta.changes === 1) return { revision: input.expectedRevision + 1, updatedAt: now };
    const prior = await this.db.prepare('SELECT revision, updated_at, mutation_id, snapshot FROM documents WHERE owner = ? AND key = ?').bind(this.owner, input.key).first<{ revision: number; updated_at: number; mutation_id: string; snapshot: string }>();
    if (prior?.mutation_id === input.mutationId && prior.snapshot === input.snapshot) return { revision: prior.revision, updatedAt: prior.updated_at };
    throw new Error('DOCUMENT_CONFLICT: Another editor saved this document. Your local copy is retained; export it before reloading.');
  }
}
