'use strict';
(function () {
  const api = window.huddle;
  const $ = (s) => document.querySelector(s);

  const state = {
    rooms: [],
    activeId: null,
    transcript: [],
    config: null,
    status: { running: {}, queued: {} },
    found: {}, // agentId -> { found, path }
    skills: [], // shared skill library: { slug, name, description }
  };
  const els = new Map(); // message id -> element
  const drafts = {}; // roomId -> unsent text
  const pendingByRoom = {}; // roomId -> [{ name, mime, data, url }] attached but not sent yet
  const MAX_FILE = 25 * 1024 * 1024;
  const MAX_FILES = 10;
  let loadToken = 0;

  // "seen" = last message id you've looked at in each room (drives the pink unread dot)
  let seen = {};
  try {
    seen = JSON.parse(localStorage.getItem('huddle-seen') || '{}') || {};
  } catch (_) {
    seen = {};
  }
  function saveSeen() {
    try {
      localStorage.setItem('huddle-seen', JSON.stringify(seen));
    } catch (_) {}
  }

  // ---------- helpers ----------

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 3600);
  }

  // white or dark text, whichever reads better on a given agent color
  function readable(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return '#ffffff';
    const v = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
    const L = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    return 1.05 / (L + 0.05) >= (L + 0.05) / 0.057 ? '#ffffff' : '#141414';
  }
  const themeColor = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#ff5fa2';
  const agent = (id) => state.config && state.config.agents[id];

  // Avatar art lives in renderer/avatars/<team>/<agent>.png. Teams without art yet fall back to initials.
  // Which picture folder each agent uses per team. Black-and-white art, so every skin looks right.
  const AVATAR_ART = {
    mixed: { claude: 'boys', codex: 'girls', grok: 'boys' },
    girls: { claude: 'girls', codex: 'girls', grok: 'girls' },
    boys: { claude: 'boys', codex: 'boys', grok: 'boys' },
  };
  const TEAM_NAMES = {
    mixed: { title: 'Mixed team', names: ['Claude', 'Codexa', 'Grok'] },
    girls: { title: 'All girls', names: ['Claudette', 'Codexa', 'Grokette'] },
    boys: { title: 'All boys', names: ['Claude', 'Codex', 'Grok'] },
  };
  const teamId = () => (state.config && state.config.settings.team) || 'mixed';
  const youUrl = () => {
    const a = state.config && state.config.settings.userAvatar;
    return a ? `avatars/you/${a}.png` : null;
  };
  function avatarUrl(id, team) {
    const dir = (AVATAR_ART[team || teamId()] || {})[id];
    return dir ? `avatars/${dir}/${id}.png` : null;
  }
  function fillAvatar(el, id, initial, team) {
    const url = id === 'you' ? youUrl() : avatarUrl(id, team);
    el.textContent = '';
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.draggable = false;
      el.classList.add('art');
      el.append(img);
    } else {
      el.classList.remove('art');
      el.textContent = initial;
    }
  }
  const activeRoom = () => state.rooms.find((r) => r.id === state.activeId) || null;
  const roomRunning = (rid) => (state.status.running && state.status.running[rid]) || [];
  const roomQueued = (rid) => (state.status.queued && state.status.queued[rid]) || {};
  const roomBusy = (rid) => roomRunning(rid).length > 0 || Object.keys(roomQueued(rid)).length > 0;

  function nameOf(from) {
    if (from === 'you') return state.config.settings.userName || 'You';
    const a = agent(from);
    return a ? a.label : from;
  }

  function colorOf(from) {
    if (from === 'you') return themeColor('--pink');
    const a = agent(from);
    return a ? a.color : '#141414';
  }

  function mentionRegex() {
    const names = Object.keys(state.config.agents).concat(['all', 'everyone']);
    return new RegExp('(^|[^\\w@.])@(' + names.join('|') + ')(?![\\w-])', 'gi');
  }

  // Tiny, safe renderer: code fences, inline code, bold, @mentions. Everything is escaped first.
  function renderBody(text) {
    const parts = String(text).split(/```/);
    let html = '';
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const body = part.replace(/^[\w+-]*\n/, '');
        html += '<pre><code>' + esc(body.replace(/\n$/, '')) + '</code></pre>';
      } else {
        let s = esc(part);
        s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
        s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(mentionRegex(), (m, pre, name) => {
          const id = name.toLowerCase();
          const c = id === 'all' || id === 'everyone' ? themeColor('--pink') : colorOf(id);
          return `${pre}<span class="mention" style="--c:${c}">@${name}</span>`;
        });
        if (state.skills.length) {
          const re = new RegExp('(^|\\s)/(' + state.skills.map((k) => escRe(esc(k.slug))).join('|') + ')(?![\\w.-])', 'gi');
          s = s.replace(re, (m, pre, name) => `${pre}<span class="skilltag">/${name}</span>`);
        }
        html += s;
      }
    });
    return html;
  }

  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  const extOf = (name) => (String(name).split('.').pop() || 'file').slice(0, 4);

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // ---------- messages ----------

  function buildMessage(m) {
    if (m.from === 'system') {
      const d = document.createElement('div');
      d.className = 'sys' + (m.kind === 'error' ? ' error' : '');
      d.textContent = m.text;
      return d;
    }
    const wrap = document.createElement('div');
    wrap.className = 'msg' + (m.from === 'you' ? ' me' : '');
    wrap.style.setProperty('--c', colorOf(m.from));
    wrap.style.setProperty('--on-c', readable(colorOf(m.from)));

    const av = document.createElement('div');
    av.className = 'avatar';
    fillAvatar(av, m.from, nameOf(m.from).slice(0, 1).toUpperCase());

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span class="name">${esc(nameOf(m.from))}</span><span class="time">${fmtTime(m.ts)}</span>`;

    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = renderBody(m.text);

    bubble.append(meta);
    if (m.text) bubble.append(body);
    if (m.attachments && m.attachments.length) bubble.append(buildAttachments(m.attachments));

    if (m.handoffs && m.handoffs.length) {
      const h = document.createElement('div');
      h.className = 'handoffs';
      h.append(document.createTextNode('Tagged, not sent yet:'));
      m.handoffs.forEach((id) => {
        const a = agent(id);
        if (!a) return;
        const b = document.createElement('button');
        b.className = 'btn small';
        b.textContent = 'Send to ' + a.label + ' →';
        b.addEventListener('click', () => api.relay(state.activeId, id, m.id));
        h.append(b);
      });
      bubble.append(h);
    }

    if (m.from === 'you') wrap.append(bubble, av);
    else wrap.append(av, bubble);
    return wrap;
  }

  function buildAttachments(list) {
    const box = document.createElement('div');
    box.className = 'atts';
    list.forEach((a) => {
      if (a.kind === 'image') {
        const img = document.createElement('img');
        img.className = 'att-img';
        img.alt = a.name;
        img.title = `${a.name} (${fmtSize(a.size)}). Click to open.`;
        img.addEventListener('click', () => api.openFile(a.path));
        img.addEventListener('load', () => {
          const sb = $('#messages');
          if (sb && nearBottom()) scrollDown();
        });
        api.fileData(a.path).then((u) => {
          if (u) img.src = u;
          else img.replaceWith(fileChip(a));
        });
        box.append(img);
      } else {
        box.append(fileChip(a));
      }
    });
    return box;
  }

  function fileChip(a) {
    const wrap = document.createElement('div');
    wrap.className = 'att-file';
    const ext = document.createElement('span');
    ext.className = 'ext';
    ext.textContent = extOf(a.name);
    const info = document.createElement('span');
    info.className = 'finfo';
    info.innerHTML = `<span class="fname">${esc(a.name)}</span> <span class="fsize">${fmtSize(a.size)}</span>`;
    const open = document.createElement('button');
    open.className = 'btn small';
    open.textContent = 'Open';
    open.addEventListener('click', () => api.openFile(a.path));
    const show = document.createElement('button');
    show.className = 'btn small';
    show.textContent = 'Show';
    show.title = 'Show in its folder';
    show.addEventListener('click', () => api.revealFile(a.path));
    wrap.append(ext, info, open, show);
    return wrap;
  }

  function nearBottom() {
    const el = $('#messages');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  function scrollDown() {
    const el = $('#messages');
    el.scrollTop = el.scrollHeight;
  }

  function renderEmpty() {
    const box = $('#messages');
    box.innerHTML = '';
    const r = activeRoom();
    const d = document.createElement('div');
    d.className = 'empty';
    const max = state.config.settings.maxAutoRuns;
    const names = r ? r.agents.map((id) => '<code>@' + esc(id) + '</code>').join(', ') : '';
    d.innerHTML =
      `<h2>${r ? esc(r.name) + ' is empty. ' : ''}<span class="rainbow">Suspicious.</span></h2>` +
      '<p>Say hi. ' +
      (names ? names + ' talks to one of them, ' : '') +
      '<code>@all</code> asks everyone in this room at once. Attach files with <code>+</code>, drag them in, or paste an image. ' +
      'They can tag each other too' +
      (state.config.settings.capHandoffs === false
        ? ', and right now there is no cap on the back-and-forth, so press Stop if it runs away.</p>'
        : ', and I cap that back-and-forth at ' + esc(max) + ' automatic hand-offs per message so nobody quietly burns through your usage.</p>');
    const found = Object.values(state.found);
    if (found.length && found.every((f) => !f.found)) {
      const tip = document.createElement('p');
      tip.innerHTML =
        '<strong>Heads up:</strong> none of the three CLIs were found on this computer. AI Huddle uses the Claude, Codex and Grok command-line tools you\'re already logged into, so install and log into at least one, then open Settings → Check my CLIs. The README has the steps.';
      d.append(tip);
    }
    box.append(d);
  }

  function renderAll() {
    const box = $('#messages');
    box.innerHTML = '';
    els.clear();
    if (!state.transcript.length) return renderEmpty();
    const frag = document.createDocumentFragment();
    state.transcript.forEach((m) => {
      const el = buildMessage(m);
      els.set(m.id, el);
      frag.append(el);
    });
    box.append(frag);
    scrollDown();
  }

  function markSeen(roomId, id) {
    if (id && (seen[roomId] || 0) < id) {
      seen[roomId] = id;
      saveSeen();
    }
  }

  function addMessage(m) {
    const r = state.rooms.find((x) => x.id === m.room);
    if (r && m.id > r.lastId) r.lastId = m.id;
    if (r) r.count = (r.count || 0) + 1;

    if (m.room !== state.activeId) return renderRooms();

    if (els.has(m.id) || state.transcript.some((x) => x.id === m.id)) return updateMessage(m);
    const stick = nearBottom() || m.from === 'you';
    if (!state.transcript.length) $('#messages').innerHTML = '';
    state.transcript.push(m);
    const el = buildMessage(m);
    els.set(m.id, el);
    $('#messages').append(el);
    if (stick) scrollDown();
    markSeen(m.room, m.id);
    renderRooms();
  }

  function updateMessage(m) {
    if (m.room !== state.activeId) return;
    const i = state.transcript.findIndex((x) => x.id === m.id);
    if (i >= 0) state.transcript[i] = m;
    const old = els.get(m.id);
    const el = buildMessage(m);
    if (old && old.parentNode) old.replaceWith(el);
    else if (!old) $('#messages').append(el);
    els.set(m.id, el);
  }

  // ---------- sidebar ----------

  function isUnread(r) {
    return r.id !== state.activeId && r.lastId > (seen[r.id] || 0);
  }

  let showArchived = false;

  function roomRow(r) {
    const row = document.createElement('div');
    const unread = isUnread(r);
    row.className = 'room-row' + (r.archived ? ' archived' : '');
    const b = document.createElement('button');
    b.className = 'room-btn' + (r.id === state.activeId ? ' active' : '') + (unread ? ' unread' : '');
    b.title = r.topic ? `${r.name}: ${r.topic}` : r.name;
    const mark = roomBusy(r.id)
      ? '<span class="busy-dot" title="Working"></span>'
      : unread
      ? '<span class="badge" title="New messages"></span>'
      : '<span class="slot"></span>';
    b.innerHTML = `${mark}<span class="rname">${esc(r.name)}</span>`;
    b.addEventListener('click', () => selectRoom(r.id));
    b.addEventListener('dblclick', () => openRoomSheet(r));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openRoomMenu(r, e.clientX, e.clientY);
    });
    const more = document.createElement('button');
    more.className = 'room-more';
    more.textContent = '⋯';
    more.title = 'Rename, archive or delete';
    more.setAttribute('aria-label', `Options for ${r.name}`);
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const rc = more.getBoundingClientRect();
      openRoomMenu(r, rc.left, rc.bottom + 4);
    });
    row.append(b, more);
    return row;
  }

  function renderRooms() {
    const box = $('#rooms');
    box.innerHTML = '';
    const live = state.rooms.filter((r) => !r.archived);
    const old = state.rooms.filter((r) => r.archived);
    live.forEach((r) => box.append(roomRow(r)));
    if (old.length) {
      const t = document.createElement('button');
      t.className = 'arch-toggle';
      t.setAttribute('aria-expanded', String(showArchived));
      t.textContent = `${showArchived ? '▾' : '▸'} Archived (${old.length})`;
      t.addEventListener('click', () => {
        showArchived = !showArchived;
        renderRooms();
      });
      box.append(t);
      if (showArchived) old.forEach((r) => box.append(roomRow(r)));
    }
  }

  // ---------- room menu (right-click or the ⋯ button) ----------

  const ctx = document.createElement('div');
  ctx.className = 'ctx';
  ctx.hidden = true;
  ctx.setAttribute('role', 'menu');
  document.body.append(ctx);

  function closeMenu() {
    ctx.hidden = true;
    ctx.innerHTML = '';
  }

  function openRoomMenu(r, x, y) {
    ctx.innerHTML = '';
    const add = (label, fn, danger) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      if (danger) b.className = 'danger';
      b.addEventListener('click', () => {
        closeMenu();
        fn();
      });
      ctx.append(b);
    };
    add('Rename…', () => openRoomSheet(r));
    add('Export chat…', async () => {
      const p = await api.exportChat(r.id);
      if (p) toast('Saved to ' + p);
    });
    add(r.archived ? 'Unarchive' : 'Archive', () => archiveRoom(r, !r.archived));
    add('Delete…', () => deleteRoomUI(r), true);
    ctx.hidden = false;
    const w = ctx.offsetWidth;
    const h = ctx.offsetHeight;
    ctx.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
    ctx.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';
    const first = ctx.querySelector('button');
    if (first) first.focus();
  }

  document.addEventListener('mousedown', (e) => {
    if (!ctx.hidden && !ctx.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  window.addEventListener('blur', closeMenu);

  const firstLive = (exceptId) => state.rooms.find((x) => !x.archived && x.id !== exceptId) || null;

  async function archiveRoom(r, on) {
    await api.updateRoom(r.id, { archived: on });
    await refreshRooms();
    const now = state.rooms.find((x) => x.id === r.id);
    if (on && now && now.archived) {
      toast(`Archived ${r.name}. Find it under Archived in the sidebar.`);
      if (state.activeId === r.id) {
        const next = firstLive(r.id);
        if (next) selectRoom(next.id);
      }
    }
    renderAllChrome();
  }

  async function deleteRoomUI(r) {
    if (!confirm(`Delete ${r.name} and all its messages? This can't be undone. (Archive keeps it.)`)) return;
    const ok = await api.deleteRoom(r.id);
    if (ok === false) toast("Can't delete your only active room. Make another one first.");
  }

  function renderWho() {
    const box = $('#who-list');
    box.innerHTML = '';
    const anyRunning = new Set();
    Object.values(state.status.running || {}).forEach((l) => l.forEach((id) => anyRunning.add(id)));
    Object.entries(state.config.agents).forEach(([id, a]) => {
      const f = state.found[id];
      const busy = anyRunning.has(id);
      const cls = busy ? 'busy' : f ? (f.found ? 'found' : 'missing') : '';
      const row = document.createElement('div');
      row.className = 'who-row' + (a.enabled ? '' : ' off');
      row.style.setProperty('--c', a.color);
      row.title = f && f.found ? f.path : f ? 'Not found. Open Settings → Check my CLIs.' : '';
      const pic = document.createElement('span');
      pic.className = 'mini-av';
      pic.style.setProperty('--on-c', readable(a.color));
      fillAvatar(pic, id, a.label.slice(0, 1).toUpperCase());
      row.innerHTML = `<span class="dot ${cls}"></span>`;
      row.append(pic);
      const nm = document.createElement('span');
      nm.textContent = a.label + (f && f.found === false && a.enabled ? ' · not found' : '');
      row.append(nm);
      const u = state.status.usage && state.status.usage[id];
      if (u && u.budget > 0 && a.enabled) {
        const pct = Math.round((u.used / u.budget) * 100);
        const bar = document.createElement('div');
        bar.className = 'use' + (pct >= 100 ? ' over' : pct >= 80 ? ' high' : '');
        bar.title = `${u.used} of your ${u.budget}-run daily budget used today (runs started from AI Huddle only). Change the budget in Settings.`;
        bar.innerHTML = `<span class="track"><i style="width:${Math.min(100, pct)}%"></i></span><span class="pct">${pct}%</span><span class="n">${u.used}/${u.budget}</span>`;
        row.append(bar);
      }
      box.append(row);
    });
  }

  // ---------- room header / roster / typing ----------

  function renderHeader() {
    const r = activeRoom();
    $('#auto').checked = !!state.config.settings.autoHandoff;
    if (!r) return;
    $('#room-name').textContent = r.name;
    const topic = $('#room-topic');
    topic.textContent = (r.archived ? 'Archived. Send a message to bring it back. ' : '') + (r.topic || (r.archived ? '' : 'No topic yet. Click Room to say what this one is for.'));
    topic.title = r.topic || '';
    input.placeholder = `Message ${r.name}. Enter sends, Shift+Enter adds a line.`;
    document.title = `${r.name} · AI Huddle`;
  }

  function renderRoster() {
    const box = $('#roster');
    box.innerHTML = '';
    const r = activeRoom();
    if (!r) return;
    const running = roomRunning(r.id);
    const queued = roomQueued(r.id);
    r.agents.forEach((id) => {
      const a = agent(id);
      if (!a) return;
      const b = document.createElement('button');
      b.className = 'chip' + (a.enabled ? '' : ' off');
      b.style.setProperty('--c', a.color);
      const f = state.found[id];
      const busy = running.includes(id);
      const dotClass = busy ? 'busy' : f && f.found ? 'found' : f && !f.found ? 'missing' : '';
      const sub = !a.enabled
        ? 'off'
        : busy
        ? 'thinking'
        : queued[id]
        ? 'queued'
        : f && !f.found
        ? 'not found'
        : f && f.found
        ? 'ready'
        : '';
      b.innerHTML = `<span class="dot ${dotClass}"></span><span class="who">${esc(a.label)}</span>${
        sub ? `<span class="sub">${esc(sub)}</span>` : ''
      }`;
      b.title = a.enabled ? `Click to tag @${id}` : `${a.label} is switched off. Turn it on in Settings.`;
      b.addEventListener('click', () => insertMention(id));
      box.append(b);
    });
    if (!r.agents.length) {
      const p = document.createElement('span');
      p.className = 'sub';
      p.textContent = 'Nobody is in this room. Click Room to add someone.';
      box.append(p);
    }
  }

  function renderTyping() {
    const box = $('#typing');
    const r = activeRoom();
    const running = r ? roomRunning(r.id) : [];
    const queued = r ? roomQueued(r.id) : {};
    const busy = running.length > 0 || Object.keys(queued).length > 0;
    $('#stop').hidden = !busy;
    if (!busy) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = '';
    running.forEach((id) => {
      const t = document.createElement('span');
      t.className = 't';
      t.style.setProperty('--c', colorOf(id));
      t.innerHTML = `${esc(nameOf(id))} is thinking<span class="d">.</span><span class="d">.</span><span class="d">.</span>`;
      box.append(t);
    });
    Object.entries(queued).forEach(([id, n]) => {
      const t = document.createElement('span');
      t.className = 't';
      t.style.setProperty('--c', colorOf(id));
      t.textContent = `${nameOf(id)}: ${n} waiting`;
      box.append(t);
    });
  }

  function renderStatusBits() {
    renderRooms();
    renderWho();
    renderRoster();
    renderTyping();
  }

  function renderAllChrome() {
    renderHeader();
    renderRooms();
    renderWho();
    renderRoster();
    renderTyping();
  }

  async function selectRoom(id) {
    if (id === state.activeId && state.transcript) {
      input.focus();
      return;
    }
    if (state.activeId) drafts[state.activeId] = input.value;
    slashClose();
    const token = ++loadToken;
    const data = await api.getRoom(id);
    if (token !== loadToken || !data) return;
    state.activeId = id;
    state.transcript = data.transcript.slice();
    const r = state.rooms.find((x) => x.id === id);
    if (r) Object.assign(r, data.room);
    markSeen(id, data.room.lastId);
    input.value = drafts[id] || '';
    autosize();
    renderPending();
    renderAllChrome();
    renderAll();
    input.focus();
  }

  // ---------- composer ----------

  const input = $('#input');

  // A textarea with box-sizing: border-box reports scrollHeight WITHOUT its borders, so sizing it to
  // scrollHeight leaves it 4px short and the browser draws a scrollbar. Add the borders back, and
  // only allow scrolling once we hit the max height.
  function autosize() {
    const cs = getComputedStyle(input);
    const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const max = 180;
    input.style.height = 'auto';
    const want = input.scrollHeight + border;
    input.style.height = Math.min(want, max) + 'px';
    input.style.overflowY = want > max ? 'auto' : 'hidden';
  }

  function insertMention(id) {
    const a = agent(id);
    if (!a || !a.enabled) return toast(`${a ? a.label : id} is switched off. Turn it on in Settings.`);
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const space = before && !/\s$/.test(before) ? ' ' : '';
    const ins = `${space}@${id} `;
    input.value = before + ins + after;
    const pos = before.length + ins.length;
    input.focus();
    input.setSelectionRange(pos, pos);
    autosize();
  }

  function sendNow() {
    const text = input.value.trim();
    const files = pendingFiles();
    if ((!text && !files.length) || !state.activeId) return;
    input.value = '';
    drafts[state.activeId] = '';
    autosize();
    slashClose();
    const payload = files.map((f) => ({ name: f.name, mime: f.mime, data: f.data }));
    files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
    pendingByRoom[state.activeId] = [];
    renderPending();
    api.send(state.activeId, text, payload);
  }

  // ---------- attachments (button, paste, drag and drop) ----------

  const pendingFiles = () => (state.activeId && pendingByRoom[state.activeId]) || [];

  function renderPending() {
    const box = $('#pending');
    const list = pendingFiles();
    box.innerHTML = '';
    box.hidden = !list.length;
    list.forEach((f, i) => {
      const chip = document.createElement('div');
      chip.className = 'pend';
      if (f.url) {
        const img = document.createElement('img');
        img.src = f.url;
        img.alt = f.name;
        chip.append(img);
      } else {
        const ext = document.createElement('span');
        ext.className = 'ext';
        ext.textContent = extOf(f.name);
        chip.append(ext);
      }
      const nm = document.createElement('span');
      nm.className = 'fname';
      nm.textContent = `${f.name} · ${fmtSize(f.data.byteLength)}`;
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = 'Remove';
      x.setAttribute('aria-label', 'Remove ' + f.name);
      x.addEventListener('click', () => {
        if (f.url) URL.revokeObjectURL(f.url);
        pendingByRoom[state.activeId].splice(i, 1);
        renderPending();
      });
      chip.append(nm, x);
      box.append(chip);
    });
  }

  async function addFiles(fileList) {
    if (!state.activeId) return;
    const list = (pendingByRoom[state.activeId] = pendingByRoom[state.activeId] || []);
    for (const file of Array.from(fileList)) {
      if (list.length >= MAX_FILES) {
        toast(`Max ${MAX_FILES} files per message.`);
        break;
      }
      if (file.size > MAX_FILE) {
        toast(`${file.name} is over 25 MB, so I left it out.`);
        continue;
      }
      let name = file.name || '';
      if (!name || /^image\.(png|jpe?g|gif|webp)$/i.test(name)) {
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        name = 'pasted-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.' + ext;
      }
      const data = new Uint8Array(await file.arrayBuffer());
      list.push({ name, mime: file.type || '', data, url: /^image\//.test(file.type) ? URL.createObjectURL(file) : null });
    }
    renderPending();
    input.focus();
  }

  $('#attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  input.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    $('#composer').classList.add('drag');
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) $('#composer').classList.remove('drag');
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    $('#composer').classList.remove('drag');
    addFiles(e.dataTransfer.files);
  });

  // ---------- /skill menu ----------

  const slash = $('#slash');
  let slashItems = [];
  let slashIdx = 0;

  function slashClose() {
    slash.hidden = true;
    slash.innerHTML = '';
    slashItems = [];
  }

  function slashToken() {
    const before = input.value.slice(0, input.selectionStart);
    const m = before.match(/(^|\s)\/([\w.-]*)$/);
    return m ? { q: m[2].toLowerCase(), start: before.length - m[2].length - 1 } : null;
  }

  function slashUpdate() {
    const t = slashToken();
    if (!t || !state.skills.length) return slashClose();
    slashItems = state.skills.filter((k) => k.slug.toLowerCase().includes(t.q)).slice(0, 8);
    if (!slashItems.length) return slashClose();
    slashIdx = Math.min(slashIdx, slashItems.length - 1);
    slash.innerHTML = '';
    slashItems.forEach((k, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = i === slashIdx ? 'on' : '';
      b.innerHTML = `<b>/${esc(k.slug)}</b>${k.description ? ' ' + esc(k.description.slice(0, 90)) : ''}`;
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        slashPick(i);
      });
      slash.append(b);
    });
    slash.hidden = false;
  }

  function slashPick(i) {
    const t = slashToken();
    const k = slashItems[i];
    if (!t || !k) return slashClose();
    const end = input.selectionStart;
    const ins = '/' + k.slug + ' ';
    input.value = input.value.slice(0, t.start) + ins + input.value.slice(end);
    const pos = t.start + ins.length;
    input.setSelectionRange(pos, pos);
    slashClose();
    autosize();
    input.focus();
  }

  input.addEventListener('input', () => {
    autosize();
    slashUpdate();
  });
  input.addEventListener('click', slashUpdate);
  input.addEventListener('blur', () => setTimeout(slashClose, 120));
  input.addEventListener('keydown', (e) => {
    if (!slash.hidden && slashItems.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slashIdx = (slashIdx + (e.key === 'ArrowDown' ? 1 : slashItems.length - 1)) % slashItems.length;
        return slashUpdate();
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return slashPick(slashIdx);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        return slashClose();
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendNow();
    }
  });
  $('#send').addEventListener('click', sendNow);
  $('#stop').addEventListener('click', () => api.stop(state.activeId));

  $('#auto').addEventListener('change', (e) => {
    api.saveConfig({ settings: { autoHandoff: e.target.checked } });
  });

  $('#clear').addEventListener('click', () => {
    const r = activeRoom();
    if (r && confirm(`Wipe everything in ${r.name}? This also stops anything running in it.`)) api.clear(r.id);
  });

  $('#export').addEventListener('click', async () => {
    const p = await api.exportChat(state.activeId);
    if (p) toast('Saved to ' + p);
  });

  // ---------- sheet (modal) helper ----------

  const modal = $('#modal');

  function openSheet(title, buildBody, footButtons) {
    $('#sheet-title').textContent = title;
    const body = $('#sheet-body');
    body.innerHTML = '';
    buildBody(body);
    const foot = $('#sheet-foot');
    foot.innerHTML = '';
    footButtons.forEach((b) => {
      if (b === 'spacer') {
        const s = document.createElement('span');
        s.className = 'spacer';
        foot.append(s);
        return;
      }
      const btn = document.createElement('button');
      btn.className = 'btn ' + (b.kind || 'ghost');
      btn.textContent = b.label;
      if (b.id) btn.id = b.id;
      btn.addEventListener('click', b.onClick);
      foot.append(btn);
    });
    modal.hidden = false;
    const first = body.querySelector('input[type="text"], textarea');
    if (first) first.focus();
  }

  function closeSheet() {
    modal.hidden = true;
  }

  $('#modal-close').addEventListener('click', closeSheet);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });

  function field(label, control) {
    const l = document.createElement('label');
    l.textContent = label;
    return [l, control];
  }

  function textInput(value, attrs) {
    const i = document.createElement('input');
    i.type = 'text';
    i.value = value == null ? '' : value;
    Object.assign(i, attrs || {});
    return i;
  }

  function numInput(value, min, max) {
    const i = document.createElement('input');
    i.type = 'number';
    i.value = value;
    i.min = min;
    i.max = max;
    return i;
  }

  // ---------- skills sheet ----------

  async function refreshSkills() {
    try {
      const s = await api.skills();
      state.skills = s.skills;
      return s;
    } catch (_) {
      return { dir: '', skills: state.skills, sources: [] };
    }
  }

  function skillToast(res) {
    if (!res) return;
    const bits = [];
    if (res.added.length) bits.push(`Added ${res.added.length}`);
    if (res.updated.length) bits.push(`Updated ${res.updated.length}`);
    if (res.failed.length) bits.push(res.failed[0]);
    toast(bits.join('. ') || 'Nothing to import.');
  }

  async function openSkillsSheet() {
    let info = await refreshSkills();
    const holder = document.createElement('div');

    async function draw() {
      holder.innerHTML = '';
      const note = document.createElement('div');
      note.className = 'note-box';
      note.innerHTML =
        '<strong>One library, every agent.</strong> Skills you put here are given to Claude, Codex and Grok alike, so they all follow the same instructions. ' +
        'Call one by typing <code>/skill-name</code> in a message, or pin it to a room (Room → Pinned skills) so it\'s always on. ' +
        'Importing makes a <em>copy</em>; your other tools\' skill folders aren\'t touched or kept in sync. Skills are plain instructions pasted into the agent\'s prompt, so only add ones you trust.';
      holder.append(note);

      const g = document.createElement('div');
      g.className = 'group';
      g.innerHTML = `<h3>Library <span class="sub">${info.skills.length} skill${info.skills.length === 1 ? '' : 's'}</span></h3>`;
      if (!info.skills.length) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = 'Nothing here yet. Import a skill folder, a .skill or .zip file, or pull them in from another tool below.';
        g.append(p);
      }
      info.skills.forEach((k) => {
        const row = document.createElement('div');
        row.className = 'skill-row';
        const main = document.createElement('div');
        main.className = 'sk-main';
        main.innerHTML = `<div class="sk-name">/${esc(k.slug)}</div>` + (k.description ? `<div class="sk-desc">${esc(k.description)}</div>` : '');
        const del = document.createElement('button');
        del.className = 'btn small';
        del.textContent = 'Remove';
        del.addEventListener('click', async () => {
          if (!confirm(`Remove /${k.slug} from the library? (Your original copy elsewhere is untouched.)`)) return;
          await api.removeSkill(k.slug);
          info = await refreshSkills();
          draw();
        });
        row.append(main, del);
        g.append(row);
      });

      const btns = document.createElement('div');
      btns.className = 'btn-row';
      const mk = (label, fn) => {
        const b = document.createElement('button');
        b.className = 'btn small';
        b.textContent = label;
        b.addEventListener('click', fn);
        btns.append(b);
      };
      const after = async (res) => {
        skillToast(res);
        info = await refreshSkills();
        draw();
      };
      mk('Import folder…', async () => after(await api.importSkillFolder()));
      mk('Import .skill / .zip…', async () => after(await api.importSkillFile()));
      mk('Open library folder', () => api.openSkillsFolder());
      info.sources.forEach((s) => mk(`Import from ${s.label} (${s.count})`, async () => after(await api.importSkillSource(s.path))));
      g.append(btns);
      holder.append(g);
    }

    openSheet('Shared skills', (body) => body.append(holder), ['spacer', { label: 'Done', kind: 'primary', onClick: closeSheet }]);
    draw();
  }

  $('#skills-btn').addEventListener('click', openSkillsSheet);

  // ---------- room sheet (create / edit) ----------

  async function openRoomSheet(room) {
    const editing = !!room;
    const wd = await api.workDir(editing ? room.id : undefined);
    const refs = {};
    const allIds = Object.keys(state.config.agents);

    openSheet(
      editing ? `Room: ${room.name}` : 'New room',
      (body) => {
        const g = document.createElement('div');
        g.className = 'group';
        g.innerHTML = '<h3>The basics</h3>';
        const grid = document.createElement('div');
        grid.className = 'grid';

        refs.name = textInput(editing ? room.name : '', { placeholder: 'e.g. carousels' });
        refs.name.maxLength = 40;

        refs.topic = document.createElement('textarea');
        refs.topic.value = editing ? room.topic : '';
        refs.topic.placeholder = 'What is this room for? Agents get this as context.';
        refs.topic.maxLength = 2000;

        const members = document.createElement('div');
        members.className = 'checks';
        refs.members = {};
        allIds.forEach((id) => {
          const a = state.config.agents[id];
          const lab = document.createElement('label');
          lab.className = 'check-pill';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = editing ? room.agents.includes(id) : true;
          refs.members[id] = cb;
          lab.append(cb, document.createTextNode(a.label));
          members.append(lab);
        });

        const folderRow = document.createElement('div');
        folderRow.className = 'row';
        refs.workDir = textInput(editing ? room.workDir : '', { placeholder: wd });
        const choose = document.createElement('button');
        choose.className = 'btn small';
        choose.textContent = 'Choose…';
        choose.addEventListener('click', async () => {
          const p = await api.chooseFolder();
          if (p) refs.workDir.value = p;
        });
        folderRow.append(refs.workDir, choose);
        if (editing) {
          const open = document.createElement('button');
          open.className = 'btn small';
          open.textContent = 'Open';
          open.addEventListener('click', () => api.openWorkDir(room.id));
          folderRow.append(open);
        }

        const pins = document.createElement('div');
        pins.className = 'checks';
        refs.pins = {};
        state.skills.forEach((k) => {
          const lab = document.createElement('label');
          lab.className = 'check-pill';
          lab.title = k.description || '';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = editing && (room.skills || []).includes(k.slug);
          refs.pins[k.slug] = cb;
          lab.append(cb, document.createTextNode('/' + k.slug));
          pins.append(lab);
        });
        if (!state.skills.length) {
          const none = document.createElement('span');
          none.className = 'hint';
          none.textContent = 'No skills yet. Add some with the Skills button.';
          pins.append(none);
        }

        grid.append(
          ...field('Name', refs.name),
          ...field('Topic', refs.topic),
          ...field("Who's in", members),
          ...field('Pinned skills', pins),
          ...field('Agents work in', folderRow)
        );
        g.append(grid);
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent =
          "Only people in a room can be tagged there and only they see that room's messages. Pinned skills are given to every agent on every message in this room. Leave the folder empty to use the default shown. Files you attach are saved in a huddle-files folder inside it.";
        g.append(hint);
        body.append(g);
      },
      [
        ...(editing
          ? [
              {
                label: room.archived ? 'Unarchive' : 'Archive',
                kind: 'ghost',
                onClick: async () => {
                  closeSheet();
                  await archiveRoom(room, !room.archived);
                },
              },
            ]
          : []),
        ...(editing && state.rooms.length > 1
          ? [
              {
                label: 'Delete room',
                kind: 'danger',
                onClick: async () => {
                  if (!confirm(`Delete ${room.name} and all its messages? This can't be undone.`)) return;
                  await api.deleteRoom(room.id);
                  closeSheet();
                },
              },
            ]
          : []),
        'spacer',
        {
          label: editing ? 'Save' : 'Create room',
          kind: 'primary',
          onClick: async () => {
            const name = refs.name.value.trim();
            if (!name) return toast('Give the room a name first.');
            const payload = {
              name,
              topic: refs.topic.value.trim(),
              workDir: refs.workDir.value.trim(),
              agents: allIds.filter((id) => refs.members[id].checked),
              skills: Object.keys(refs.pins).filter((s) => refs.pins[s].checked),
            };
            if (editing) {
              await api.updateRoom(room.id, payload);
              closeSheet();
              toast('Saved');
            } else {
              const made = await api.createRoom(payload);
              closeSheet();
              if (made) {
                await refreshRooms();
                selectRoom(made.id);
              }
            }
          },
        },
      ]
    );
  }

  $('#add-room').addEventListener('click', () => openRoomSheet(null));
  $('#room-settings').addEventListener('click', () => {
    const r = activeRoom();
    if (r) openRoomSheet(r);
  });

  async function refreshRooms() {
    const s = await api.getState();
    state.rooms = s.rooms;
  }

  // ---------- settings sheet ----------

  async function openSettings() {
    const c = state.config;
    const wd = await api.workDir();
    const refs = { settings: {}, agents: {} };
    const pathEls = {};

    function showFound(found) {
      Object.entries(found).forEach(([id, f]) => {
        state.found[id] = f;
        const dot = document.querySelector(`[data-dot="${id}"]`);
        if (dot) dot.className = 'dot ' + (f.found ? 'found' : 'missing');
        if (pathEls[id]) pathEls[id].textContent = f.found ? 'Found: ' + f.path : 'Not found.';
      });
      renderWho();
      renderRoster();
    }

    openSheet(
      'Settings',
      (body) => {
        const note = document.createElement('div');
        note.className = 'note-box';
        note.innerHTML =
          '<strong>What actually happens.</strong> Every agent reply is a real run of that agent\'s CLI, using your own login and plan limits. ' +
          'Runs happen in the folder for that room (or the default below). Huddle does <em>not</em> add any "skip permissions" flags, so each CLI uses its own defaults. ' +
          'Add flags yourself only if you understand that they let the agent act on your files without asking.';
        body.append(note);

        const look = document.createElement('div');
        look.className = 'group';
        look.innerHTML = '<h3>Look</h3>';
        const ah = document.createElement('h3');
        ah.textContent = 'Your avatar';
        ah.className = 'sub-h';
        look.append(ah, buildAvatarPicker());
        look.append(buildTeamPicker(), buildThemeGrid());
        const lh = document.createElement('p');
        lh.className = 'hint';
        lh.textContent = 'Team and skin apply right away. The skin is remembered on this computer.';
        look.append(lh);
        const again = document.createElement('button');
        again.className = 'btn small';
        again.textContent = 'Replay the welcome setup';
        again.addEventListener('click', openSetup);
        look.append(again);
        body.append(look);

        const g = document.createElement('div');
        g.className = 'group';
        g.innerHTML = '<h3>Everywhere</h3>';
        const grid = document.createElement('div');
        grid.className = 'grid';

        refs.settings.userName = textInput(c.settings.userName);
        refs.settings.maxAutoRuns = numInput(c.settings.maxAutoRuns, 0, 30);
        const capSel = document.createElement('select');
        capSel.innerHTML = '<option value="cap">Cap it (stop after the number below)</option><option value="free">No cap, let them run</option>';
        capSel.value = c.settings.capHandoffs === false ? 'free' : 'cap';
        refs.capSel = capSel;
        const syncCap = () => {
          refs.settings.maxAutoRuns.disabled = capSel.value === 'free';
          capHint.hidden = capSel.value !== 'free';
        };
        const capHint = document.createElement('p');
        capHint.className = 'hint warn';
        capHint.textContent =
          'With no cap, agents keep tagging each other until they stop on their own or you press Stop. Every reply is a real run on your plan. There is still a safety ceiling of 200 in a row.';
        capSel.addEventListener('change', syncCap);
        refs.settings.timeoutSec = numInput(c.settings.timeoutSec, 10, 1800);
        refs.settings.contextMessages = numInput(c.settings.contextMessages, 5, 200);

        const folderRow = document.createElement('div');
        folderRow.className = 'row';
        refs.settings.workDir = textInput(c.settings.workDir, { placeholder: wd });
        const choose = document.createElement('button');
        choose.className = 'btn small';
        choose.textContent = 'Choose…';
        choose.addEventListener('click', async () => {
          const p = await api.chooseFolder();
          if (p) refs.settings.workDir.value = p;
        });
        folderRow.append(refs.settings.workDir, choose);

        grid.append(
          ...field('Your name', refs.settings.userName),
          ...field('Default folder', folderRow),
          ...field('Back-and-forth', capSel),
          ...field('Max auto hand-offs', refs.settings.maxAutoRuns),
          ...field('Timeout (seconds)', refs.settings.timeoutSec),
          ...field('Messages of context', refs.settings.contextMessages)
        );
        g.append(grid);
        g.append(capHint);
        syncCap();
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent =
          'Max auto hand-offs is per message you send. When it runs out, the last message gets "Send to…" buttons so you decide whether to keep going. Each room can override the folder.';
        g.append(hint);
        const bh = document.createElement('p');
        bh.className = 'hint';
        bh.textContent = 'The bars in the sidebar count runs AI Huddle started today against the daily budget you set per agent below. That is your own budget, not your plan\'s real limit, and it does not see usage from other apps.';
        g.append(bh);
        body.append(g);

        Object.entries(c.agents).forEach(([id, a]) => {
          const box = document.createElement('div');
          box.className = 'group';
          box.style.setProperty('--c', a.color);
          const f = state.found[id];
          const h = document.createElement('h3');
          h.innerHTML = `<span class="dot ${f ? (f.found ? 'found' : 'missing') : ''}" data-dot="${esc(id)}"></span>${esc(a.label)} <span class="sub">@${esc(id)}</span>`;
          box.append(h);

          const r = (refs.agents[id] = {});
          const en = document.createElement('input');
          en.type = 'checkbox';
          en.checked = a.enabled;
          r.enabled = en;
          r.command = textInput(a.command);
          r.args = textInput((a.args || []).join(' '));
          const sel = document.createElement('select');
          sel.innerHTML =
            '<option value="stdin">Pipe it in (stdin)</option>' +
            '<option value="file">Temp file ({promptFile})</option>' +
            '<option value="arg">Right in the arguments ({prompt})</option>';
          sel.value = a.input;
          r.input = sel;
          r.budget = numInput(a.dailyBudget == null ? 50 : a.dailyBudget, 0, 1000);

          const gr = document.createElement('div');
          gr.className = 'grid';
          gr.append(
            ...field('Switched on', en),
            ...field('Command', r.command),
            ...field('Arguments', r.args),
            ...field('Prompt goes in via', sel),
            ...field('Daily budget (runs, 0 = no bar)', r.budget)
          );
          box.append(gr);

          const pe = document.createElement('p');
          pe.className = 'found-path';
          pe.textContent = f ? (f.found ? 'Found: ' + f.path : 'Not found.') : '';
          pathEls[id] = pe;
          box.append(pe);

          const hp = document.createElement('p');
          hp.className = 'hint';
          hp.innerHTML =
            id === 'grok'
              ? 'Default is <code>--no-auto-update -p {prompt}</code> with "Right in the arguments". That\'s xAI\'s headless mode (<code>grok -p "prompt"</code>). Not installed? In PowerShell run <code>irm https://x.ai/cli/install.ps1 | iex</code>, then run <code>grok</code> once to log in. Huddle also looks in <code>%USERPROFILE%\\.grok\\bin</code> if it isn\'t on your PATH.'
              : id === 'codex'
              ? 'Default is <code>exec --skip-git-repo-check -</code> (reads the prompt from stdin). The skip flag matters: Codex exits with code 1 in any folder that isn\'t a git repo. Arguments are split on spaces.'
              : 'Default is <code>-p</code> (headless print mode, prompt on stdin). Arguments are split on spaces.';
          box.append(hp);
          body.append(box);
        });

        const about = document.createElement('p');
        about.className = 'hint';
        about.innerHTML =
          'AI Huddle is free and open source (MIT). Made by <a href="https://alliefern.com" target="_blank" rel="noopener">Allie Fern</a>. It collects nothing: no accounts, no analytics, no phoning home. Everything stays on this computer. Not affiliated with Anthropic, OpenAI or xAI.';
        body.append(about);
      },
      [
        {
          label: 'Check my CLIs',
          kind: 'ghost',
          id: 'check',
          onClick: async () => {
            const typed = {};
            Object.entries(refs.agents).forEach(([id, r]) => (typed[id] = r.command.value));
            const found = await api.checkAgents(typed);
            showFound(found);
            const missing = Object.entries(found)
              .filter(([, f]) => !f.found)
              .map(([id]) => agent(id).label);
            toast(missing.length ? `Can't find: ${missing.join(', ')}` : 'All three CLIs found');
          },
        },
        'spacer',
        {
          label: 'Save',
          kind: 'primary',
          id: 'save',
          onClick: async () => {
            const patch = { settings: {}, agents: {} };
            Object.entries(refs.settings).forEach(([k, el]) => {
              patch.settings[k] = el.type === 'number' ? Number(el.value) : el.value;
            });
            patch.settings.capHandoffs = refs.capSel.value !== 'free';
            Object.entries(refs.agents).forEach(([id, r]) => {
              patch.agents[id] = {
                enabled: r.enabled.checked,
                command: r.command.value,
                args: r.args.value.split(/\s+/).filter(Boolean),
                input: r.input.value,
                dailyBudget: Number(r.budget.value),
              };
            });
            await api.saveConfig(patch);
            closeSheet();
            toast('Saved');
            recheck();
          },
        },
      ]
    );
  }

  function buildThemeGrid() {
    const grid0 = document.createElement('div');
    grid0.className = 'themes';
    const cur = window.HuddleThemes.current();
    window.HuddleThemes.list.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-card' + (t.id === cur ? ' on' : '');
      b.dataset.theme = t.id;
      b.style.background = t.cream;
      b.style.color = t.ink;
      b.style.borderColor = t.ink;
      b.setAttribute('aria-pressed', t.id === cur ? 'true' : 'false');
      b.innerHTML =
        '<span class="sw">' +
        [t.side, t.chart, t.pink, t.ink].map((c) => `<i style="background:${c};border-color:${t.ink}"></i>`).join('') +
        '</span>' +
        `<span class="tname">${esc(t.name)}${t.id === cur ? ' ✶' : ''}</span>`;
      b.addEventListener('click', () => {
        window.HuddleThemes.apply(t.id);
        grid0.querySelectorAll('.theme-card').forEach((x) => {
          const on = x.dataset.theme === t.id;
          x.classList.toggle('on', on);
          x.setAttribute('aria-pressed', String(on));
          x.querySelector('.tname').textContent = window.HuddleThemes.list.find((k) => k.id === x.dataset.theme).name + (on ? ' ✶' : '');
        });
      });
      grid0.append(b);
    });
    return grid0;
  }

  // Two picture choices plus "initial only". onPick(value) if given, otherwise saves straight away.
  function buildAvatarPicker(current, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'avatars';
    const cur = current == null ? (state.config.settings.userAvatar || '') : current;
    [['boy', 'Boy'], ['girl', 'Girl'], ['', 'Initial']].forEach(([v, name]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'avatar-pick' + (v === cur ? ' on' : '') + (v ? '' : ' none');
      b.dataset.avatar = v;
      b.setAttribute('aria-label', 'Avatar: ' + name);
      b.setAttribute('aria-pressed', String(v === cur));
      if (v) {
        const img = document.createElement('img');
        img.src = `avatars/you/${v}.png`;
        img.alt = '';
        b.append(img);
      } else {
        b.textContent = 'Initial';
      }
      b.addEventListener('click', async () => {
        wrap.querySelectorAll('.avatar-pick').forEach((x) => {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-pressed', String(x === b));
        });
        if (onPick) onPick(v);
        else await api.saveConfig({ settings: { userAvatar: v } });
      });
      wrap.append(b);
    });
    return wrap;
  }

  // Three team cards. onPick(team) fires on click; the card for `current` is marked.
  function buildTeamPicker(current, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'teams';
    const cur = current || teamId();
    Object.entries(TEAM_NAMES).forEach(([id, t]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'team-card' + (id === cur ? ' on' : '');
      b.dataset.team = id;
      b.setAttribute('aria-pressed', id === cur ? 'true' : 'false');
      const faces = document.createElement('span');
      faces.className = 'faces';
      ['claude', 'codex', 'grok'].forEach((aid, i) => {
        const f = document.createElement('span');
        f.className = 'mini-av';
        const col = (state.config.agents[aid] || {}).color || '#888';
        f.style.setProperty('--c', col);
        f.style.setProperty('--on-c', readable(col));
        fillAvatar(f, aid, t.names[i].slice(0, 1), id);
        faces.append(f);
      });
      b.append(faces);
      const nm = document.createElement('span');
      nm.className = 'tname';
      nm.textContent = t.title;
      const sub = document.createElement('span');
      sub.className = 'tsub';
      sub.textContent = t.names.join(' · ');
      b.append(nm, sub);
      b.addEventListener('click', async () => {
        wrap.querySelectorAll('.team-card').forEach((x) => {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-pressed', String(x === b));
        });
        if (onPick) onPick(id);
        else await api.saveConfig({ settings: { team: id } });
      });
      wrap.append(b);
    });
    return wrap;
  }

  // First-run welcome. Also reachable any time from Settings.
  function openSetup() {
    const picked = { avatar: (state.config.settings.userAvatar || ''), team: teamId(), name: (state.config.settings.userName || '').replace(/^You$/, '') };
    openSheet(
      'Welcome to AI Huddle',
      (body) => {
        const intro = document.createElement('p');
        intro.className = 'hint';
        intro.textContent = 'Three quick things. You can change every one of them later in Settings.';
        body.append(intro);

        const g1 = document.createElement('div');
        g1.className = 'group';
        g1.innerHTML = '<h3>What should they call you?</h3>';
        const nameIn = textInput(picked.name, { placeholder: 'Your name' });
        nameIn.id = 'setup-name';
        nameIn.addEventListener('input', () => (picked.name = nameIn.value));
        g1.append(nameIn);
        const av1 = document.createElement('h3');
        av1.textContent = 'Pick your avatar';
        av1.className = 'sub-h';
        g1.append(av1, buildAvatarPicker(picked.avatar, (v) => (picked.avatar = v)));
        body.append(g1);

        const g2 = document.createElement('div');
        g2.className = 'group';
        g2.innerHTML = '<h3>Pick your team</h3>';
        g2.append(buildTeamPicker(picked.team, (t) => (picked.team = t)));
        body.append(g2);

        const g3 = document.createElement('div');
        g3.className = 'group';
        g3.innerHTML = '<h3>Pick your colors</h3>';
        g3.append(buildThemeGrid());
        body.append(g3);
      },
      [
        'spacer',
        {
          label: "Let's go",
          kind: 'primary',
          id: 'setup-go',
          onClick: async () => {
            await api.saveConfig({ settings: { userName: picked.name.trim() || 'You', team: picked.team, userAvatar: picked.avatar, onboarded: true } });
            closeSheet();
          },
        },
      ]
    );
  }

  $('#settings').addEventListener('click', openSettings);

  async function recheck() {
    try {
      state.found = await api.checkAgents();
      renderWho();
      renderRoster();
      if (!state.transcript.length) renderEmpty();
    } catch (_) {}
  }

  // ---------- boot ----------

  api.onMessage(addMessage);
  api.onMessageUpdated(updateMessage);
  api.onStatus((s) => {
    state.status = s;
    renderStatusBits();
  });
  api.onConfig((c) => {
    state.config = c;
    renderAllChrome();
    if (!state.transcript.length) renderEmpty();
  });
  api.onRooms((list) => {
    const hadActive = state.rooms.some((r) => r.id === state.activeId);
    state.rooms = list;
    if (state.activeId && !list.some((r) => r.id === state.activeId)) {
      state.activeId = null;
      if (hadActive && list.length) selectRoom((list.find((x) => !x.archived) || list[0]).id);
      return;
    }
    renderAllChrome();
    if (!state.transcript.length) renderEmpty();
  });
  api.onCleared((roomId) => {
    if (roomId && roomId !== state.activeId) return;
    state.transcript = [];
    renderAll();
  });
  api.onNote((t) => toast(t));
  document.addEventListener('huddle-theme', () => {
    if (!state.config) return;
    renderAll();
    renderAllChrome();
  });
  api.onSkills((s) => {
    state.skills = s.skills;
  });

  (async function init() {
    const s = await api.getState();
    state.rooms = s.rooms;
    state.config = s.config;
    state.status = s.status;
    // first run: don't paint old history as unread
    s.rooms.forEach((r) => {
      if (seen[r.id] === undefined) seen[r.id] = r.lastId;
    });
    saveSeen();
    renderWho();
    await refreshSkills();
    if (s.rooms.length) await selectRoom((s.rooms.find((x) => !x.archived) || s.rooms[0]).id);
    recheck();
    if (!s.config.settings.onboarded) {
      api.saveConfig({ settings: { onboarded: true } }); // shown once, however it gets closed
      openSetup();
    }
  })();
})();
