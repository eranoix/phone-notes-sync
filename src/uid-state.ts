/**
 * UID bookkeeping, kept pure so every rule here is unit-tested without a
 * server.
 *
 * The facts IMAP gives us (RFC 3501, section 2.3.1.1):
 *   - A UID never changes and is never reused while UIDVALIDITY stays the same.
 *   - UIDs are strictly ascending, so "everything above the last UID I saw"
 *     is exactly the set of new messages.
 *   - A message's content never changes. An edited note is a NEW message.
 *   - If UIDVALIDITY changes, every UID we stored is meaningless.
 */

export interface StoredMailboxState {
  uidValidity: number;
  /** Highest UID fully processed; everything at or below it is in the table. */
  lastUid: number;
}

export interface ServerMailboxState {
  uidValidity: number;
  uidNext: number;
  exists: number;
}

export type SyncTrigger = 'connect' | 'new-messages' | 'expunge' | 'interval';

export type SyncPlan =
  | {
      /** Compare the full UID list with the table: fetch unknown UIDs, drop missing ones. */
      kind: 'full';
      reason: 'first-run' | 'uidvalidity-changed' | 'uidnext-went-backwards' | 'requested';
      /** True when every stored UID must be forgotten before the pass. */
      resetUids: boolean;
    }
  | {
      /** Fetch only UIDs above `fromUid`; optionally reconcile deletions. */
      kind: 'incremental';
      fromUid: number | null;
      reconcileDeletes: boolean;
    }
  | { kind: 'noop' };

export function planSync(
  stored: StoredMailboxState | null,
  server: ServerMailboxState,
  triggers: ReadonlySet<SyncTrigger>,
): SyncPlan {
  if (stored === null) {
    return { kind: 'full', reason: 'first-run', resetUids: false };
  }
  if (stored.uidValidity !== server.uidValidity) {
    // The mailbox was recreated or the server rebuilt its index. Our UIDs now
    // point at nothing, or worse, at different messages. Forget them all; the
    // note identities in the table survive, so nothing flickers on the page.
    return { kind: 'full', reason: 'uidvalidity-changed', resetUids: true };
  }
  if (server.uidNext <= stored.lastUid) {
    // UIDNEXT never goes down and is always above every existing UID, so
    // seeing it at or below a UID we already processed means the mailbox was
    // recreated WITHOUT a new UIDVALIDITY. That is a server bug, but a real
    // one: GreenMail derives UIDVALIDITY from a clock with one-second
    // resolution, so a mailbox deleted and recreated within the same second
    // keeps it. Left alone, every new message would sit below the watermark
    // and never be fetched. Treat it exactly like a UIDVALIDITY change.
    return { kind: 'full', reason: 'uidnext-went-backwards', resetUids: true };
  }
  if (triggers.has('connect') || triggers.has('interval')) {
    // After a reconnect we cannot know what we missed while offline, and the
    // periodic pass is the safety net for any event a server failed to send.
    return { kind: 'full', reason: 'requested', resetUids: false };
  }

  const hasNew = server.uidNext - 1 > stored.lastUid;
  const reconcileDeletes = triggers.has('expunge');
  if (!hasNew && !reconcileDeletes) return { kind: 'noop' };
  return {
    kind: 'incremental',
    fromUid: hasNew ? stored.lastUid + 1 : null,
    reconcileDeletes,
  };
}

/**
 * `UID FETCH 42:*` always returns at least one message: `*` means "the last
 * one", even when its UID is below 42. Anything at or below the watermark was
 * already processed, so it is filtered out here rather than trusted.
 */
export function filterNewUids(uids: Iterable<number>, lastUid: number): number[] {
  return [...new Set(uids)].filter((uid) => uid > lastUid).sort((a, b) => a - b);
}

/** What a full pass has to fetch and what it has to forget. */
export function diffUids(
  onServer: Iterable<number>,
  inTable: Iterable<number>,
  ignored: ReadonlySet<number> = new Set(),
): { toFetch: number[]; missing: number[] } {
  const server = new Set(onServer);
  const table = new Set(inTable);
  const toFetch = [...server].filter((uid) => !table.has(uid) && !ignored.has(uid)).sort((a, b) => a - b);
  const missing = [...table].filter((uid) => !server.has(uid)).sort((a, b) => a - b);
  return { toFetch, missing };
}

/**
 * The new watermark after a batch. It may only move past UIDs that are done:
 * stored, or permanently rejected (not a note). A UID that failed with a
 * transient error holds the watermark just below itself, so the next pass
 * picks it up again instead of skipping it forever.
 */
export function advanceWatermark(
  previous: number,
  outcomes: ReadonlyArray<{ uid: number; done: boolean }>,
): number {
  const sorted = [...outcomes].sort((a, b) => a.uid - b.uid);
  let mark = previous;
  for (const o of sorted) {
    if (o.uid <= mark) continue;
    if (!o.done) break;
    mark = o.uid;
  }
  return mark;
}
