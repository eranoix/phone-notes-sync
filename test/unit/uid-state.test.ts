import { describe, expect, it } from 'vitest';
import { advanceWatermark, diffUids, filterNewUids, planSync, type SyncTrigger } from '../../src/uid-state.js';

const server = { uidValidity: 7, uidNext: 11, exists: 8 };
const t = (...x: SyncTrigger[]) => new Set(x);

describe('planSync', () => {
  it('does a full pass the first time it sees a mailbox', () => {
    expect(planSync(null, server, t('new-messages'))).toEqual({ kind: 'full', reason: 'first-run', resetUids: false });
  });

  it('forgets every stored UID when UIDVALIDITY changes, whatever triggered the pass', () => {
    const stored = { uidValidity: 6, lastUid: 10 };
    for (const trig of ['new-messages', 'expunge', 'connect', 'interval'] as const) {
      expect(planSync(stored, server, t(trig))).toEqual({ kind: 'full', reason: 'uidvalidity-changed', resetUids: true });
    }
  });

  it('treats UIDNEXT at or below the watermark as a recreated mailbox, even with the same UIDVALIDITY', () => {
    const stored = { uidValidity: 7, lastUid: 10 };
    expect(planSync(stored, { uidValidity: 7, uidNext: 3, exists: 2 }, t('new-messages'))).toEqual({
      kind: 'full',
      reason: 'uidnext-went-backwards',
      resetUids: true,
    });
    expect(planSync(stored, { uidValidity: 7, uidNext: 11, exists: 2 }, t('new-messages'))).toEqual({ kind: 'noop' });
  });

  it('does a full pass after a reconnect and on the periodic timer', () => {
    const stored = { uidValidity: 7, lastUid: 10 };
    expect(planSync(stored, server, t('connect'))).toMatchObject({ kind: 'full', reason: 'requested', resetUids: false });
    expect(planSync(stored, server, t('interval', 'new-messages'))).toMatchObject({ kind: 'full' });
  });

  it('fetches only above the watermark when there are new messages', () => {
    expect(planSync({ uidValidity: 7, lastUid: 6 }, server, t('new-messages'))).toEqual({
      kind: 'incremental',
      fromUid: 7,
      reconcileDeletes: false,
    });
  });

  it('reconciles deletions on EXPUNGE, and an edit (EXISTS + EXPUNGE) does both', () => {
    expect(planSync({ uidValidity: 7, lastUid: 10 }, server, t('expunge'))).toEqual({
      kind: 'incremental',
      fromUid: null,
      reconcileDeletes: true,
    });
    expect(planSync({ uidValidity: 7, lastUid: 8 }, server, t('new-messages', 'expunge'))).toEqual({
      kind: 'incremental',
      fromUid: 9,
      reconcileDeletes: true,
    });
  });

  it('does nothing when EXISTS fired but UIDNEXT shows nothing past the watermark', () => {
    expect(planSync({ uidValidity: 7, lastUid: 10 }, server, t('new-messages'))).toEqual({ kind: 'noop' });
  });
});

describe('UID arithmetic', () => {
  it('drops the message `n:*` returns when nothing is above n', () => {
    expect(filterNewUids([10], 10)).toEqual([]);
    expect(filterNewUids([13, 11, 12, 11], 10)).toEqual([11, 12, 13]);
  });

  it('diffs server UIDs against the table, skipping ignored ones', () => {
    expect(diffUids([1, 2, 5, 8], [1, 2, 3, 4], new Set([8]))).toEqual({ toFetch: [5], missing: [3, 4] });
  });

  it('advances the watermark only across UIDs that are done', () => {
    expect(advanceWatermark(4, [
      { uid: 5, done: true },
      { uid: 9, done: true },
      { uid: 7, done: true },
    ])).toBe(9);
    expect(advanceWatermark(4, [
      { uid: 5, done: true },
      { uid: 7, done: false },
      { uid: 9, done: true },
    ])).toBe(5);
    expect(advanceWatermark(4, [])).toBe(4);
    expect(advanceWatermark(4, [{ uid: 3, done: false }])).toBe(4);
  });
});
