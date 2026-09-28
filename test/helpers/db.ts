import { PGlite } from '@electric-sql/pglite';
import { NoteStore, type Queryable } from '../../src/store.js';

let shared: { store: NoteStore; db: PGlite } | null = null;

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
