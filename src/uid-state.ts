export interface StoredMailboxState {
  uidValidity: number;
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
      kind: 'full';
      reason: 'first-run' | 'uidvalidity-changed' | 'uidnext-went-backwards' | 'requested';
      resetUids: boolean;
    }
  | {
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
    return { kind: 'full', reason: 'uidvalidity-changed', resetUids: true };
  }
  if (server.uidNext <= stored.lastUid) {
    return { kind: 'full', reason: 'uidnext-went-backwards', resetUids: true };
  }
  if (triggers.has('connect') || triggers.has('interval')) {
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

export function filterNewUids(uids: Iterable<number>, lastUid: number): number[] {
  return [...new Set(uids)].filter((uid) => uid > lastUid).sort((a, b) => a - b);
}

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
