// Read-only view of the synced notes. Everything live arrives over one
// EventSource; the list itself always comes from the JSON API, so the page
// can never drift from what is actually in Postgres.
const $ = (id) => document.getElementById(id);
const els = {
  list: $('notes'), empty: $('empty'), q: $('q'),
  live: $('live'), liveText: $('live-text'),
  sNotes: $('s-notes'), sMailbox: $('s-mailbox'), sValidity: $('s-validity'), sLastUid: $('s-lastuid'), sPass: $('s-pass'),
  reader: $('reader'), readerEmpty: $('reader-empty'), rTitle: $('r-title'), rMeta: $('r-meta'),
  rBanner: $('r-banner'), rBody: $('r-body'), rAtt: $('r-attachments'), activity: $('activity'),
};

let selected = new URLSearchParams(location.search).get('note');
let notes = [];
const pendingFlash = new Map();

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const when = (iso) => (iso ? fmt.format(new Date(iso)) : '-');

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

async function loadNotes() {
  const q = els.q.value.trim();
  const res = await fetch('/api/notes' + (q ? '?q=' + encodeURIComponent(q) : ''));
  notes = (await res.json()).notes;
  render();
}

function render() {
  els.list.replaceChildren(
    ...notes.map((n) => {
      const att = n.attachments.length
        ? el('span', { class: 'clip', title: 'attachments' }, `${n.attachments.length} attachment${n.attachments.length > 1 ? 's' : ''}`)
        : null;
      const li = el(
        'li',
        { class: 'note', 'data-id': n.id, 'aria-selected': String(n.id === selected), onclick: () => select(n.id, undefined, true) },
        el('h4', {}, el('span', {}, n.title), att),
        el('p', {}, n.excerpt),
        el('div', { class: 'foot' }, el('span', {}, 'Edited ' + when(n.modifiedAt)), el('span', { class: 'mono' }, 'uid ' + (n.uid ?? '-'))),
      );
      const flash = pendingFlash.get(n.id);
      if (flash) {
        li.classList.add('flash-' + flash);
        setTimeout(() => li.classList.remove('flash-' + flash), 1600);
        pendingFlash.delete(n.id);
      }
      return li;
    }),
  );
  els.empty.hidden = notes.length > 0;
}

async function select(id, banner, fromClick = false) {
  selected = id;
  history.replaceState(null, '', id ? '?note=' + encodeURIComponent(id) : location.pathname);
  for (const li of els.list.children) li.setAttribute('aria-selected', String(li.dataset.id === id));
  const res = await fetch('/api/notes/' + encodeURIComponent(id));
  if (!res.ok) return;
  const n = await res.json();
  els.readerEmpty.hidden = true;
  els.reader.hidden = false;
  els.rTitle.textContent = n.title;
  els.rMeta.textContent = `Created ${when(n.createdAt)}  ·  edited ${when(n.modifiedAt)}  ·  synced ${when(n.syncedAt)}`;
  showBanner(banner);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  els.rBody.srcdoc = `<!doctype html><meta charset="utf-8"><style>
    body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:18px 22px;color:${dark ? '#efe9dd' : '#1f1c17'};background:${dark ? '#201d19' : '#fffdf8'}}
    h1{font-size:1.4em;margin:.2em 0 .6em} img,object{display:none} a{color:inherit}
    ul,ol{padding-left:1.4em} blockquote{margin:0;padding-left:12px;border-left:3px solid #d99a1c}
    table{border-collapse:collapse} td,th{border:1px solid #8884;padding:4px 8px}
  </style>${n.html}`;
  if (fromClick && matchMedia('(max-width: 760px)').matches) els.reader.scrollIntoView({ behavior: 'smooth' });
  els.rAtt.replaceChildren(
    ...n.attachments.map((a) => el('li', {}, `${a.filename ?? 'unnamed'}  ·  ${a.contentType}  ·  ${(a.size / 1024).toFixed(1)} KB`)),
  );
}

function showBanner(kind) {
  if (!kind) { els.rBanner.hidden = true; return; }
  els.rBanner.hidden = false;
  els.rBanner.className = 'banner ' + kind;
  els.rBanner.textContent = kind === 'update' ? 'Updated just now from the mailbox' : 'This note was deleted in the mailbox';
}

function logActivity(kind, label, title) {
  const li = el('li', { class: kind }, el('time', {}, timeFmt.format(new Date())), el('span', { class: 'op' }, label), el('span', { class: 't' }, title));
  els.activity.prepend(li);
  while (els.activity.children.length > 40) els.activity.lastChild.remove();
}

function setLive(state, text) {
  els.live.dataset.state = state;
  els.liveText.textContent = text;
}

function renderStatus(s) {
  if (!s) return;
  if (s.mailbox) els.sMailbox.textContent = s.mailbox;
  const l = s.listener;
  if (s.syncing) setLive('syncing', 'Syncing');
  else if (l?.state === 'idle') setLive('idle', 'IDLE, listening');
  else if (l?.state === 'reconnecting') setLive('reconnecting', `Reconnecting in ${Math.round((l.retryInMs ?? 0) / 1000)}s`);
  else if (l) setLive('starting', l.state[0].toUpperCase() + l.state.slice(1));
  const p = s.lastPass;
  if (p) {
    els.sValidity.textContent = p.uidValidity;
    els.sLastUid.textContent = p.lastUid;
    const parts = [`${p.plan}${p.reason ? ' (' + p.reason + ')' : ''}`];
    for (const k of ['inserted', 'updated', 'deleted', 'skipped', 'failed']) if (p[k]) parts.push(`${p[k]} ${k}`);
    parts.push(`${p.ms} ms`);
    els.sPass.textContent = parts.join(', ');
  }
}

async function refreshStatus() {
  const s = await (await fetch('/api/status')).json();
  els.sNotes.textContent = s.notes;
  renderStatus(s);
}

let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { loadNotes(); refreshStatus(); }, 120);
}

const labels = { insert: 'New', update: 'Edited', delete: 'Deleted' };
function onChange(c) {
  logActivity(c.op, labels[c.op] ?? c.op, c.title);
  if (c.op === 'delete') {
    const li = [...els.list.children].find((x) => x.dataset.id === c.id);
    if (li) li.classList.add('leaving');
    if (c.id === selected) showBanner('delete');
    setTimeout(scheduleReload, 1250);
    return;
  }
  pendingFlash.set(c.id, c.op);
  if (c.id === selected && c.op === 'update') select(c.id, 'update');
  scheduleReload();
}

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('open', () => refreshStatus());
  es.addEventListener('note', (e) => onChange(JSON.parse(e.data)));
  es.addEventListener('resync', () => scheduleReload());
  es.addEventListener('status', (e) => {
    const s = JSON.parse(e.data);
    const before = els.sPass.textContent;
    renderStatus(s);
    if (s.lastPass && s.lastPass.plan !== 'noop' && !s.syncing && els.sPass.textContent !== before) {
      logActivity('pass', 'Sync pass', els.sPass.textContent);
    }
  });
  es.addEventListener('error', () => setLive('offline', 'Page offline, retrying'));
}

let searchTimer = null;
els.q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadNotes, 200); });

await Promise.all([loadNotes(), refreshStatus()]);
if (selected && notes.some((n) => n.id === selected)) select(selected);
connect();
