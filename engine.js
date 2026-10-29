'use strict';
/*
 * Huddle engine: rooms, each with their own chat, and CLI agents that talk in them.
 *
 * - Every agent call is a fresh headless CLI run (claude -p, codex exec, grok -p ...).
 * - Each run gets that room's recent transcript, so agents "see" the room they're in.
 * - Rooms have a topic (given to the agents as a brief), members, and an optional folder.
 * - @mentions route messages. Agents can tag each other, capped by a per-message budget.
 * - Nothing here turns off any agent's permission prompts.
 *
 * Pure Node (no Electron), so it can be tested on its own.
 */

const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 10;
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html',
};
const { SkillStore, candidateSources } = require('./skills');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const HARD_CEILING = 200; // even with no cap, a bug or a stubborn pair of agents can't run all night

const DEFAULTS = {
  settings: {
    userName: 'You',
    workDir: '', // empty = <storeDir>/workspace
    autoHandoff: true, // agents may @mention each other and keep going
    maxAutoRuns: 6, // automatic agent-to-agent runs allowed per message you send
    capHandoffs: true, // false = no cap, let them run (until they stop tagging, you hit Stop, or the safety ceiling)
    timeoutSec: 300,
    contextMessages: 40,
    contextChars: 24000,
    team: 'mixed', // mixed | girls | boys (display names only)
    checkUpdates: true, // look for a newer AI Huddle on GitHub when the app starts
    userAvatar: '', // '' = initial letter, or 'boy' | 'girl' (pictures in renderer/avatars/you)
    onboarded: false, // false = show the first-run setup screen
  },
  agents: {
    claude: {
      label: 'Claude',
      color: '#d97757',
      enabled: true,
      dailyBudget: 50, // runs per day the usage bar fills toward (0 = no bar)
      command: 'claude',
      args: ['-p'],
      input: 'stdin',
    },
    codex: {
      label: 'Codexa',
      color: '#10a37f',
      enabled: true,
      dailyBudget: 50,
      command: 'codex',
      // Codex refuses to run outside a git repo unless told otherwise, and Huddle's workspace isn't one.
      args: ['exec', '--skip-git-repo-check', '-'],
      input: 'stdin',
    },
    grok: {
      // Per xAI's docs, headless mode is `grok -p "<prompt>"`.
      label: 'Grok',
      color: '#141414',
      enabled: true,
      dailyBudget: 50,
      command: 'grok',
      args: ['--no-auto-update', '-p', '{prompt}'],
      input: 'arg',
    },
  },
};

// Team style: who's called what. The @ids never change, only the display names.
const TEAMS = {
  mixed: { claude: 'Claude', codex: 'Codexa', grok: 'Grok' },
  girls: { claude: 'Claudette', codex: 'Codexa', grok: 'Grokette' },
  boys: { claude: 'Claude', codex: 'Codex', grok: 'Grok' },
};

const INPUT_MODES = ['stdin', 'file', 'arg'];

const LIMITS = {
  maxAutoRuns: [0, 30],
  timeoutSec: [10, 1800],
  contextMessages: [5, 200],
  contextChars: [2000, 100000],
  dailyBudget: [0, 1000],
};

const MAX_STORED_MESSAGES = 2000;
const MAX_PER_MESSAGE_CHARS = 8000;
const MAX_CAPTURE = 2 * 1024 * 1024;
const ARG_MODE_MAX_CHARS = 16000; // keeps the prompt under Windows' command-line limit

const clone = (o) => JSON.parse(JSON.stringify(o));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripAnsi = (s) =>
  String(s)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\r\n/g, '\n');

// cmd.exe quoting, only used for .cmd/.bat shims on Windows.
function winQuote(a) {
  a = String(a);
  if (a === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(a)) return a;
  return '"' + a.replace(/"/g, '\\"') + '"';
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (IS_WIN) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (_) {
    try {
      child.kill('SIGTERM');
    } catch (_) {}
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (_) {}
  }, 3000).unref();
}

// ---------- finding a CLI ----------

function whichAll(cmd) {
  return new Promise((resolve) => {
    execFile(IS_WIN ? 'where' : 'which', [cmd], { windowsHide: true }, (err, out) => {
      resolve(err ? [] : String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

function pickRunnable(lines) {
  if (!IS_WIN) return lines[0];
  for (const ext of ['.exe', '.cmd', '.bat', '.com']) {
    const hit = lines.find((l) => l.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return lines[0];
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
};

// PATH first, then the folders these CLIs usually install into, so a stale PATH doesn't hide them.
async function resolveCommand(cmd) {
  cmd = String(cmd || '').trim();
  if (!cmd) return null;
  if (/[\\/]/.test(cmd)) return isFile(cmd) ? cmd : null;
  const found = await whichAll(cmd);
  if (found.length) return pickRunnable(found);
  const home = os.homedir();
  const dirs = [
    path.join(home, '.grok', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
  ].filter(Boolean);
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) for (const e of exts) if (isFile(path.join(d, cmd + e))) return path.join(d, cmd + e);
  return null;
}

class Engine extends EventEmitter {
  constructor(storeDir, opts = {}) {
    super();
    this.storeDir = storeDir;
    fs.mkdirSync(storeDir, { recursive: true });
    this.storeFile = path.join(storeDir, 'huddle.json');

    this.config = clone(DEFAULTS);
    this.rooms = [];
    this.nextMsgId = 1;
    this.nextRoomNum = 1;
    this.epochs = new Map(); // roomId -> number, bumped by stop(); stale runs are discarded
    this.queues = {}; // "room|agent" -> [task]
    this.running = new Map(); // "room|agent" -> {child, room, agent}
    this.rounds = new Map(); // message id -> {runs}
    this.lastResponder = new Map(); // roomId -> agentId
    this._saveTimer = null;
    this.files = new Set(); // absolute paths of every attachment Huddle knows about (the UI may only open these)
    this.usage = { day: '', counts: {} }; // runs started from AI Huddle today, per agent
    this.skills = new SkillStore(opts.skillsDir || path.join(storeDir, 'skills'));

    this._load();
    if (opts.config) this._mergeConfig(opts.config, true);
    if (!this.rooms.length || this.rooms.every((r) => r.archived)) this._newRoom({ name: 'general' });
    for (const r of this.rooms) this._seedLastResponder(r);
  }

  // ---------- persistence ----------

  _load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
    } catch (_) {
      /* first run or unreadable file: start fresh */
    }
    if (!raw) return;

    if (raw.config) this._mergeConfig(raw.config, false);
    this._migrateOldDefaults();
    if (raw.usage && typeof raw.usage === 'object' && raw.usage.counts) this.usage = { day: String(raw.usage.day || ''), counts: { ...raw.usage.counts } };

    if (Array.isArray(raw.rooms)) {
      this.rooms = raw.rooms.map((r) => this._normalizeRoom(r)).filter(Boolean);
    } else if (Array.isArray(raw.transcript)) {
      // v1 file: one chat, no rooms. It becomes #general.
      this.rooms = [this._normalizeRoom({ id: 'r1', name: 'general', transcript: raw.transcript })];
    }

    let maxMsg = 0;
    let maxRoom = 0;
    for (const r of this.rooms) {
      maxRoom = Math.max(maxRoom, Number(String(r.id).replace(/\D/g, '')) || 0);
      for (const m of r.transcript) {
        m.room = r.id;
        maxMsg = Math.max(maxMsg, m.id || 0);
      }
    }
    for (const r of this.rooms) for (const m of r.transcript) for (const a of m.attachments || []) this.files.add(path.resolve(a.path));
    this.nextMsgId = maxMsg + 1;
    this.nextRoomNum = maxRoom + 1;
  }

  // An earlier build guessed Grok's flag wrong. If the saved config still has that guess, fix it.
  _migrateOldDefaults() {
    const g = this.config.agents.grok;
    if (g && g.input === 'file' && JSON.stringify(g.args) === JSON.stringify(['--prompt-file', '{promptFile}'])) {
      g.args = clone(DEFAULTS.agents.grok.args);
      g.input = DEFAULTS.agents.grok.input;
    }
    // Older builds ran `codex exec -`, which exits with code 1 outside a git repo.
    const c = this.config.agents.codex;
    if (c && c.input === 'stdin' && JSON.stringify(c.args) === JSON.stringify(['exec', '-'])) {
      c.args = clone(DEFAULTS.agents.codex.args);
    }
  }

  _normalizeRoom(r) {
    if (!r || typeof r !== 'object') return null;
    const ids = Object.keys(this.config.agents);
    const agents = Array.isArray(r.agents) ? r.agents.filter((id) => ids.includes(id)) : ids.slice();
    return {
      id: String(r.id || 'r' + this.nextRoomNum++),
      name: this._cleanName(r.name) || 'room',
      topic: String(r.topic || '').slice(0, 2000),
      agents,
      workDir: String(r.workDir || ''),
      skills: Array.isArray(r.skills) ? r.skills.map(String).slice(0, 40) : [],
      archived: !!r.archived,
      created: r.created || Date.now(),
      transcript: Array.isArray(r.transcript) ? r.transcript.slice(-MAX_STORED_MESSAGES) : [],
    };
  }

  _cleanName(n) {
    return String(n == null ? '' : n)
      .replace(/^#+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  }

  _seedLastResponder(room) {
    for (let i = room.transcript.length - 1; i >= 0; i--) {
      const f = room.transcript[i].from;
      if (f && f !== 'you' && f !== 'system') {
        this.lastResponder.set(room.id, f);
        return;
      }
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, 400);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    const data = {
      version: 2,
      config: this.config,
      usage: this.usage,
      rooms: this.rooms.map((r) => ({ ...r, transcript: r.transcript.slice(-MAX_STORED_MESSAGES) })),
    };
    const tmp = this.storeFile + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.storeFile);
    } catch (e) {
      this.emit('error-note', "I couldn't save the chat history: " + e.message);
    }
  }

  // ---------- config ----------

  _mergeConfig(patch, trusted) {
    if (!patch || typeof patch !== 'object') return;
    const S = this.config.settings;
    const D = DEFAULTS.settings;

    if (patch.settings && typeof patch.settings === 'object') {
      for (const k of Object.keys(D)) {
        if (!(k in patch.settings)) continue;
        let v = patch.settings[k];
        if (typeof D[k] === 'boolean') {
          v = !!v;
        } else if (typeof D[k] === 'number') {
          v = Number(v);
          if (!Number.isFinite(v)) continue;
          if (!trusted) {
            const [lo, hi] = LIMITS[k] || [0, 1e9];
            v = Math.min(hi, Math.max(lo, Math.round(v)));
          }
        } else {
          v = String(v == null ? '' : v).trim();
          if (k === 'userName' && !v) v = D.userName;
          if (k === 'team' && !TEAMS[v]) continue;
          if (k === 'userAvatar' && !['', 'boy', 'girl'].includes(v)) continue;
        }
        S[k] = v;
        if (k === 'team') for (const [id, nm] of Object.entries(TEAMS[v])) if (this.config.agents[id]) this.config.agents[id].label = nm;
      }
    }

    if (patch.agents && typeof patch.agents === 'object') {
      for (const [id, p] of Object.entries(patch.agents)) {
        const a = this.config.agents[id];
        if (!a || !p || typeof p !== 'object') continue;
        if ('enabled' in p) a.enabled = !!p.enabled;
        if (typeof p.label === 'string' && p.label.trim()) a.label = p.label.trim();
        if (typeof p.command === 'string' && p.command.trim()) a.command = p.command.trim();
        if (Array.isArray(p.args)) a.args = p.args.map(String).filter((x) => x.length);
        if (INPUT_MODES.includes(p.input)) a.input = p.input;
        if ('dailyBudget' in p) {
          const n = Number(p.dailyBudget);
          if (Number.isFinite(n)) {
            const [lo, hi] = LIMITS.dailyBudget;
            a.dailyBudget = trusted ? Math.round(n) : Math.min(hi, Math.max(lo, Math.round(n)));
          }
        }
      }
    }
  }

  updateConfig(patch) {
    this._mergeConfig(patch, false);
    this._scheduleSave();
    this.emit('config', this.config);
    return this.config;
  }

  workDir(roomId) {
    const room = roomId ? this._room(roomId) : null;
    const d = (room && room.workDir) || this.config.settings.workDir || path.join(this.storeDir, 'workspace');
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (_) {}
    return d;
  }

  // overrides: optional {agentId: command} so Settings can check what's typed before it's saved
  checkAgents(overrides = {}) {
    const ids = Object.keys(this.config.agents);
    return Promise.all(
      ids.map(async (id) => {
        const typed = overrides && typeof overrides[id] === 'string' ? overrides[id].trim() : '';
        const cmd = typed || this.config.agents[id].command;
        const p = await resolveCommand(cmd);
        return [id, { found: !!p, path: p || '' }];
      })
    ).then((pairs) => Object.fromEntries(pairs));
  }

  // ---------- rooms ----------

  _room(id) {
    return this.rooms.find((r) => r.id === id) || null;
  }

  _summary(r) {
    const last = r.transcript[r.transcript.length - 1];
    return {
      id: r.id,
      name: r.name,
      topic: r.topic,
      agents: r.agents.slice(),
      workDir: r.workDir,
      skills: (r.skills || []).slice(),
      archived: !!r.archived,
      lastId: last ? last.id : 0,
      count: r.transcript.length,
    };
  }

  _emitRooms() {
    this.emit('rooms', this.rooms.map((r) => this._summary(r)));
  }

  _newRoom(p = {}) {
    const ids = Object.keys(this.config.agents);
    const room = {
      id: 'r' + this.nextRoomNum++,
      name: this._cleanName(p.name) || 'new-room',
      topic: String(p.topic || '').slice(0, 2000),
      agents: Array.isArray(p.agents) ? p.agents.filter((id) => ids.includes(id)) : ids.slice(),
      workDir: String(p.workDir || '').trim(),
      skills: Array.isArray(p.skills) ? p.skills.map(String).slice(0, 40) : [],
      archived: false,
      created: Date.now(),
      transcript: [],
    };
    this.rooms.push(room);
    return room;
  }

  createRoom(p) {
    const room = this._newRoom(p);
    this._scheduleSave();
    this._emitRooms();
    return this._summary(room);
  }

  updateRoom(id, p) {
    const room = this._room(id);
    if (!room || !p) return null;
    const ids = Object.keys(this.config.agents);
    if ('name' in p) room.name = this._cleanName(p.name) || room.name;
    if ('topic' in p) room.topic = String(p.topic || '').slice(0, 2000);
    if ('workDir' in p) room.workDir = String(p.workDir || '').trim();
    if (Array.isArray(p.agents)) room.agents = p.agents.filter((a) => ids.includes(a));
    if (Array.isArray(p.skills)) room.skills = p.skills.map(String).slice(0, 40);
    if ('archived' in p) {
      const want = !!p.archived;
      if (want && !room.archived) {
        if (this._activeCount() <= 1) this.emit('error-note', "I can't archive your only active room. make another room first.");
        else {
          this.stop(id, true); // nothing keeps running in an archived room
          room.archived = true;
        }
      } else if (!want) room.archived = false;
    }
    this._scheduleSave();
    this._emitRooms();
    return this._summary(room);
  }

  _activeCount() {
    return this.rooms.filter((r) => !r.archived).length;
  }

  deleteRoom(id) {
    const i = this.rooms.findIndex((r) => r.id === id);
    if (i < 0) return false;
    // always keep at least one room you can actually talk in
    if (!this.rooms[i].archived && this._activeCount() <= 1) return false;
    this.stop(id, true);
    this.rooms.splice(i, 1);
    this.lastResponder.delete(id);
    this._scheduleSave();
    this._emitRooms();
    return true;
  }

  // ---------- files (attachments) ----------

  _inside(base, p) {
    const rel = path.relative(path.resolve(base), path.resolve(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  _describeFile(p, name, mime) {
    const ext = path.extname(name || p).slice(1).toLowerCase();
    const m = mime && mime !== 'application/octet-stream' ? mime : MIME[ext] || 'application/octet-stream';
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch (_) {}
    return { name: name || path.basename(p), path: path.resolve(p), size, mime: m, kind: /^image\//.test(m) ? 'image' : 'file' };
  }

  // Files go in <room folder>/huddle-files/ so agents can read them as ordinary files in their working folder.
  _saveAttachment(room, rawName, data, mime) {
    const base = path.basename(String(rawName || 'file')).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
    let buf;
    try {
      buf = Buffer.isBuffer(data) ? data : Buffer.from(data && data.buffer ? data.buffer : data || []);
    } catch (_) {
      return { error: `I couldn't read ${base}.` };
    }
    if (buf.length > MAX_FILE_BYTES) return { error: `${base} is over ${Math.round(MAX_FILE_BYTES / 1048576)} MB, so I left it out.` };
    const dir = path.join(this.workDir(room.id), 'huddle-files');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      let name = base;
      for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stem}-${i}${ext}`;
      const p = path.join(dir, name);
      fs.writeFileSync(p, buf);
      this.files.add(path.resolve(p));
      return this._describeFile(p, name, mime);
    } catch (e) {
      return { error: `I couldn't save ${base}: ${e.message}` };
    }
  }

  // Agents can send files two ways, neither needing any special permission:
  //   ```file:name.ext ... ```     Huddle saves the text itself
  //   [[file: path]]               a file the agent made in its working folder
  _extractAgentFiles(room, text) {
    const attachments = [];
    const wd = this.workDir(room.id);
    let out = text.replace(/```file:([^\n`]+)\n([\s\S]*?)```/g, (_m, name, body) => {
      if (attachments.length >= MAX_FILES_PER_MESSAGE) return '';
      const a = this._saveAttachment(room, name.trim(), Buffer.from(body.replace(/\n$/, ''), 'utf8'));
      if (a.error) return `(${a.error})`;
      attachments.push(a);
      return '';
    });
    out = out.replace(/^[ \t]*\[\[file:\s*(.+?)\s*\]\][ \t]*$/gm, (_m, p) => {
      if (attachments.length >= MAX_FILES_PER_MESSAGE) return '';
      const abs = path.resolve(wd, p.replace(/^["']|["']$/g, ''));
      try {
        const real = fs.realpathSync(abs);
        const st = fs.statSync(real);
        if (!this._inside(fs.realpathSync(wd), real)) return `(I couldn't attach ${p}, because it's outside this room's folder.)`;
        if (!st.isFile()) return `(I couldn't attach ${p}, because that path isn't a file.)`;
        if (st.size > MAX_FILE_BYTES) return `(I couldn't attach ${p}, because it's over the size limit.)`;
        this.files.add(path.resolve(real));
        attachments.push(this._describeFile(real, path.basename(real)));
        return '';
      } catch (_) {
        return `(I couldn't attach ${p}, and I couldn't find that file.)`;
      }
    });
    return { text: out.replace(/\n{3,}/g, '\n\n').trim(), attachments };
  }

  isKnownFile(p) {
    return this.files.has(path.resolve(String(p || '')));
  }

  fileDataUrl(p) {
    if (!this.isKnownFile(p)) return null;
    try {
      const d = this._describeFile(p);
      if (d.kind !== 'image' || d.size > 12 * 1048576) return null;
      return `data:${d.mime};base64,${fs.readFileSync(p).toString('base64')}`;
    } catch (_) {
      return null;
    }
  }

  // ---------- shared skills ----------

  listSkills() {
    return {
      dir: this.skills.dir,
      skills: this.skills.list().map(({ slug, name, description, size }) => ({ slug, name, description, size })),
      sources: candidateSources(),
    };
  }

  importSkills(paths) {
    const total = { added: [], updated: [], failed: [] };
    for (const p of [].concat(paths || [])) {
      const r = this.skills.importFrom(String(p));
      total.added.push(...r.added);
      total.updated.push(...r.updated);
      total.failed.push(...r.failed);
    }
    this.emit('skills', this.listSkills());
    return total;
  }

  removeSkill(slug) {
    const ok = this.skills.remove(String(slug));
    if (ok) {
      for (const r of this.rooms) r.skills = (r.skills || []).filter((s) => s.toLowerCase() !== String(slug).toLowerCase());
      this._scheduleSave();
      this._emitRooms();
      this.emit('skills', this.listSkills());
    }
    return ok;
  }

  // Skills for this prompt: the room's pinned ones, plus any the human called with /name in their latest message.
  _skillTokens(text) {
    const clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
    const out = [];
    const re = /(^|\s)\/([A-Za-z0-9][\w.-]*)/g;
    let m;
    while ((m = re.exec(clean))) out.push(m[2]);
    return out;
  }

  _activeSkills(room) {
    const picked = [];
    const add = (s) => s && !picked.some((p) => p.slug === s.slug) && picked.push(s);
    for (const slug of room.skills || []) add(this.skills.find(slug));
    for (let i = room.transcript.length - 1; i >= 0; i--) {
      if (room.transcript[i].from !== 'you') continue;
      for (const t of this._skillTokens(room.transcript[i].text)) add(this.skills.find(t));
      break;
    }
    return picked;
  }

  _skillsBlock(room, budget) {
    const all = this.skills.list();
    if (!all.length) return '';
    const lines = [
      '',
      `Shared skills: ${this.config.settings.userName} keeps one skill library that every agent here can use. Available:`,
      ...all.slice(0, 60).map((s) => `- /${s.slug}${s.description ? ': ' + s.description.slice(0, 200) : ''}`),
      `When ${this.config.settings.userName} calls a skill with /name (or it is pinned to this room), its full instructions are included below. Follow them. The skill files live in ${this.skills.dir} if a skill refers to other files and you can read files.`,
    ];
    let left = Math.max(2000, budget);
    for (const s of this._activeSkills(room)) {
      const sk = this.skills.read(s.slug);
      if (!sk || !sk.body) continue;
      let body = sk.body;
      const room_ = Math.min(left, 20000);
      if (body.length > room_) body = body.slice(0, room_) + '\n…[skill truncated to fit]';
      left -= body.length;
      lines.push('', `=== SKILL: /${sk.slug} (folder: ${sk.dir}) ===`, body, `=== END SKILL: /${sk.slug} ===`);
      if (left <= 0) break;
    }
    return lines.join('\n');
  }

  // ---------- state ----------

  getState() {
    return {
      rooms: this.rooms.map((r) => this._summary(r)),
      config: this.config,
      status: this._status(),
    };
  }

  getRoom(id) {
    const r = this._room(id);
    return r ? { room: this._summary(r), transcript: r.transcript } : null;
  }

  _key(roomId, agentId) {
    return roomId + '|' + agentId;
  }

  _today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  _usageNow() {
    const day = this._today();
    if (this.usage.day !== day) this.usage = { day, counts: {} };
    const out = {};
    for (const [id, a] of Object.entries(this.config.agents)) out[id] = { used: this.usage.counts[id] || 0, budget: a.dailyBudget || 0 };
    return out;
  }

  _bumpUsage(agentId) {
    this._usageNow(); // rolls the day over first
    this.usage.counts[agentId] = (this.usage.counts[agentId] || 0) + 1;
    this._scheduleSave();
  }

  _status() {
    const running = {};
    for (const e of this.running.values()) (running[e.room] = running[e.room] || []).push(e.agent);
    const queued = {};
    for (const q of Object.values(this.queues)) {
      if (!q.length) continue;
      const t = q[0];
      queued[t.room] = queued[t.room] || {};
      queued[t.room][t.agent] = q.length;
    }
    return { running, queued, usage: this._usageNow() };
  }

  _emitStatus() {
    this.emit('status', this._status());
  }

  _epoch(roomId) {
    return this.epochs.get(roomId) || 0;
  }

  _post(room, msg) {
    msg.id = this.nextMsgId++;
    msg.ts = Date.now();
    msg.room = room.id;
    room.transcript.push(msg);
    this._scheduleSave();
    this.emit('message', msg);
    return msg;
  }

  _note(room, text, kind = 'info') {
    return this._post(room, { from: 'system', kind, text });
  }

  _members(room) {
    return room.agents.filter((id) => this.config.agents[id] && this.config.agents[id].enabled);
  }

  // ---------- mentions ----------

  // Returns {hit: members mentioned, outside: enabled agents mentioned who aren't in this room}
  _findMentions(room, text, { allowAll }) {
    const clean = String(text)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ');
    const ids = Object.keys(this.config.agents);
    const names = ids.concat(allowAll ? ['all', 'everyone'] : []).map(escRe).join('|');
    const re = new RegExp('(^|[^\\w@.])@(' + names + ')(?![\\w-])', 'gi');
    const members = this._members(room);
    const hit = [];
    const outside = [];
    const add = (id) => {
      if (!this.config.agents[id] || !this.config.agents[id].enabled) return;
      if (members.includes(id)) {
        if (!hit.includes(id)) hit.push(id);
      } else if (!outside.includes(id)) outside.push(id);
    };
    let m;
    while ((m = re.exec(clean))) {
      const n = m[2].toLowerCase();
      if (n === 'all' || n === 'everyone') members.forEach(add);
      else add(n);
    }
    return { hit, outside };
  }

  // ---------- sending ----------

  send(roomId, text, files) {
    const room = this._room(roomId);
    text = String(text || '').trim();
    const incoming = Array.isArray(files) ? files.slice(0, MAX_FILES_PER_MESSAGE) : [];
    if (!room || (!text && !incoming.length)) return null;
    if (room.archived) {
      room.archived = false; // talking in an archived room brings it back
      this._emitRooms();
    }

    const attachments = [];
    for (const f of incoming) {
      const a = this._saveAttachment(room, f && f.name, f && f.data, f && f.mime);
      if (a.error) this._note(room, a.error, 'error');
      else attachments.push(a);
    }
    if (!text && !attachments.length) return null;

    const members = this._members(room);
    const pm = { from: 'you', text };
    if (attachments.length) pm.attachments = attachments;
    const msg = this._post(room, pm);
    const round = msg.id;
    this.rounds.set(round, { runs: 0 });

    if (!members.length) {
      this._note(room, `nobody in ${room.name} is switched on. add an agent in the room settings, or switch one on in settings.`, 'error');
      return msg;
    }

    const { hit, outside } = this._findMentions(room, text, { allowAll: true });
    if (outside.length) {
      const names = outside.map((id) => this.config.agents[id].label).join(', ');
      this._note(room, `${names} ${outside.length > 1 ? "aren't" : "isn't"} in ${room.name}. you can add them in the room settings.`);
    }
    let targets = hit;
    if (!targets.length && !outside.length) {
      const last = this.lastResponder.get(room.id);
      targets = [last && members.includes(last) ? last : members[0]];
    }
    for (const id of targets) this._enqueue(room, id, round);
    return msg;
  }

  // User clicked "send to X" on an agent's tag (used when auto hand-off is off or paused).
  relay(roomId, agentId, fromMsgId) {
    const room = this._room(roomId);
    const a = this.config.agents[agentId];
    const msg = room && room.transcript.find((m) => m.id === fromMsgId);
    if (!a || !a.enabled || !msg || !room.agents.includes(agentId)) return false;
    this.rounds.set(fromMsgId, { runs: 0 }); // you chose to continue, so the budget resets
    if (Array.isArray(msg.handoffs)) {
      msg.handoffs = msg.handoffs.filter((x) => x !== agentId);
      this._scheduleSave();
      this.emit('message-updated', msg);
    }
    return this._enqueue(room, agentId, fromMsgId);
  }

  _enqueue(room, agentId, round) {
    const key = this._key(room.id, agentId);
    const q = (this.queues[key] = this.queues[key] || []);
    if (q.some((t) => t.round === round)) return false; // already waiting for this thread
    q.push({ room: room.id, agent: agentId, round, epoch: this._epoch(room.id) });
    this._emitStatus();
    this._pump(key);
    return true;
  }

  _pump(key) {
    if (this.running.has(key)) return;
    const q = this.queues[key];
    if (!q || !q.length) return;
    const task = q.shift();
    if (!q.length) delete this.queues[key];
    this._run(task);
  }

  // stop(roomId) stops one room. stop() stops everything.
  stop(roomId = null, silent = false) {
    const targets = roomId ? [roomId] : this.rooms.map((r) => r.id);
    for (const rid of targets) {
      const prefix = rid + '|';
      const queuedKeys = Object.keys(this.queues).filter((k) => k.startsWith(prefix) && this.queues[k].length);
      const runs = [...this.running.values()].filter((e) => e.room === rid);
      const had = queuedKeys.length > 0 || runs.length > 0;
      this.epochs.set(rid, this._epoch(rid) + 1);
      Object.keys(this.queues)
        .filter((k) => k.startsWith(prefix))
        .forEach((k) => delete this.queues[k]);
      runs.forEach((e) => killTree(e.child));
      const room = this._room(rid);
      if (had && !silent && room) this._note(room, 'I stopped this room. nothing else runs here until you send another message.');
    }
    this._emitStatus();
  }

  clear(roomId) {
    const room = this._room(roomId);
    if (!room) return false;
    this.stop(roomId, true);
    room.transcript = [];
    this.lastResponder.delete(roomId);
    this.flush();
    this.emit('cleared', roomId);
    this._emitRooms();
    return true;
  }

  // ---------- running an agent ----------

  async _run(task) {
    const room = this._room(task.room);
    const key = this._key(task.room, task.agent);
    if (!room || task.epoch !== this._epoch(task.room)) return this._pump(key); // gone or stopped
    const myEpoch = task.epoch;
    const agent = this.config.agents[task.agent];
    const entry = { child: null, room: task.room, agent: task.agent };
    this.running.set(key, entry);
    this._bumpUsage(task.agent);
    this._emitStatus();

    let result;
    try {
      result = await this._exec(room, task.agent, entry);
    } catch (e) {
      result = { error: e, stdout: '', stderr: '' };
    }
    this.running.delete(key);

    if (this._epoch(task.room) !== myEpoch || !this._room(task.room)) {
      // stopped (or room deleted) while running: throw the output away
      this._emitStatus();
      return this._pump(key);
    }

    try {
      this._handleResult(room, task.agent, agent, task, result);
    } catch (e) {
      this._note(room, `I hit an error while handling ${agent.label}'s reply: ${e.message}`, 'error');
    }
    this._emitStatus();
    this._pump(key);
  }

  _handleResult(room, agentId, agent, task, r) {
    const out = stripAnsi(r.stdout || '').trim();
    // Codex (and others) spew harmless MCP-server noise on stderr; don't let it bury the real error.
    const errTail = stripAnsi(r.stderr || '')
      .split(/\r?\n/)
      .filter((l) => !/rmcp::|worker quit with fatal|Transport channel closed/i.test(l) && !/^\(HttpRequest\(/.test(l.trim()))
      .join('\n')
      .trim()
      .slice(-700);
    const secs = this.config.settings.timeoutSec;

    const notFound =
      (r.error && r.error.code === 'ENOENT') ||
      (!out && /is not recognized|command not found/i.test(r.stderr || ''));

    if (notFound) {
      this._note(
        room,
        `I couldn't start \`${agent.command}\`. check that the ${agent.label} CLI is installed, that you're logged in, and that I can reach it. settings → check my CLIs shows where I'm looking.`,
        'error'
      );
      return;
    }
    if (r.error) {
      this._note(room, `${agent.label} failed to run: ${r.error.message}`, 'error');
      return;
    }
    if (r.timedOut) {
      this._note(room, `${agent.label} took longer than ${secs}s, so I stopped it.`, 'error');
      return;
    }
    if (r.code !== 0) {
      this._note(
        room,
        `${agent.label} exited with code ${r.code}.` + (errTail ? `\n${errTail}` : out ? `\n${out.slice(-500)}` : ''),
        'error'
      );
      return;
    }
    if (!out) {
      this._note(room, `${agent.label} came back empty.` + (errTail ? `\n${errTail}` : ''), 'error');
      return;
    }

    // Work out hand-offs before posting, so the message carries any leftover tags.
    const S = this.config.settings;
    const roundState = this.rounds.get(task.round) || { runs: 0 };
    this.rounds.set(task.round, roundState);
    const extracted = this._extractAgentFiles(room, out);
    const shownText = extracted.text;
    const tagged = this._findMentions(room, shownText, { allowAll: false }).hit.filter((id) => id !== agentId);
    const toRun = [];
    const leftover = [];
    let paused = false;
    for (const id of tagged) {
      if (S.autoHandoff && roundState.runs < (S.capHandoffs ? S.maxAutoRuns : HARD_CEILING)) {
        roundState.runs++;
        toRun.push(id);
      } else {
        leftover.push(id);
        if (S.autoHandoff) paused = true;
      }
    }

    const msg = { from: agentId, text: shownText, round: task.round };
    if (extracted.attachments.length) msg.attachments = extracted.attachments;
    if (leftover.length) msg.handoffs = leftover;
    this.lastResponder.set(room.id, agentId);
    this._post(room, msg);

    if (paused) {
      this._note(
        room,
        S.capHandoffs
          ? `paused after ${S.maxAutoRuns} automatic hand-offs, so they don't burn through your usage. tap a tag if you want to keep going, or send a new message. you can change this in settings → back-and-forth.`
          : `I hit the safety ceiling of ${HARD_CEILING} automatic replies in a row, so I stopped. tap a tag if you want to keep going, or send a new message.`
      );
    }
    for (const id of toRun) this._enqueue(room, id, task.round);
  }

  _buildPrompt(room, agentId, maxChars) {
    const S = this.config.settings;
    const me = this.config.agents[agentId];
    const members = this._members(room);
    const others = members
      .filter((id) => id !== agentId)
      .map((id) => `${this.config.agents[id].label} (@${id})`);
    const firstOther = members.find((id) => id !== agentId);

    const labelOf = (from) => (from === 'you' ? S.userName : (this.config.agents[from] || { label: from }).label);
    const msgs = room.transcript.filter((m) => m.from !== 'system').slice(-S.contextMessages);
    const lines = msgs.map((m) => {
      let t = m.text || '';
      if (t.length > MAX_PER_MESSAGE_CHARS) t = t.slice(0, MAX_PER_MESSAGE_CHARS) + '\n…[truncated]';
      const wd = this.workDir(room.id);
      const att = (m.attachments || []).map((a) => {
        const ref = this._inside(wd, a.path) ? path.relative(wd, a.path).split(path.sep).join('/') : a.path;
        return `[Attached ${a.kind}: ${ref} (${Math.max(1, Math.round(a.size / 1024))} KB)]`;
      });
      if (att.length) t = (t ? t + '\n' : '(no text)\n') + att.join('\n');
      return `[${labelOf(m.from)}] ${t}`;
    });
    const skillBudget = maxChars ? Math.floor(maxChars * 0.4) : 30000;
    const skillsText = this._skillsBlock(room, skillBudget);
    const cap = Math.max(1500, Math.min(S.contextChars, (maxChars || Infinity) - skillsText.length - 1500));
    let total = lines.reduce((n, l) => n + l.length + 2, 0);
    while (lines.length > 1 && total > cap) total -= lines.shift().length + 2;

    const head = [
      `You are ${me.label} (@${agentId}), one of several AI agents in a group chat room called "${room.name}", with a human, ${S.userName}` +
        (others.length ? `, and: ${others.join(', ')}.` : '.'),
    ];
    if (room.topic) head.push('', `What this room is for: ${room.topic}`);
    if (skillsText) head.push(skillsText);

    return [
      ...head,
      '',
      'House rules:',
      `- Reply only as ${me.label}, to the latest messages. Keep it conversational and concise unless asked for depth.`,
      firstOther
        ? `- To pass the conversation to another agent, @mention them by name (for example @${firstOther}). Only do this when you genuinely need their input. Don't tag someone just to thank or agree with them.`
        : `- You're the only agent in this room right now, so there's nobody to hand off to.`,
      `- Do not prefix your reply with your own name or a transcript label. Just write the message.`,
      `- This is a chat. Don't edit files or run commands unless ${S.userName} explicitly asked you to.`,
      `- Files attached to messages are saved in your working folder (shown as [Attached ...] with a path). Open them from that path if your tools can read files.`,
      `- To send ${S.userName} a file, either write a fenced block whose first line is \`\`\`file:name.ext containing the file's text, or save it in your working folder and put [[file: path]] on its own line. Huddle attaches it to your message.`,
      '',
      '--- Conversation so far ---',
      lines.join('\n\n'),
      '--- End of conversation ---',
      '',
      `Write ${me.label}'s next message.`,
    ].join('\n');
  }

  async _exec(room, agentId, entry) {
    const agent = this.config.agents[agentId];
    const S = this.config.settings;
    const cwd = this.workDir(room.id);

    let args = (agent.args || []).slice();
    const usesFile = agent.input === 'file' || args.some((a) => a.includes('{promptFile}'));
    const usesArg = agent.input === 'arg' || args.some((a) => a.includes('{prompt}'));
    const prompt = this._buildPrompt(room, agentId, usesArg ? ARG_MODE_MAX_CHARS : undefined);

    const resolved = await resolveCommand(agent.command);
    if (!resolved) return { error: Object.assign(new Error('not found'), { code: 'ENOENT' }), stdout: '', stderr: '' };

    const shim = IS_WIN && /\.(cmd|bat)$/i.test(resolved);
    if (shim && usesArg) {
      return {
        error: new Error(
          `${agent.command} is a .cmd shim, and Windows can't pass a long multi-line prompt to those as an argument. in settings, set "prompt goes in via" to stdin or a temp file for ${agent.label}.`
        ),
        stdout: '',
        stderr: '',
      };
    }

    let promptFile = null;
    if (usesFile) {
      promptFile = path.join(os.tmpdir(), `huddle-${process.pid}-${agentId}-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, prompt, 'utf8');
      args = args.map((a) => a.split('{promptFile}').join(promptFile));
    }
    if (usesArg) args = args.map((a) => a.split('{prompt}').join(prompt));

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let done = false;
      let timedOut = false;
      let timer = null;

      const finish = (extra) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (promptFile) fs.unlink(promptFile, () => {});
        resolve(Object.assign({ stdout, stderr, timedOut }, extra));
      };

      let child;
      try {
        if (shim) {
          child = spawn([resolved, ...args].map(winQuote).join(' '), [], {
            cwd,
            shell: true,
            windowsHide: true,
            env: process.env,
          });
        } else if (IS_WIN) {
          child = spawn(resolved, args, { cwd, windowsHide: true, env: process.env });
        } else {
          child = spawn(resolved, args, { cwd, env: process.env, detached: true });
        }
      } catch (e) {
        return finish({ error: e });
      }
      entry.child = child;

      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, S.timeoutSec * 1000);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        if (stdout.length < MAX_CAPTURE) stdout += d;
      });
      child.stderr.on('data', (d) => {
        if (stderr.length < MAX_CAPTURE) stderr += d;
      });
      child.on('error', (e) => finish({ error: e }));
      child.on('close', (code) => finish({ code }));

      child.stdin.on('error', () => {});
      if (usesFile || usesArg) child.stdin.end();
      else child.stdin.end(prompt, 'utf8');
    });
  }

  // ---------- export ----------

  exportMarkdown(roomId) {
    const room = this._room(roomId) || this.rooms[0];
    const S = this.config.settings;
    const label = (f) => (f === 'you' ? S.userName : f === 'system' ? 'AI Huddle' : (this.config.agents[f] || { label: f }).label);
    const names = [...new Set(room.transcript.map((m) => label(m.from)))].filter((n) => n !== 'AI Huddle');
    const parts = [`# ${room.name}`, ''];
    if (room.topic) parts.push(`_${room.topic}_`, '');
    parts.push(
      `> exported from AI Huddle on ${new Date().toLocaleDateString()}. a group chat between ${names.join(', ') || 'you and your AI agents'}. ` +
        "if you're an AI reading this, treat it as the shared history so far and pick up where it leaves off.",
      ''
    );
    for (const m of room.transcript) {
      parts.push(`**${label(m.from)}** · ${new Date(m.ts).toLocaleString()}`, '', m.text || '');
      for (const a of m.attachments || []) parts.push(`- attachment: ${a.name} (${a.path})`);
      parts.push('');
    }
    return parts.join('\n');
  }
}

module.exports = { Engine, DEFAULTS, TEAMS, stripAnsi, winQuote, resolveCommand };
