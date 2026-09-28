import { createHash } from 'node:crypto';
import { simpleParser, type AddressObject } from 'mailparser';
import { htmlToText, titleFromHtml } from './html.js';
import { PermanentError } from './queue.js';

export const NOTE_UTI = 'com.apple.mail-note';

export interface AttachmentMeta {
  filename: string | null;
  contentType: string;
  size: number;
  contentId: string | null;
}

export interface ParsedNote {
  id: string;
  title: string;
  html: string;
  text: string;
  createdAt: Date | null;
  modifiedAt: Date;
  attachments: AttachmentMeta[];
  contentHash: string;
}

function headerText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (value instanceof Date) return value.toUTCString();
  if (typeof value === 'object' && 'text' in (value as AddressObject)) {
    return (value as AddressObject).text || null;
  }
  return String(value).trim() || null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hashNote(n: Omit<ParsedNote, 'contentHash'>): string {
  return createHash('sha256')
    .update(JSON.stringify([n.title, n.html, n.createdAt?.toISOString() ?? null, n.modifiedAt.toISOString(), n.attachments]))
    .digest('hex');
}

export async function parseNote(source: Buffer | string): Promise<ParsedNote> {
  const mail = await simpleParser(source, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
  });

  const id = headerText(mail.headers.get('x-universally-unique-identifier'));
  if (!id) {
    throw new PermanentError('message has no X-Universally-Unique-Identifier, not an Apple note');
  }
  const uti = headerText(mail.headers.get('x-uniform-type-identifier'));
  if (uti && uti !== NOTE_UTI) {
    throw new PermanentError(`unexpected X-Uniform-Type-Identifier "${uti}"`);
  }

  let html = typeof mail.html === 'string' ? mail.html : '';
  if (!html && mail.text) {
    html = mail.text
      .split(/\r?\n/)
      .map((line) => `<div>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '<br>'}</div>`)
      .join('');
  }
  html = html.trim();

  const title = (mail.subject ?? '').trim() || titleFromHtml(html) || 'Untitled note';
  const modifiedAt = mail.date ?? null;
  if (!modifiedAt || Number.isNaN(modifiedAt.getTime())) {
    throw new PermanentError('note has no usable Date header');
  }
  const createdAt = parseDate(headerText(mail.headers.get('x-mail-created-date')));

  const attachments: AttachmentMeta[] = mail.attachments.map((a) => ({
    filename: a.filename ?? null,
    contentType: a.contentType,
    size: a.size,
    contentId: a.contentId ? a.contentId.replace(/^<|>$/g, '') : null,
  }));

  const note = {
    id,
    title,
    html,
    text: htmlToText(html),
    createdAt,
    modifiedAt,
    attachments,
  };
  return { ...note, contentHash: hashNote(note) };
}
