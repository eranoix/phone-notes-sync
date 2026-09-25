import { randomBytes } from 'node:crypto';

/**
 * Builds a message the way Apple Notes stores a note over IMAP. Used by the
 * demo seeder and the tests, so both exercise exactly the format the parser
 * has to read in production.
 */
export interface NoteDraft {
  id: string;
  title: string;
  html: string;
  createdAt: Date;
  modifiedAt: Date;
  from?: string;
  attachments?: Array<{ filename: string; contentType: string; content: Buffer; contentId: string }>;
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?utf-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

function qp(text: string): string {
  // Quoted-printable, which is what Notes uses for the HTML part.
  const bytes = Buffer.from(text, 'utf-8');
  let out = '';
  let lineLen = 0;
  for (const b of bytes) {
    let chunk: string;
    if (b === 0x0a) {
      out += '\r\n';
      lineLen = 0;
      continue;
    } else if (b === 0x0d) {
      continue;
    } else if ((b >= 33 && b <= 126 && b !== 61) || b === 32) {
      chunk = String.fromCharCode(b);
    } else {
      chunk = '=' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    if (lineLen + chunk.length > 75) {
      out += '=\r\n';
      lineLen = 0;
    }
    out += chunk;
    lineLen += chunk.length;
  }
  return out;
}

function base64Lines(buf: Buffer): string {
  return buf.toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

export function buildNoteMessage(draft: NoteDraft): Buffer {
  const from = draft.from ?? 'notes@example.com';
  const headers = [
    `From: ${from}`,
    `Subject: ${encodeHeader(draft.title)}`,
    `Date: ${draft.modifiedAt.toUTCString()}`,
    `X-Mail-Created-Date: ${draft.createdAt.toUTCString()}`,
    `X-Uniform-Type-Identifier: com.apple.mail-note`,
    `X-Universally-Unique-Identifier: ${draft.id}`,
    `Message-Id: <${draft.id.toLowerCase()}.${draft.modifiedAt.getTime()}@example.com>`,
    `Mime-Version: 1.0 (Mac OS X Notes 4.11)`,
  ];

  const attachments = draft.attachments ?? [];
  if (attachments.length === 0) {
    return Buffer.from(
      [
        ...headers,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        qp(draft.html),
        '',
      ].join('\r\n'),
      'utf-8',
    );
  }

  const boundary = `Apple-Mail=_${randomBytes(12).toString('hex')}`;
  const parts: string[] = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    qp(draft.html),
  ];
  for (const a of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      // Images sit inline in the note; anything else is a regular attachment.
      `Content-Disposition: ${a.contentType.startsWith('image/') ? 'inline' : 'attachment'}; filename="${a.filename}"`,
      `Content-Id: <${a.contentId}>`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(a.content),
    );
  }
  parts.push(`--${boundary}--`, '');
  return Buffer.from(parts.join('\r\n'), 'utf-8');
}
