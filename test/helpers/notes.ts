import { buildNoteMessage } from '../../src/note-format.js';

let counter = 0;

export function noteId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function noteSource(opts: { id: string; title: string; body?: string; modified?: Date }): Buffer {
  counter++;
  const modified = opts.modified ?? new Date(Date.UTC(2026, 6, 1, 12, 0, counter));
  return buildNoteMessage({
    id: opts.id,
    title: opts.title,
    html: `<div><h1>${opts.title}</h1></div><div>${opts.body ?? 'body'}</div>`,
    createdAt: new Date(Date.UTC(2026, 5, 1)),
    modifiedAt: modified,
  });
}
