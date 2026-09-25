import { PGlite } from '@electric-sql/pglite';
import { NoteStore, type Queryable } from '../../src/store.js';

let shared: { store: NoteStore; db: PGlite } | null = null;

/**
 * A real Postgres (compiled to WASM, in-process) with the production schema.
 * Booted once per test file, emptied before every test.
 */
export async function freshStore(): Promise<{ store: NoteStore; db: PGlite }> {
  if (!shared) {
    const db = new PGlite();
    const store = new NoteStore(db as unknown as Queryable);
    await store.migrate();
    shared = { store, db };
  }
  await shared.db.exec('unlisten *; truncate notes, mailbox_state;');
  return { store: new NoteStore(shared.db as unknown as Queryable), db: shared.db };
}
