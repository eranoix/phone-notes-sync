import { excerpt } from './html.js';
import type { ParsedNote } from './note.js';
import { SCHEMA_SQL } from './schema.js';
import type { StoredMailboxState } from './uid-state.js';

/**
 * The only thing the store needs from a database driver. Both `pg.Pool` and
 * PGlite (an in-process Postgres used by the unit tests) satisfy it, so the
 * SQL under test is the SQL that runs in production.
 */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** Multi-statement execution, when the driver separates it from `query` (PGlite does). */
  exec?(text: string): Promise<unknown>;
}

export interface MessageLocation {
  mailbox: string;
  uid: number;
  uidValidity: number;
}

export type UpsertResult = 'inserted' | 'updated' | 'unchanged';

export interface NoteSummary {
  id: string;
  title: string;
  excerpt: string;
  mailbox: string;
  uid: number | null;
  createdAt: string | null;
  modifiedAt: string;
  syncedAt: string;
  attachments: unknown[];
}

export class NoteStore {
  constructor(private readonly db: Queryable) {}

  async migrate(): Promise<void> {
    if (this.db.exec) await this.db.exec(SCHEMA_SQL);
    else await this.db.query(SCHEMA_SQL);
  }

  async getState(mailbox: string): Promise<StoredMailboxState | null> {
    const { rows } = await this.db.query<{ uid_validity: string | number; last_uid: string | number }>(
      'select uid_validity, last_uid from mailbox_state where mailbox = $1',
      [mailbox],
    );
    const row = rows[0];
    return row ? { uidValidity: Number(row.uid_validity), lastUid: Number(row.last_uid) } : null;
  }

  async saveState(mailbox: string, state: StoredMailboxState, fullSync = false): Promise<void> {
    await this.db.query(
      `insert into mailbox_state (mailbox, uid_validity, last_uid, last_full_sync_at, updated_at)
       values ($1, $2, $3, case when $4 then now() end, now())
       on conflict (mailbox) do update set
         uid_validity = excluded.uid_validity,
         last_uid = excluded.last_uid,
         last_full_sync_at = coalesce(excluded.last_full_sync_at, mailbox_state.last_full_sync_at),
         updated_at = now()`,
      [mailbox, state.uidValidity, state.lastUid, fullSync],
    );
  }

  /**
   * Forget every UID stored for a mailbox. Called when UIDVALIDITY changes:
   * the notes stay (their identity is the Apple UUID, not the UID), only the
   * pointers into the old mailbox are cleared, and the full pass that follows
   * fills them back in.
   */
  async resetUids(mailbox: string, uidValidity: number): Promise<void> {
    await this.db.query('update notes set uid = null, uid_validity = null where mailbox = $1', [mailbox]);
    await this.saveState(mailbox, { uidValidity, lastUid: 0 });
  }

  async knownUids(mailbox: string, uidValidity: number): Promise<number[]> {
    const { rows } = await this.db.query<{ uid: string | number }>(
      'select uid from notes where mailbox = $1 and uid_validity = $2 and uid is not null',
      [mailbox, uidValidity],
    );
    return rows.map((r) => Number(r.uid));
  }

  /**
   * Insert or update a note, keyed by its Apple UUID. Safe to call any number
   * of times with the same message, and safe under concurrency:
   *
   *   - Replaying the same message changes nothing (and fires no notification).
   *   - An OLDER version never overwrites a newer one. During an edit the old
   *     and new messages can both be on the server for a moment and may be
   *     processed in either order; `modified_at` decides, and the higher UID
   *     breaks a tie within the same UIDVALIDITY.
   *   - The decision happens inside one INSERT ... ON CONFLICT, so two workers
   *     racing on the same note are serialized by the row lock, not by luck.
   */
  async upsert(note: ParsedNote, at: MessageLocation): Promise<UpsertResult> {
    const { rows } = await this.db.query<{ inserted: boolean }>(
      `insert into notes as n (id, mailbox, uid, uid_validity, title, html, body_text,
                               created_at, modified_at, attachments, content_hash, synced_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, now())
       on conflict (id) do update set
         mailbox = excluded.mailbox,
         uid = excluded.uid,
         uid_validity = excluded.uid_validity,
         title = excluded.title,
         html = excluded.html,
         body_text = excluded.body_text,
         created_at = excluded.created_at,
         modified_at = excluded.modified_at,
         attachments = excluded.attachments,
         content_hash = excluded.content_hash,
         synced_at = now()
       where (n.content_hash, n.mailbox, n.uid, n.uid_validity)
               is distinct from
             (excluded.content_hash, excluded.mailbox, excluded.uid, excluded.uid_validity)
         and (
           excluded.modified_at > n.modified_at
           or (excluded.modified_at = n.modified_at and (
                 n.uid is null
                 or n.uid_validity is distinct from excluded.uid_validity
                 or n.mailbox <> excluded.mailbox
                 or excluded.uid >= n.uid))
         )
       returning (xmax = 0) as inserted`,
      [
        note.id,
        at.mailbox,
        at.uid,
        at.uidValidity,
        note.title,
        note.html,
        note.text,
        note.createdAt,
        note.modifiedAt,
        JSON.stringify(note.attachments),
        note.contentHash,
      ],
    );
    const row = rows[0];
    if (!row) return 'unchanged';
    return row.inserted ? 'inserted' : 'updated';
  }

  /**
   * Delete the notes of a mailbox whose message is no longer on the server.
   * A note that was edited is NOT deleted here: by the time this runs, the
   * upsert has already moved it to the UID of its new message.
   */
  async deleteMissing(mailbox: string, uidValidity: number, presentUids: number[]): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `delete from notes
        where mailbox = $1
          and (uid is null or uid_validity is distinct from $2 or not (uid = any($3::bigint[])))
        returning id`,
      [mailbox, uidValidity, presentUids],
    );
    return rows.map((r) => r.id);
  }

  async list(search?: string, limit = 200): Promise<NoteSummary[]> {
    const q = search?.trim();
    const { rows } = await this.db.query<Record<string, unknown>>(
      `select id, title, left(body_text, 600) as excerpt, mailbox, uid, created_at, modified_at,
              synced_at, attachments
         from notes
        where ($1::text is null or search @@ websearch_to_tsquery('simple', $1))
        order by ${q ? "ts_rank(search, websearch_to_tsquery('simple', $1)) desc," : ''} modified_at desc
        limit $2`,
      [q || null, limit],
    );
    return rows.map(toSummary);
  }

  async get(id: string): Promise<(NoteSummary & { html: string; text: string }) | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `select id, title, left(body_text, 600) as excerpt, body_text, html, mailbox, uid,
              created_at, modified_at, synced_at, attachments
         from notes where id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return { ...toSummary(row), html: String(row.html), text: String(row.body_text) };
  }

  async stats(): Promise<{ notes: number; mailboxes: Array<Record<string, unknown>> }> {
    const count = await this.db.query<{ n: string | number }>('select count(*) as n from notes');
    const boxes = await this.db.query<Record<string, unknown>>(
      'select mailbox, uid_validity, last_uid, last_full_sync_at, updated_at from mailbox_state order by mailbox',
    );
    return {
      notes: Number(count.rows[0]?.n ?? 0),
      mailboxes: boxes.rows.map((r) => ({
        mailbox: r.mailbox,
        uidValidity: Number(r.uid_validity),
        lastUid: Number(r.last_uid),
        lastFullSyncAt: iso(r.last_full_sync_at),
        updatedAt: iso(r.updated_at),
      })),
    };
  }
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function toSummary(r: Record<string, unknown>): NoteSummary {
  return {
    id: String(r.id),
    title: String(r.title),
    excerpt: excerpt(String(r.excerpt ?? ''), String(r.title)),
    mailbox: String(r.mailbox),
    uid: r.uid == null ? null : Number(r.uid),
    createdAt: iso(r.created_at),
    modifiedAt: iso(r.modified_at)!,
    syncedAt: iso(r.synced_at)!,
    attachments: Array.isArray(r.attachments) ? r.attachments : JSON.parse(String(r.attachments ?? '[]')),
  };
}
