import { beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseNote } from '../../src/note.js';
import type { NoteStore } from '../../src/store.js';
import { freshStore } from '../helpers/db.js';
import { noteId, noteSource } from '../helpers/notes.js';

const at = (uid: number, uidValidity = 1) => ({ mailbox: 'Notes', uid, uidValidity });

let store: NoteStore;
let db: PGlite;

beforeEach(async () => {
  ({ store, db } = await freshStore());
});

async function row(id: string) {
  const { rows } = await db.query<{ title: string; uid: number; body_text: string }>(
    'select title, uid::int as uid, body_text from notes where id = $1',
    [id],
  );
  return rows[0];
}

describe('NoteStore.upsert', () => {
  it('is idempotent: the same message twice is one insert and one no-op', async () => {
    const note = await parseNote(noteSource({ id: noteId(1), title: 'Groceries' }));
    expect(await store.upsert(note, at(1))).toBe('inserted');
    expect(await store.upsert(note, at(1))).toBe('unchanged');
    expect(await store.upsert(note, at(1))).toBe('unchanged');
    const { rows } = await db.query('select count(*)::int as n from notes');
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('applies an edit that arrives as a new UID with a later Date', async () => {
    const v1 = await parseNote(noteSource({ id: noteId(1), title: 'Groceries', body: 'milk', modified: new Date('2026-07-01T10:00:00Z') }));
    const v2 = await parseNote(noteSource({ id: noteId(1), title: 'Groceries', body: 'milk, eggs', modified: new Date('2026-07-01T11:00:00Z') }));
    await store.upsert(v1, at(1));
    expect(await store.upsert(v2, at(2))).toBe('updated');
    expect(await row(noteId(1))).toMatchObject({ uid: 2, body_text: 'Groceries\nmilk, eggs' });
  });

  it('never lets an older version overwrite a newer one, whatever the order', async () => {
    const older = await parseNote(noteSource({ id: noteId(1), title: 'Old', modified: new Date('2026-07-01T10:00:00Z') }));
    const newer = await parseNote(noteSource({ id: noteId(1), title: 'New', modified: new Date('2026-07-01T11:00:00Z') }));
    await store.upsert(newer, at(9));
    expect(await store.upsert(older, at(3))).toBe('unchanged');
    expect(await row(noteId(1))).toMatchObject({ title: 'New', uid: 9 });
  });

  it('breaks a tie on the same Date with the higher UID', async () => {
    const when = new Date('2026-07-01T10:00:00Z');
    const a = await parseNote(noteSource({ id: noteId(1), title: 'A', modified: when }));
    const b = await parseNote(noteSource({ id: noteId(1), title: 'B', modified: when }));
    await store.upsert(b, at(5));
    expect(await store.upsert(a, at(4))).toBe('unchanged');
    expect(await store.upsert(a, at(6))).toBe('updated');
    expect(await row(noteId(1))).toMatchObject({ title: 'A', uid: 6 });
  });

  it('holds under concurrent writers of different versions', async () => {
    const versions = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        parseNote(noteSource({ id: noteId(1), title: `v${i}`, modified: new Date(Date.UTC(2026, 6, 1, 10, i)) })),
      ),
    );
    await Promise.all([...versions].reverse().map((v, i) => store.upsert(v, at(100 - i))));
    expect((await row(noteId(1)))?.title).toBe('v7');
  });
});

describe('NoteStore deletes and UID bookkeeping', () => {
  it('deletes notes whose message left the server and keeps the rest', async () => {
    for (const n of [1, 2, 3]) await store.upsert(await parseNote(noteSource({ id: noteId(n), title: `n${n}` })), at(n));
    expect(await store.deleteMissing('Notes', 1, [1, 3])).toEqual([noteId(2)]);
    expect(await store.knownUids('Notes', 1)).toEqual(expect.arrayContaining([1, 3]));
  });

  it('only touches its own mailbox', async () => {
    await store.upsert(await parseNote(noteSource({ id: noteId(1), title: 'mine' })), at(1));
    await store.upsert(await parseNote(noteSource({ id: noteId(2), title: 'other' })), { mailbox: 'Notes/Work', uid: 1, uidValidity: 1 });
    expect(await store.deleteMissing('Notes', 1, [])).toEqual([noteId(1)]);
    expect(await row(noteId(2))).toBeDefined();
  });

  it('resetUids forgets pointers but keeps the notes', async () => {
    await store.upsert(await parseNote(noteSource({ id: noteId(1), title: 'kept' })), at(4));
    await store.saveState('Notes', { uidValidity: 1, lastUid: 4 });
    await store.resetUids('Notes', 2);
    expect(await store.getState('Notes')).toEqual({ uidValidity: 2, lastUid: 0 });
    expect(await store.knownUids('Notes', 1)).toEqual([]);
    expect((await row(noteId(1)))?.title).toBe('kept');
  });

  it('announces content changes on notes_changed, but not a UID-only move', async () => {
    const events: Array<{ op: string; id: string }> = [];
    await db.listen('notes_changed', (payload) => events.push(JSON.parse(payload)));
    const note = await parseNote(noteSource({ id: noteId(1), title: 'hello' }));
    await store.upsert(note, at(1));
    await store.upsert(note, at(1));
    await store.upsert(note, at(1, 2));
    await store.deleteMissing('Notes', 2, []);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.map((e) => e.op)).toEqual(['insert', 'delete']);
  });

  it('searches title and body', async () => {
    await store.upsert(await parseNote(noteSource({ id: noteId(1), title: 'Road trip', body: 'lighthouse stop' })), at(1));
    await store.upsert(await parseNote(noteSource({ id: noteId(2), title: 'Groceries', body: 'lemons' })), at(2));
    expect((await store.list('lighthouse')).map((n) => n.title)).toEqual(['Road trip']);
    expect((await store.list()).length).toBe(2);
  });
});
