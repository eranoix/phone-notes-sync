/**
 * The schema, applied on boot. Every statement is idempotent, so a restart
 * against an existing database is a no-op and there is no migration tool to
 * install for a project this size.
 */
export const SCHEMA_SQL = `
create table if not exists notes (
  id            text primary key,          -- X-Universally-Unique-Identifier
  mailbox       text not null,
  uid           bigint,                    -- UID of the message holding this version
  uid_validity  bigint,
  title         text not null,
  html          text not null,
  body_text     text not null,
  created_at    timestamptz,
  modified_at   timestamptz not null,
  attachments   jsonb not null default '[]'::jsonb,
  content_hash  text not null,
  synced_at     timestamptz not null default now(),
  search        tsvector generated always as (
                  setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                  setweight(to_tsvector('simple', coalesce(body_text, '')), 'B')
                ) stored
);

create index if not exists notes_mailbox_uid_idx on notes (mailbox, uid);
create index if not exists notes_modified_idx on notes (modified_at desc);
create index if not exists notes_search_idx on notes using gin (search);

create table if not exists mailbox_state (
  mailbox            text primary key,
  uid_validity       bigint not null,
  last_uid           bigint not null default 0,
  last_full_sync_at  timestamptz,
  updated_at         timestamptz not null default now()
);

-- Every change to a note is announced on a channel. The web page listens
-- there instead of asking the sync worker, so any other writer (a backfill
-- script, a manual fix in psql) shows up live too.
create or replace function notes_notify() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.content_hash = old.content_hash then
    -- Only the UID moved (for example after a UIDVALIDITY reset): nothing a reader would see.
    return new;
  end if;
  perform pg_notify('notes_changed', json_build_object(
    'op', lower(tg_op),
    'id', coalesce(new.id, old.id),
    'title', coalesce(new.title, old.title)
  )::text);
  return coalesce(new, old);
end;
$$;

drop trigger if exists notes_notify_trg on notes;
create trigger notes_notify_trg
  after insert or update or delete on notes
  for each row execute function notes_notify();
`;
