import { beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { NoteStore } from '../../src/store.js';
import { MailboxSync, SyncScheduler } from '../../src/sync.js';
import type { SyncTrigger } from '../../src/uid-state.js';
import { freshStore } from '../helpers/db.js';
import { FakeMailbox } from '../helpers/fake-mailbox.js';
import { noteId, noteSource } from '../helpers/notes.js';

let store: NoteStore;
let db: PGlite;
let box: FakeMailbox;
let sync: MailboxSync;

const run = (...t: SyncTrigger[]) => sync.run(box, new Set(t));
const titles = async () =>
  (await db.query<{ title: string }>('select title from notes order by title')).rows.map((r) => r.title);

beforeEach(async () => {
  ({ store, db } = await freshStore());
  box = new FakeMailbox();
  sync = new MailboxSync({ mailbox: 'Notes', store, concurrency: 3, maxAttempts: 2, retryBaseMs: 1 });
});

describe('MailboxSync', () => {
  it('first run imports everything and records the watermark', async () => {
    for (const n of [1, 2, 3]) box.append(noteSource({ id: noteId(n), title: `note ${n}` }));
    const r = await run('connect');
    expect(r).toMatchObject({ plan: 'full', reason: 'first-run', inserted: 3, lastUid: 3 });
    expect(await store.getState('Notes')).toEqual({ uidValidity: 1000, lastUid: 3 });
  });

  it('an edit (new message + expunge of the old one) is an update, never a delete', async () => {
    const old = box.append(noteSource({ id: noteId(1), title: 'Groceries', body: 'milk' }));
    await run('connect');
    box.append(noteSource({ id: noteId(1), title: 'Groceries', body: 'milk, eggs' }));
    box.expunge(old);
    const events: string[] = [];
    await db.listen('notes_changed', (p) => events.push(JSON.parse(p).op));
    const r = await run('new-messages', 'expunge');
    expect(r).toMatchObject({ plan: 'incremental', fetched: 1, updated: 1, deleted: 0, lastUid: 2 });
    await new Promise((res) => setTimeout(res, 20));
    expect(events).toEqual(['update']);
  });

  it('incremental passes download only messages above the watermark', async () => {
    for (const n of [1, 2]) box.append(noteSource({ id: noteId(n), title: `n${n}` }));
    await run('connect');
    box.fetchedUids = [];
    box.append(noteSource({ id: noteId(3), title: 'n3' }));
    await run('new-messages');
    expect(box.fetchedUids).toEqual([3]);
    // Nothing new: `3:*` would still hand back UID 3; it must not be counted again.
    box.fetchedUids = [];
    const again = await run('expunge');
    expect(again).toMatchObject({ fetched: 0, deleted: 0 });
  });

  it('detects deletes on EXPUNGE', async () => {
    const uids = [1, 2, 3].map((n) => box.append(noteSource({ id: noteId(n), title: `n${n}` })));
    await run('connect');
    box.expunge(uids[1]!);
    expect(await run('expunge')).toMatchObject({ deleted: 1 });
    expect(await titles()).toEqual(['n1', 'n3']);
  });

  it('survives a UIDVALIDITY change without losing or re-creating notes', async () => {
    for (const n of [1, 2, 3]) box.append(noteSource({ id: noteId(n), title: `n${n}` }));
    box.append(noteSource({ id: noteId(4), title: 'n4' }));
    box.expunge(1); // UIDs are now 2,3,4
    await run('connect');
    const events: string[] = [];
    await db.listen('notes_changed', (p) => events.push(JSON.parse(p).op));

    const mapping = box.rebuild(); // 2,3,4 -> 1,2,3 under a new UIDVALIDITY
    const r = await run('new-messages');
    expect(r).toMatchObject({ plan: 'full', reason: 'uidvalidity-changed', deleted: 0, inserted: 0, updated: 3 });
    expect(await store.getState('Notes')).toEqual({ uidValidity: 1001, lastUid: 3 });
    expect(await titles()).toEqual(['n2', 'n3', 'n4']);
    const { rows } = await db.query<{ id: string; uid: number }>('select id, uid::int as uid from notes order by id');
    expect(rows.map((x) => x.uid)).toEqual([mapping.get(2), mapping.get(3), mapping.get(4)]);
    await new Promise((res) => setTimeout(res, 20));
    expect(events).toEqual([]); // readers saw nothing happen, because nothing did
  });

  it('catches a recreated mailbox whose server kept the old UIDVALIDITY', async () => {
    for (const n of [1, 2, 3]) box.append(noteSource({ id: noteId(n), title: `n${n}` }));
    await run('connect');
    box.expunge(3);
    box.rebuild(true); // n1, n2 renumbered 1, 2 under the SAME UIDVALIDITY; UIDNEXT 3, watermark 3
    const r = await run('expunge');
    expect(r).toMatchObject({ plan: 'full', reason: 'uidnext-went-backwards', deleted: 1, lastUid: 2 });
    // The watermark is back in step, so the next new message (UID 3 again) is not skipped.
    box.append(noteSource({ id: noteId(4), title: 'n4' }));
    expect(await run('new-messages')).toMatchObject({ plan: 'incremental', inserted: 1 });
    expect(await titles()).toEqual(['n1', 'n2', 'n4']);
  });

  it('a note deleted while UIDVALIDITY changed is still removed', async () => {
    for (const n of [1, 2]) box.append(noteSource({ id: noteId(n), title: `n${n}` }));
    await run('connect');
    box.expunge(2);
    box.rebuild();
    await run('interval');
    expect(await titles()).toEqual(['n1']);
  });

  it('a full pass fetches only unknown UIDs and remembers messages that are not notes', async () => {
    box.append(noteSource({ id: noteId(1), title: 'n1' }));
    box.append('Subject: newsletter\r\nDate: Thu, 16 Jul 2026 08:00:00 +0000\r\n\r\nhello');
    const first = await run('connect');
    expect(first).toMatchObject({ inserted: 1, skipped: 1, lastUid: 2 });
    box.fetchedUids = [];
    await run('interval');
    expect(box.fetchedUids).toEqual([]);
  });

  it('an older duplicate of a note is ignored and not downloaded again', async () => {
    box.append(noteSource({ id: noteId(1), title: 'newer', modified: new Date('2026-07-02T00:00:00Z') }));
    box.append(noteSource({ id: noteId(1), title: 'older', modified: new Date('2026-07-01T00:00:00Z') }));
    await run('connect');
    expect(await titles()).toEqual(['newer']);
    box.fetchedUids = [];
    await run('interval');
    expect(box.fetchedUids).toEqual([]);
  });

  it('refuses to wipe the table when the server returns no UIDs for a non-empty mailbox', async () => {
    box.append(noteSource({ id: noteId(1), title: 'n1' }));
    await run('connect');
    box.lieAboutUids = true;
    await expect(run('interval')).rejects.toThrow(/returned no UIDs/);
    expect(await titles()).toEqual(['n1']);
  });

  it('a transient database failure holds the watermark so the message is retried', async () => {
    box.append(noteSource({ id: noteId(1), title: 'n1' }));
    await run('connect');
    box.append(noteSource({ id: noteId(2), title: 'n2' }));
    const realUpsert = store.upsert.bind(store);
    store.upsert = async () => {
      throw new Error('connection terminated');
    };
    expect(await run('new-messages')).toMatchObject({ failed: 1, lastUid: 1 });
    store.upsert = realUpsert;
    expect(await run('new-messages')).toMatchObject({ inserted: 1, lastUid: 2 });
  });
});

describe('SyncScheduler', () => {
  it('coalesces a burst of events into one pass, and one follow-up for events during it', async () => {
    const passes: string[][] = [];
    let release!: () => void;
    let first = true;
    const s = new SyncScheduler(
      async (t) => {
        passes.push([...t].sort());
        if (first) {
          first = false;
          await new Promise<void>((r) => (release = r));
        }
      },
      { debounceMs: 5 },
    );
    s.request('new-messages');
    s.request('expunge');
    s.request('new-messages');
    await new Promise((r) => setTimeout(r, 20));
    s.request('new-messages'); // during the running pass
    s.request('expunge');
    release();
    await s.idle();
    expect(passes).toEqual([['expunge', 'new-messages'], ['expunge', 'new-messages']]);
  });

  it('retries a failed pass with its triggers intact', async () => {
    const seen: string[][] = [];
    let fail = true;
    const s = new SyncScheduler(
      async (t) => {
        seen.push([...t]);
        if (fail) {
          fail = false;
          throw new Error('database down');
        }
      },
      { debounceMs: 1, retry: { baseMs: 5, maxMs: 5 } },
    );
    const errors: unknown[] = [];
    s.on('pass-error', (e) => errors.push(e));
    s.request('connect');
    await new Promise((r) => setTimeout(r, 40));
    await s.idle();
    expect(errors).toHaveLength(1);
    expect(seen).toEqual([['connect'], ['connect']]);
  });
});
