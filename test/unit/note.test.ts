import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNote } from '../../src/note.js';
import { buildNoteMessage } from '../../src/note-format.js';
import { excerpt, htmlToText, titleFromHtml } from '../../src/html.js';
import { PermanentError } from '../../src/queue.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

describe('parseNote: the Apple Notes MIME format', () => {
  it('reads a quoted-printable HTML note with an encoded subject', async () => {
    const note = await parseNote(fixture('qp-html.eml'));
    expect(note.id).toBe('0E3B6C1F-7A2D-4F4E-9B7C-2D1A5E8F9C10');
    expect(note.title).toBe('Café list');
    expect(note.html).toContain('<h1>Café list</h1>');
    expect(note.html).toContain('Try the place on 5th &amp; Main');
    expect(note.text).toBe('Café list\nTry the place on 5th & Main\n\nFlat white → good');
    expect(note.modifiedAt.toISOString()).toBe('2026-07-14T12:41:07.000Z');
    expect(note.createdAt?.toISOString()).toBe('2026-07-13T21:02:55.000Z');
    expect(note.attachments).toEqual([]);
  });

  it('keeps the HTML part of a multipart note and lists attachments as metadata', async () => {
    const note = await parseNote(fixture('multipart-attachment.eml'));
    expect(note.title).toBe('Whiteboard photo');
    expect(note.html).toContain('data="cid:1F2E3D4C-board@example.com"');
    expect(note.attachments).toEqual([
      { filename: 'board.png', contentType: 'image/png', size: 70, contentId: '1F2E3D4C-board@example.com' },
    ]);
  });

  it('falls back to the first line of the body when there is no Subject', async () => {
    const note = await parseNote(fixture('base64-no-subject.eml'));
    expect(note.title).toBe('Packing list');
    expect(note.text).toBe('Packing list\n- Passport\n- Charger\n- Sunscreen');
    expect(note.createdAt).toBeNull();
  });

  it('rejects a message that is not a note, permanently', async () => {
    await expect(parseNote(fixture('not-a-note.eml'))).rejects.toBeInstanceOf(PermanentError);
  });

  it('rejects a note whose type identifier says it is something else', async () => {
    const src = fixture('qp-html.eml').toString().replace('com.apple.mail-note', 'public.plain-text');
    await expect(parseNote(src)).rejects.toThrow(/X-Uniform-Type-Identifier/);
  });

  it('wraps a plain-text note in HTML so consumers always get HTML', async () => {
    const src = [
      'Subject: Plain',
      'Date: Thu, 16 Jul 2026 08:00:00 +0000',
      'X-Universally-Unique-Identifier: 11111111-2222-4333-8444-555555555555',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'first line',
      'a < b',
    ].join('\r\n');
    const note = await parseNote(src);
    expect(note.html).toBe('<div>first line</div><div>a &lt; b</div>');
    expect(note.text).toBe('first line\na < b');
  });

  it('round-trips what the demo seeder writes, attachments included', async () => {
    const modifiedAt = new Date('2026-08-01T10:00:00Z');
    const src = buildNoteMessage({
      id: 'ABCDEF01-2345-4678-89AB-CDEF01234567',
      title: 'Naïve über-quick plan',
      html: '<div><h1>Naïve über-quick plan</h1></div><div>long line '.padEnd(300, 'x') + '</div>',
      createdAt: new Date('2026-07-30T10:00:00Z'),
      modifiedAt,
      attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-'), contentId: 'a@example.com' }],
    });
    const note = await parseNote(src);
    expect(note.title).toBe('Naïve über-quick plan');
    expect(note.html).toContain('x'.repeat(200));
    expect(note.modifiedAt).toEqual(modifiedAt);
    expect(note.attachments).toMatchObject([{ filename: 'a.pdf', contentType: 'application/pdf', size: 5, contentId: 'a@example.com' }]);
  });

  it('gives the same content hash to the same message and a different one to an edit', async () => {
    const a = await parseNote(fixture('qp-html.eml'));
    const b = await parseNote(fixture('qp-html.eml'));
    const edited = await parseNote(fixture('qp-html.eml').toString().replace('Flat white', 'Espresso'));
    expect(a.contentHash).toBe(b.contentHash);
    expect(edited.contentHash).not.toBe(a.contentHash);
  });
});

describe('html helpers', () => {
  it('turns blocks into lines and decodes entities', () => {
    expect(htmlToText('<div>a&nbsp;&amp;&#x41;&#66;</div><p>c</p><br><br><br><div>d</div>')).toBe('a &AB\nc\n\nd');
  });
  it('finds the title in the first non-empty block', () => {
    expect(titleFromHtml('<div><br></div><div><b>Title</b> here</div><div>rest</div>')).toBe('Title here');
    expect(titleFromHtml('<div><br></div>')).toBeNull();
  });
  it('builds a preview without repeating the title', () => {
    expect(excerpt('Groceries\n- Oat milk\n- Lemons', 'Groceries')).toBe('Oat milk · Lemons');
    expect(excerpt('Other first line\nmore', 'Title')).toBe('Other first line · more');
    expect(excerpt('T\n' + 'x'.repeat(300), 'T', 10)).toBe('xxxxxxxxx…');
  });
});
