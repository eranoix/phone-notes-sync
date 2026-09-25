import type { FetchedMessage, MailboxSession, MailSource } from '../../src/sync.js';

/**
 * An in-memory IMAP mailbox with the semantics that matter here: ascending
 * UIDs that are never reused, immutable messages, and a UIDVALIDITY that can
 * be changed to simulate the server rebuilding the mailbox.
 */
export class FakeMailbox implements MailSource {
  uidValidity = 1000;
  private uidNext = 1;
  readonly messages = new Map<number, Buffer>();
  opens = 0;
  fetchedUids: number[] = [];
  /** Answer the next listUids() with nothing, like a misbehaving server. */
  lieAboutUids = false;

  append(source: Buffer | string): number {
    const uid = this.uidNext++;
    this.messages.set(uid, Buffer.from(source));
    return uid;
  }

  expunge(uid: number): void {
    this.messages.delete(uid);
  }

  /**
   * Every message renumbered from 1: what a rebuilt mailbox looks like. With
   * `keepValidity` it imitates a server that forgets to change UIDVALIDITY.
   */
  rebuild(keepValidity = false): Map<number, number> {
    const old = [...this.messages.entries()].sort((a, b) => a[0] - b[0]);
    this.messages.clear();
    if (!keepValidity) this.uidValidity += 1;
    this.uidNext = 1;
    const mapping = new Map<number, number>();
    for (const [uid, src] of old) mapping.set(uid, this.append(src));
    return mapping;
  }

  async open(): Promise<MailboxSession> {
    this.opens++;
    const snapshot = { uidValidity: this.uidValidity, uidNext: this.uidNext, exists: this.messages.size };
    return {
      snapshot,
      listUids: async () => {
        if (this.lieAboutUids) return [];
        return [...this.messages.keys()].sort((a, b) => a - b);
      },
      fetch: (range) => this.fetch(range),
      close: async () => undefined,
    };
  }

  private async *fetch(range: number[] | { from: number }): AsyncIterable<FetchedMessage> {
    const all = [...this.messages.keys()].sort((a, b) => a - b);
    let uids: number[];
    if (Array.isArray(range)) {
      uids = all.filter((u) => range.includes(u));
    } else {
      // Real IMAP: `n:*` includes the highest UID even when it is below n.
      uids = all.filter((u) => u >= range.from);
      const last = all[all.length - 1];
      if (uids.length === 0 && last !== undefined) uids = [last];
    }
    for (const uid of uids) {
      this.fetchedUids.push(uid);
      yield { uid, source: this.messages.get(uid)! };
    }
  }
}
