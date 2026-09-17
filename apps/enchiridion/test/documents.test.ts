import { test, expect } from 'bun:test';
import { testDatabase } from './d1';
import { DocumentStore } from '../services/documents/src/store';
import { DOCUMENT_FORMAT, type SaveDocument } from '../packages/documents/src';

test('documents isolate owners, reject stale writers, retry idempotently, and preserve unknown extension descriptors', async () => {
  const { db, sqlite } = await testDatabase('../services/documents/migrations/0001_documents.sql');
  try {
    const a = new DocumentStore(db, 'a'), b = new DocumentStore(db, 'b');
    const input: SaveDocument = { key: 'day/2026-09-08', expectedRevision: 0, mutationId: crypto.randomUUID(), snapshot: btoa('opaque codec bytes'), format: DOCUMENT_FORMAT, extensions: [{ id: 'future.extension', version: 7 }] };
    expect(await a.load(input.key)).toBeNull();
    expect((await a.save(input)).revision).toBe(1);
    expect((await a.save(input)).revision).toBe(1);
    expect(await b.load(input.key)).toBeNull();
    expect((await a.load(input.key))?.extensions).toEqual(input.extensions);
    await expect(a.save({ ...input, mutationId: crypto.randomUUID(), snapshot: btoa('other') })).rejects.toThrow('DOCUMENT_CONFLICT');
    expect((await a.save({ ...input, expectedRevision: 1, mutationId: crypto.randomUUID() })).revision).toBe(2);
    await expect(a.save({ ...input, key: '../bad' })).rejects.toThrow('Invalid document key');
    await expect(a.save({ ...input, snapshot: '!' })).rejects.toThrow('snapshot');
  } finally { sqlite.close(); }
});
