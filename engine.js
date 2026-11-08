'use strict';
/*
 * Huddle engine: rooms, each with their own chat, and CLI agents that talk in them.
 *
 * - Every agent call is a fresh CLI run (claude -p, codex exec, grok -p ...), or for a room's builder, a run through
 *   that CLI's interactive connection (drivers/) so it can stop and ask before it acts.
 * - Each run gets that room's recent transcript, so agents "see" the room they're in.
 * - Rooms have a topic (given to the agents as a brief), members, and an optional folder.
 * - @mentions route messages. Agents can tag each other, capped by a per-message budget.
 * - Chat-only rooms add no permission flags. A builder's permission flags only come from build mode, and the one level
 *   that switches an agent's own permission checks off ("run everything automatically") has to be picked, and
 *   confirmed, per room.
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
const caps = require('./capabilities');
const codexDriver = require('./drivers/codex-appserver');
const grokDriver = require('./drivers/grok-acp');
const claudeHooks = require('./drivers/claude-hooks');
const DRIVERS = ['codex-appserver', 'grok-acp', 'claude-hooks'];
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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
      // edit: file edits are applied automatically. run: also any shell command (git, npm, builds...).
      probe: { version: ['--version'], mcp: ['mcp', 'list'] },
      accessArgs: { edit: ['--permission-mode', 'acceptEdits'], run: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash'] },
      // Permission cards via Claude Code's own PreToolUse hooks (see drivers/claude-hooks.js).
      driver: 'claude-hooks',
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
      // Codex's own sandbox: it can write inside the folder and run commands there, but usually has no network.
      probe: { version: ['--version'], mcp: ['mcp', 'list'] },
      accessArgs: { edit: ['--sandbox', 'workspace-write'], run: ['--sandbox', 'workspace-write'] },
      // Talks to `codex app-server` so it can ask before running commands or changing files (permission cards).
      driver: 'codex-appserver',
      driverArgs: ['app-server'],
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
      // Grok has no documented "edit only" setting. Its build mode auto-approves every tool call, so it only offers 'run'.
      probe: { version: ['--version'], mcp: ['mcp', 'list'] },
      accessArgs: { run: ['--always-approve'] },
      // Grok Build's Agent Client Protocol: `grok agent stdio` (see drivers/grok-acp.js).
      driver: 'grok-acp',
      driverArgs: ['--no-auto-update', 'agent', 'stdio'],
    },
  },
};

// Team style: who's called what. The @ids never change, only the display names.
const TEAMS = {
  mixed: { claude: 'Claude', codex: 'Codexa', grok: 'Grok' },
  girls: { claude: 'Claudette', codex: 'Codexa', grok: 'Grokette' },
  boys: { claude: 'Claude', codex: 'Codex', grok: 'Grok' },
};

// Build mode: what an agent may do in a room's folder. 'chat' adds nothing. Which flags turn each level on is
// per agent (agents.<id>.accessArgs), shown and editable in Settings. A missing level means that agent can't do it.
const ACCESS_LEVELS = ['chat', 'edit', 'run'];
// When a builder agent needs permission: ask every time, ask once per kind of action per chat, run freely inside the
// room's folder, or run everything with no questions. Only agents with an interactive driver can honor these.
const APPROVAL_LEVELS = ['ask', 'chat', 'folder', 'auto'];
const ACTIVITY_MAX = 300;
const MEMORY_MAX_CHARS = 30000;

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

// cmd.exe quoting, only used for .cmd/.bat shims on Windows. Inside double quotes cmd.exe leaves & | < > ^ ( ) alone,
// so quoting covers those. A backslash does NOT escape a quote for cmd.exe, so embedded quotes are doubled, and
// trailing backslashes are doubled so they can't swallow the closing quote. % and ! still expand inside quotes, which
// is why shimArgProblem() refuses them before we ever get here.
function winQuote(a) {
  a = String(a);
  if (a === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(a)) return a;
  return '"' + a.replace(/"/g, '""').replace(/(\\+)$/, '$1$1') + '"';
}

// Characters cmd.exe can't be trusted to pass through to a .cmd shim untouched (variable expansion, line breaks,
// quote games). Returns the first bad argument, or null.
function shimArgProblem(args) {
  for (const a of args) if (/["%!\r\n\u0000]/.test(String(a))) return String(a);
  return null;
}

// path.resolve, but following symlinks for the part of the path that exists, so a link inside a folder can't make
// somewhere else look like it's inside.
function realish(p) {
  const full = path.resolve(p);
  let cur = full;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch (_) {}
    const up = path.dirname(cur);
    if (up === cur) return full;
    rest.push(path.basename(cur));
    cur = up;
  }
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

// Accepts https://host/owner/repo(.git), git@host:owner/repo(.git), or owner/repo (meaning GitHub). Nothing else, so a
// pasted string can never turn into a git option or a local path.
function parseRepoUrl(input) {
  let s = String(input || '').trim();
  if (!s || /\s/.test(s) || s.startsWith('-')) return null;
  let m = s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (m && !/^https?:/.test(s)) return { url: `https://github.com/${m[1]}/${m[2]}.git`, name: m[2] };
  m = s.match(/^https:\/\/([\w.-]+)\/([\w.-]+(?:\/[\w.-]+)*?)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (m) return { url: s, name: m[3] };
  m = s.match(/^git@([\w.-]+):([\w.-]+(?:\/[\w.-]+)*?)\/([\w.-]+?)(?:\.git)?$/);
  if (m) return { url: s, name: m[3] };
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
    this.perms = new Map(); // permission id -> pending request (see _askPermission)
    this.nextPermId = 1;
    this.grants = new Map(); // roomId -> Set of kinds allowed 'for this chat' (in memory: ends when the app closes)
    this.activity = new Map(); // roomId -> recent things agents did / asked / were allowed
    this.doing = new Map(); // 'room|agent' -> short live text
    this.rounds = new Map(); // message id -> {runs}
    this.lastResponder = new Map(); // roomId -> agentId
    this._saveTimer = null;
    this.files = new Set(); // absolute paths of every attachment Huddle knows about (the UI may only open these)
    this.memoryFile = path.join(storeDir, 'memory.md');
    this.usage = { day: '', counts: {} }; // runs started from AI Huddle today, per agent
    this.opts = opts;
    this.skills = new SkillStore(opts.skillsDir || path.join(storeDir, 'skills'));
    // Per-run temp files (prompt files, Claude's hook settings) live here, in your own app data folder, not the shared
    // system temp folder. Anything left behind by a crash is swept on the next start.
    this.tmpDir = path.join(storeDir, 'tmp');
    this._sweepTmp();

    this._load();
    if (opts.config) this._mergeConfig(opts.config, true);
    if (!this.rooms.length || this.rooms.every((r) => r.archived)) this._newRoom({ name: 'general' });
    for (const r of this.rooms) this._seedLastResponder(r);
  }

  // ---------- private temp files ----------

  _sweepTmp() {
    try {
      fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
      const cutoff = Date.now() - 60 * 60 * 1000; // older than an hour: no live run can still need it
      for (const f of fs.readdirSync(this.tmpDir)) {
        if (!/^huddle-/.test(f)) continue;
        const p = path.join(this.tmpDir, f);
        try {
          if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Writes a new file only this user can read. 'wx' refuses to follow or reuse anything already at that path.
  _writeTmp(prefix, ext, content) {
    fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.tmpDir, `huddle-${prefix}-${process.pid}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return file;
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
      access: ACCESS_LEVELS.includes(r.access) ? r.access : 'chat',
      approval: APPROVAL_LEVELS.includes(r.approval) ? r.approval : 'ask',
      builder: ids.includes(r.builder) ? r.builder : '',
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
        if (p.accessArgs && typeof p.accessArgs === 'object') {
          const next = {};
          for (const lvl of ['edit', 'run']) {
            const v = p.accessArgs[lvl];
            if (Array.isArray(v)) {
              const clean = v.map(String).filter((x) => x.length);
              if (clean.length) next[lvl] = clean;
            }
          }
          a.accessArgs = next;
        }
        if (trusted) {
          if (DRIVERS.includes(p.driver)) a.driver = p.driver;
          else if (p.driver === '') delete a.driver; // tests and advanced setups: no interactive driver
          if (Array.isArray(p.driverArgs)) a.driverArgs = p.driverArgs.map(String).filter((x) => x.length);
        }
        if (trusted && p.probe && typeof p.probe === 'object') {
          const next = {};
          for (const k of ['version', 'mcp']) if (Array.isArray(p.probe[k])) next[k] = p.probe[k].map(String).filter((x) => x.length);
          a.probe = next;
        }
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
      access: r.access || 'chat',
      approval: r.approval || 'ask',
      builder: r.builder || '',
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
      access: ACCESS_LEVELS.includes(p.access) ? p.access : 'chat',
      approval: APPROVAL_LEVELS.includes(p.approval) ? p.approval : 'ask',
      builder: ids.includes(p.builder) ? p.builder : '',
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
    const before = { access: room.access, builder: room.builder, approval: room.approval, workDir: room.workDir };
    if ('name' in p) room.name = this._cleanName(p.name) || room.name;
    if ('topic' in p) room.topic = String(p.topic || '').slice(0, 2000);
    if ('workDir' in p) room.workDir = String(p.workDir || '').trim();
    if (Array.isArray(p.agents)) room.agents = p.agents.filter((a) => ids.includes(a));
    if (Array.isArray(p.skills)) room.skills = p.skills.map(String).slice(0, 40);
    if ('access' in p && ACCESS_LEVELS.includes(p.access)) room.access = p.access;
    if ('approval' in p && APPROVAL_LEVELS.includes(p.approval)) room.approval = p.approval;
    if ('builder' in p) room.builder = ids.includes(p.builder) ? p.builder : '';
    // "allow for this chat" was given to one builder, at one level, in one folder. Change any of those and it's gone.
    if (['access', 'builder', 'approval', 'workDir'].some((k) => before[k] !== room[k])) this.grants.delete(room.id);
    // A card that's still open was asked under the old builder/access/folder. Answering it now could allow something
    // the new settings don't, so it's closed as a "no" and the agent is told why.
    if (['access', 'builder', 'workDir'].some((k) => before[k] !== room[k])) this._denyRoomPermissions(room.id, "the room's build settings changed");
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

  // Clone a repo with the user's own git login (same as a terminal would) into the room's area, then point the room at it.
  cloneRepo(roomId, input) {
    const room = this._room(roomId);
    const parsed = parseRepoUrl(input);
    if (!room) return Promise.resolve({ error: 'That room is gone.' });
    if (!parsed && !(this.opts && this.opts.allowAnyRepoUrl)) {
      return Promise.resolve({ error: 'Use an https link like https://github.com/you/repo, a git@ link, or just you/repo.' });
    }
    const info = parsed || { url: String(input).trim(), name: path.basename(String(input).trim()).replace(/\.git$/, '') || 'repo' };
    const base = path.join(this.config.settings.workDir || path.join(this.storeDir, 'workspace'), 'repos');
    let dest = path.join(base, info.name);
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(base, `${info.name}-${i}`);
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch (e) {
      return Promise.resolve({ error: "I couldn't make the folder for it: " + e.message });
    }
    return new Promise((resolve) => {
      execFile(
        'git',
        ['clone', '--', info.url, dest],
        { windowsHide: true, timeout: 10 * 60 * 1000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, _out, stderr) => {
          if (err) {
            const why = err.code === 'ENOENT' ? 'Git isn\'t installed (or isn\'t on your PATH).' : String(stderr || err.message).trim().split('\n').slice(-3).join(' ');
            return resolve({ error: "I couldn't clone it: " + why });
          }
          room.workDir = dest;
          this._scheduleSave();
          this._emitRooms();
          resolve({ ok: true, path: dest, name: info.name });
        }
      );
    });
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
    const doing = {};
    for (const [k, t] of this.doing) {
      const [rid, aid] = k.split('|');
      (doing[rid] = doing[rid] || {})[aid] = t;
    }
    return { running, queued, doing, pending: this.getPermissions().length, usage: this._usageNow() };
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
      // Mark first: a run that's still finding its CLI (no child yet) checks this before it spawns, and a permission
      // request that arrives after this point is refused instead of opening a fresh card in a stopped room.
      runs.forEach((e) => (e.stopped = true));
      this._denyRoomPermissions(rid, 'you stopped the room');
      runs.forEach((e) => {
        if (e.stop) e.stop();
        killTree(e.child);
      });
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
    const accNote = this._accessFor(room, task.agent);
    if (accNote.unsupported) {
      this._note(room, `${agent.label} has no "${accNote.wanted === 'edit' ? 'edit files' : 'edit and run'}" setting, so it's chatting only this time. Pick another builder or another level in Room settings.`, 'error');
    }
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

  // chatOnly: this run was downgraded to chat (its permission cards couldn't be set up), whatever the room says.
  _accessRules(room, agentId, chatOnly) {
    const S = this.config.settings;
    const acc = this._accessFor(room, agentId);
    const wd = this.workDir(room.id);
    const builder = room.builder && this.config.agents[room.builder];
    if (chatOnly && acc.level !== 'chat') {
      return [
        `- You are the builder in this room, but this time you can't change files or run commands: AI Huddle couldn't set up the permission checks ${S.userName} asked for, so it's running you as chat only. Say what you would change and why, and ${S.userName} can decide.`,
      ];
    }
    if (acc.level === 'chat') {
      const rules = [`- This is a chat. Don't edit files or run commands unless ${S.userName} explicitly asked you to.`];
      if (builder && room.access !== 'chat' && room.builder !== agentId) {
        rules.push(`- ${builder.label} (@${room.builder}) is the builder in this room. Leave changes to files to them. You can read, review and advise.`);
      }
      return rules;
    }
    const can = acc.level === 'run' ? 'edit files and run commands (git, builds, tests)' : 'edit files (but not run shell commands)';
    return [
      `- You are the builder in this room. You may ${can} in your working folder: ${wd}. Stay inside that folder.`,
      `- Work on a git branch, never directly on main/master. Don't force-push, delete branches, or delete files ${S.userName} didn't ask you to remove. Don't push unless ${S.userName} asks.`,
      `- Tell ${S.userName} what you changed and where. The other agents can't see your files unless you describe them.`,
    ];
  }

  _memoryBlock(budget) {
    const raw = this.getMemory().trim();
    if (!raw) return '';
    let text = raw;
    if (text.length > budget) text = text.slice(0, budget) + '\n…[memory truncated to fit]';
    return [
      '',
      `--- About ${this.config.settings.userName} (their shared memory: background you can rely on, not something to recite back) ---`,
      text,
      '--- End of memory ---',
    ].join('\n');
  }

  getMemory() {
    try {
      return fs.readFileSync(this.memoryFile, 'utf8');
    } catch (_) {
      return '';
    }
  }

  setMemory(text) {
    const t = String(text == null ? '' : text).replace(/\r\n/g, '\n').slice(0, MEMORY_MAX_CHARS);
    try {
      fs.writeFileSync(this.memoryFile, t, 'utf8');
    } catch (e) {
      this.emit('error-note', "I couldn't save the shared memory: " + e.message);
    }
    return { text: t, max: MEMORY_MAX_CHARS, trimmed: String(text || '').length > MEMORY_MAX_CHARS };
  }

  _buildPrompt(room, agentId, maxChars, chatOnly) {
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
    const memoryText = this._memoryBlock(maxChars ? Math.floor(maxChars * 0.25) : MEMORY_MAX_CHARS);
    const cap = Math.max(1500, Math.min(S.contextChars, (maxChars || Infinity) - skillsText.length - memoryText.length - 1500));
    let total = lines.reduce((n, l) => n + l.length + 2, 0);
    while (lines.length > 1 && total > cap) total -= lines.shift().length + 2;

    const head = [
      `You are ${me.label} (@${agentId}), one of several AI agents in a group chat room called "${room.name}", with a human, ${S.userName}` +
        (others.length ? `, and: ${others.join(', ')}.` : '.'),
    ];
    if (room.topic) head.push('', `What this room is for: ${room.topic}`);
    if (memoryText) head.push(memoryText);
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
      ...this._accessRules(room, agentId, chatOnly),
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

  // What this agent may do in this room: only the room's builder gets anything beyond chat. An agent with an
  // interactive driver can build at any level (its permission cards do the gating); one without needs flags for it.
  _accessFor(room, agentId) {
    const agent = this.config.agents[agentId];
    const level = room.access || 'chat';
    if (level === 'chat' || room.builder !== agentId) return { level: 'chat', args: [], unsupported: false };
    const args = (agent.accessArgs && agent.accessArgs[level]) || null;
    if (agent.driver) return { level, args: args ? args.slice() : [], unsupported: false };
    if (!args || !args.length) return { level: 'chat', args: [], unsupported: true, wanted: level };
    return { level, args: args.slice(), unsupported: false };
  }

  // Which agent runs get the permission-card treatment: the room's builder, at edit/run, if it has an interactive driver.
  _interactiveFor(room, agentId) {
    const agent = this.config.agents[agentId];
    if (!room || !agent || !agent.driver) return null;
    if (room.builder !== agentId || (room.access || 'chat') === 'chat') return null;
    return { level: APPROVAL_LEVELS.includes(room.approval) ? room.approval : 'ask', access: room.access, driver: agent.driver };
  }

  async _exec(room, agentId, entry, over) {
    const mode = over ? null : this._interactiveFor(room, agentId);
    if (!mode) return this._execHeadless(room, agentId, entry, over);
    try {
      if (mode.driver === 'claude-hooks') return await this._execClaudeHooks(room, agentId, entry, mode);
      const r = await this._execInteractive(room, agentId, entry, mode);
      if (!r.fallback || entry.stopped) return r;
      if (process.env.HUDDLE_DEBUG) console.error('FALLBACK', JSON.stringify({ code: r.code, stderr: r.stderr, err: r.error && r.error.message }));
      const label = this.config.agents[agentId].label;
      return await this._fallback(room, agentId, entry, mode, `${label}'s interactive mode didn't start${r.error ? ' (' + r.error.message + ')' : ''}`);
    } finally {
      // Whatever happened, a card from this run can't be answered any more: the agent behind it is gone.
      this._closeRunPermissions(entry);
    }
  }

  // The interactive connection (or Claude's hook) couldn't be set up, so nothing can stop and ask you. The agent's normal
  // edit/run flags are only used if you already chose "run everything automatically". At any other level this run is
  // chat only, because quietly swapping "ask me" for "don't ask me" is exactly what the levels promise not to do.
  _fallback(room, agentId, entry, mode, why) {
    const acc = this._accessFor(room, agentId);
    if (mode.level === 'auto' && acc.args.length) {
      this._log(room, agentId, 'info', `${why}; ran with its normal ${acc.level} flags (you picked run everything automatically)`);
      this._note(room, `${why}, so there are no permission cards this time. you picked "run everything automatically", so I ran it the normal way, with its ${acc.level === 'run' ? 'edit and run' : 'edit'} flags from settings.`, 'error');
      return this._execHeadless(room, agentId, entry, undefined, { args: acc.args });
    }
    const instead =
      mode.level === 'auto'
        ? `it has no "${acc.level === 'run' ? 'edit and run' : 'edit files'}" flags in settings to fall back on`
        : "you asked to be asked first, and I won't let it change things without asking";
    this._log(room, agentId, 'info', `${why}; ran as chat only (${instead})`);
    this._note(room, `${why}, so I can't show you permission cards. ${instead}, so it ran as chat only this time. updating that CLI usually fixes this.`, 'error');
    return this._execHeadless(room, agentId, entry, undefined, { args: [], chatOnly: true });
  }

  // Starts a CLI. A .cmd/.bat shim has to go through cmd.exe, so its arguments are checked and quoted for that first.
  _spawnCli(agent, resolved, args, cwd) {
    const shim = IS_WIN && /\.(cmd|bat)$/i.test(resolved);
    if (shim) {
      const bad = shimArgProblem([resolved, ...args]);
      if (bad) {
        throw new Error(
          `${path.basename(resolved)} is a .cmd shim, and Windows can't safely hand it an argument with " % ! or a line break in it (${bad.slice(0, 80)}). remove that from the agent's settings, or point the command at the CLI's .exe.`
        );
      }
      return spawn([resolved, ...args].map(winQuote).join(' '), [], { cwd, shell: true, windowsHide: true, env: process.env });
    }
    if (IS_WIN) return spawn(resolved, args, { cwd, windowsHide: true, env: process.env });
    return spawn(resolved, args, { cwd, env: process.env, detached: true });
  }

  async _execInteractive(room, agentId, entry, mode) {
    const agent = this.config.agents[agentId];
    const S = this.config.settings;
    const cwd = this.workDir(room.id);
    const resolved = await resolveCommand(agent.command);
    if (!resolved) return { error: Object.assign(new Error('not found'), { code: 'ENOENT' }), stdout: '', stderr: '' };
    if (entry.stopped) return { stopped: true, stdout: '', stderr: '' }; // stopped while we were looking for the CLI
    const prompt = this._buildPrompt(room, agentId);
    this._log(room, agentId, 'info', `started (${mode.access === 'run' ? 'edit and run' : 'edit files'}, ${mode.level})`);
    const key = this._key(room.id, agentId);
    const drv = mode.driver === 'grok-acp' ? grokDriver : codexDriver;
    const r = await drv.run({
      spawn: (args) => {
        const child = this._spawnCli(agent, resolved, args, cwd);
        entry.child = child;
        return child;
      },
      kill: killTree,
      args: agent.driverArgs || (mode.driver === 'grok-acp' ? ['agent', 'stdio'] : ['app-server']),
      cwd,
      prompt,
      level: mode.level,
      access: mode.access,
      timeoutMs: S.timeoutSec * 1000,
      version: this.opts.appVersion || '',
      entry,
      activity: (t) => {
        this.doing.set(key, t);
        this._log(room, agentId, 'did', t);
        this._emitStatus();
      },
      onWaiting: (w) => {
        if (w) this.doing.set(key, 'waiting for your answer');
        else this.doing.delete(key);
        this._emitStatus();
      },
      ask: (info) => this._askPermission(room, agentId, mode, info, { entry, cwd }),
    });
    this.doing.delete(key);
    return r;
  }

  // True only if every path is known and, after following symlinks, sits inside base.
  _pathsInside(base, paths) {
    if (!Array.isArray(paths) || !paths.length) return false;
    const root = realish(base);
    return paths.every((p) => typeof p === 'string' && p.trim() !== '' && this._inside(root, realish(path.resolve(base, p))));
  }

  // A permission request from an agent. Resolves {decision:'allow'|'deny', forSession, why}.
  // ctx: {entry (the run asking), cwd (the room's folder for this run), signal (aborts when the asker stops waiting)}
  _askPermission(room, agentId, mode, info, ctx = {}) {
    const agent = this.config.agents[agentId];
    const kind = info.kind || 'other';
    const what = `${String(info.title || '').replace('wants to ', '')}: ${info.detail}`;
    const deny = (why) => {
      this._log(room, agentId, 'denied', `${what} (${why})`);
      return Promise.resolve({ decision: 'deny', why });
    };
    const allow = (why, forSession) => {
      this._log(room, agentId, 'allowed', `${what} (${why})`);
      return Promise.resolve({ decision: 'allow', forSession: !!forSession });
    };
    if (ctx.entry && ctx.entry.stopped) return deny('you stopped the room');
    if (kind === 'command' && mode.access !== 'run') return deny('this room is edit files only, so commands are refused');
    const cwd = ctx.cwd || this.workDir(room.id);
    const inFolder = kind === 'files' && this._pathsInside(cwd, info.paths);
    if (mode.level === 'auto') return allow('you picked run everything automatically');
    // Claude and Grok have no sandbox, so "folder" means: file changes Huddle can see are inside the room's folder go
    // through; anything else (other paths, commands, the web, connectors) still asks. Codex enforces it in its own
    // sandbox and only asks when it wants out.
    if (mode.level === 'folder' && inFolder) return allow("inside this room's folder, which is automatic at this level");
    const g = this.grants.get(room.id);
    if (mode.level === 'chat' && g && g.has(kind) && (kind !== 'files' || inFolder)) return allow('allowed for this chat', true);
    if (ctx.signal && ctx.signal.aborted) return deny('the agent stopped waiting before it could be asked');

    return new Promise((resolve) => {
      const id = 'p' + this.nextPermId++;
      const outside = kind === 'files' && !inFolder;
      const perm = {
        id,
        room: room.id,
        agent: agentId,
        agentLabel: agent.label,
        kind,
        title: info.title,
        detail: info.detail,
        cwd: info.cwd || '',
        reason: info.reason || '',
        // a file change Huddle can't place inside the room's folder (another path, or no path given)
        outside,
        // "for this chat" never covers file changes outside the folder, so don't offer it on those
        canRemember: mode.level === 'chat' && !outside,
        ts: Date.now(),
        resolve,
        entry: ctx.entry || null,
      };
      this.perms.set(id, perm);
      this._log(room, agentId, 'asked', `${info.title}: ${info.detail}`);
      if (ctx.signal) ctx.signal.addEventListener('abort', () => this._closePermission(id, 'the agent stopped waiting for an answer'), { once: true });
      this.emit('permissions', this.getPermissions());
      this._emitStatus();
    });
  }

  _isWaiting(roomId, agentId) {
    for (const p of this.perms.values()) if (p.room === roomId && p.agent === agentId) return true;
    return false;
  }

  // Claude: normal headless run, plus a per-run hook file so every command / file change / web use / connector call
  // comes to us first.
  async _execClaudeHooks(room, agentId, entry, mode) {
    const key = this._key(room.id, agentId);
    const cwd = this.workDir(room.id);
    const label = this.config.agents[agentId].label;
    // "run everything automatically" in an edit-and-run room is the only combination with nothing left to check, so
    // it's the only one that uses Claude's bypass mode and no hook. Everywhere else the hook stays on.
    const hooked = !(mode.level === 'auto' && mode.access === 'run');
    const flag = !hooked ? 'bypassPermissions' : mode.level === 'ask' || mode.level === 'chat' ? 'default' : 'acceptEdits';
    const args = ['--permission-mode', flag];
    // Edit-only rooms also switch Bash off inside Claude itself, so a hook that never fires can't let a command through.
    if (mode.access !== 'run') args.push('--disallowedTools', 'Bash');
    let reg = null;
    let file = null;
    let waiting = 0;
    if (hooked) {
      try {
        if (!this.hookServer) this.hookServer = new claudeHooks.HookServer();
        await this.hookServer.start();
        reg = this.hookServer.register(async (tool, input, _evt, signal) => {
          const info = claudeHooks.toolInfo(tool, input);
          waiting++;
          this.doing.set(key, 'waiting for your answer');
          this._emitStatus();
          try {
            const ans = await this._askPermission(room, agentId, mode, info, { entry, cwd, signal });
            if (ans.decision === 'allow') return { allow: true, reason: '' };
            return { allow: false, reason: ans.why ? `AI Huddle refused: ${ans.why}` : 'the person said no in AI Huddle' };
          } finally {
            waiting--;
            if (!waiting) this.doing.delete(key);
            this._emitStatus();
          }
        });
        file = this._writeTmp('hooks', '.json', JSON.stringify(claudeHooks.settingsFor(reg.url, 3600)));
        args.push('--settings', file);
      } catch (e) {
        if (reg) reg.release();
        return this._fallback(room, agentId, entry, mode, `I couldn't set up permission cards for ${label} (${e.message})`);
      }
    }
    this._log(room, agentId, 'info', `started (${mode.access === 'run' ? 'edit and run' : 'edit files'}, ${mode.level})`);
    try {
      return await this._execHeadless(room, agentId, entry, undefined, { args });
    } finally {
      if (reg) reg.release();
      if (file) fs.unlink(file, () => {});
    }
  }

  getPermissions() {
    return [...this.perms.values()].map(({ resolve, entry, ...p }) => p);
  }

  // choice: 'once' | 'chat' | 'deny'
  answerPermission(id, choice) {
    const p = this.perms.get(id);
    if (!p) return false; // already answered, closed, or never existed: answering twice does nothing
    this.perms.delete(id);
    const room = this._room(p.room);
    const allow = choice === 'once' || choice === 'chat';
    const remember = choice === 'chat' && p.canRemember;
    if (remember && room) {
      if (!this.grants.has(room.id)) this.grants.set(room.id, new Set());
      this.grants.get(room.id).add(p.kind);
    }
    if (room) {
      const what = `${p.title.replace('wants to ', '')}: ${p.detail}`;
      this._log(room, p.agent, allow ? 'allowed' : 'denied', remember ? `${what} (and the rest of this kind, this chat)` : what);
    }
    p.resolve({ decision: allow ? 'allow' : 'deny', forSession: remember, why: allow ? '' : 'the person said no' });
    this.emit('permissions', this.getPermissions());
    this._emitStatus();
    return true;
  }

  // Closes cards without an answer from you. Each is resolved as "no", logged with the real reason, and removed.
  _closePerms(match, why, kind = 'denied') {
    let any = false;
    for (const [id, p] of [...this.perms]) {
      if (!match(p)) continue;
      this.perms.delete(id);
      any = true;
      const room = this._room(p.room);
      if (room) this._log(room, p.agent, kind, `${p.title.replace('wants to ', '')}: ${p.detail} (${why})`);
      p.resolve({ decision: 'deny', why });
    }
    if (any) {
      this.emit('permissions', this.getPermissions());
      this._emitStatus();
    }
    return any;
  }

  _denyRoomPermissions(roomId, why) {
    return this._closePerms((p) => p.room === roomId, why);
  }

  _closePermission(id, why) {
    return this._closePerms((p) => p.id === id, `card closed without an answer: ${why}`, 'info');
  }

  _closeRunPermissions(entry) {
    if (!entry) return false;
    return this._closePerms((p) => p.entry === entry, 'card closed without an answer: the agent finished or quit first', 'info');
  }

  _log(room, agentId, kind, text) {
    if (!room) return;
    const list = this.activity.get(room.id) || [];
    list.push({ ts: Date.now(), agent: agentId, kind, text: String(text).slice(0, 600) });
    if (list.length > ACTIVITY_MAX) list.splice(0, list.length - ACTIVITY_MAX);
    this.activity.set(room.id, list);
    this.emit('activity', { room: room.id });
  }

  getActivity(roomId) {
    return (this.activity.get(roomId) || []).slice();
  }

  // over (optional): {prompt, cwd, timeoutMs}. Used for health tests, which run outside any room and with no build flags.
  // extra (optional): {args, chatOnly} flags used in place of the room's accessArgs (the Claude hook driver and the
  // fallback use this). chatOnly also tells the agent, in the prompt, that it can't change anything this time.
  async _execHeadless(room, agentId, entry, over, extra) {
    const agent = this.config.agents[agentId];
    const S = this.config.settings;
    const cwd = over && over.cwd ? over.cwd : this.workDir(room.id);

    let args = (agent.args || []).slice();
    const acc = extra ? { args: extra.args || [] } : over ? { args: [] } : this._accessFor(room, agentId);
    if (acc.args.length) {
      // goes after a leading subcommand (codex "exec"), otherwise first
      const at = args.length && !String(args[0]).startsWith('-') ? 1 : 0;
      args.splice(at, 0, ...acc.args);
    }
    const usesFile = agent.input === 'file' || args.some((a) => a.includes('{promptFile}'));
    const usesArg = agent.input === 'arg' || args.some((a) => a.includes('{prompt}'));
    const prompt =
      over && over.prompt != null ? over.prompt : this._buildPrompt(room, agentId, usesArg ? ARG_MODE_MAX_CHARS : undefined, !!(extra && extra.chatOnly));

    const resolved = await resolveCommand(agent.command);
    if (!resolved) return { error: Object.assign(new Error('not found'), { code: 'ENOENT' }), stdout: '', stderr: '' };
    if (entry && entry.stopped) return { stopped: true, stdout: '', stderr: '' }; // stopped while we were looking for the CLI

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
      try {
        promptFile = this._writeTmp(`prompt-${agentId}`, '.txt', prompt);
      } catch (e) {
        return { error: new Error("I couldn't write the prompt file: " + e.message), stdout: '', stderr: '' };
      }
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
        child = this._spawnCli(agent, resolved, args, cwd);
      } catch (e) {
        return finish({ error: e });
      }
      entry.child = child;

      const limit = over && over.timeoutMs ? over.timeoutMs : S.timeoutSec * 1000;
      const arm = () => {
        timer = setTimeout(() => {
          // time spent waiting on your answer to a permission card doesn't count
          if (room && this._isWaiting(room.id, agentId)) return arm();
          timedOut = true;
          killTree(child);
        }, limit);
      };
      arm();

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

  // ---------- what can each agent actually do? ----------

  _capHelpers() {
    return { IS_WIN, winQuote, shimArgProblem, killTree, resolveCommand, stripAnsi, mcpTimeoutMs: this.opts.probeTimeoutMs };
  }

  _sharedSlugs() {
    try {
      return (this.listSkills().skills || []).map((s) => s.slug);
    } catch (_) {
      return [];
    }
  }

  async probeAgent(id) {
    const agent = this.config.agents[id];
    if (!agent) return null;
    const res = await caps.probeAgent(this._capHelpers(), {
      agentId: id,
      agent,
      sharedSlugs: this._sharedSlugs(),
      home: this.opts.homeDir || os.homedir(),
    });
    this.caps = this.caps || { checkedAt: 0, agents: {}, tests: {} };
    this.caps.agents[id] = res;
    this.caps.checkedAt = Date.now();
    this.emit('tools', this.getCapabilities());
    return res;
  }

  async probeAll() {
    await Promise.all(Object.keys(this.config.agents).map((id) => this.probeAgent(id)));
    return this.getCapabilities();
  }

  getCapabilities() {
    const c = this.caps || { checkedAt: 0, agents: {}, tests: {} };
    return JSON.parse(JSON.stringify(c));
  }

  // A real, tiny run through the same launcher rooms use, with no build flags. kind: 'hello' | 'web'.
  // It counts as a run on the usage bar because it is one.
  async testAgent(id, kind) {
    const agent = this.config.agents[id];
    if (!agent) return { ok: false, summary: "I don't know that agent." };
    if (kind !== 'hello' && kind !== 'web') return { ok: false, summary: "I don't know that test." };
    const secs = Math.min(this.config.settings.timeoutSec, 120);
    const prompt =
      kind === 'hello'
        ? 'Reply with exactly: HUDDLE-OK'
        : 'Use your web tools to open https://example.com and read its page title. Reply with one line: TITLE: <the title>. ' +
          "If you can't browse in this mode, reply with: NO-WEB: <one sentence on why, including any setting that blocks it>.";
    this._bumpUsage(id);
    this._emitStatus();
    const t0 = Date.now();
    const r = await this._exec(null, id, {}, { prompt, cwd: this.workDir(), timeoutMs: secs * 1000 });
    const ms = Date.now() - t0;
    const out = stripAnsi(r.stdout || '').trim();
    const errTail = stripAnsi(r.stderr || '')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/rmcp::|worker quit with fatal|Transport channel closed/i.test(l) && !/^\(HttpRequest\(/.test(l.trim()))
      .join('\n')
      .trim()
      .slice(-400);
    let result;
    if ((r.error && r.error.code === 'ENOENT') || (!out && /is not recognized|command not found/i.test(r.stderr || ''))) {
      result = { ok: false, summary: `I couldn't start \`${agent.command}\`. it isn't installed, or I can't find it.` };
    } else if (r.error) {
      result = { ok: false, summary: `${agent.label} failed to run: ${r.error.message}` };
    } else if (r.timedOut) {
      result = { ok: false, summary: `${agent.label} didn't answer within ${secs}s, so I stopped it. it may be waiting on a login or a stuck connector.`, detail: errTail };
    } else if (r.code !== 0) {
      result = { ok: false, summary: `${agent.label} exited with code ${r.code}.`, detail: errTail || out.slice(-400) };
    } else if (kind === 'hello') {
      result = /HUDDLE-OK/.test(out)
        ? { ok: true, summary: `${agent.label} answered, so it's installed and logged in.` }
        : { ok: false, summary: `${agent.label} ran, but didn't answer the way I asked.`, detail: out.slice(0, 400) };
    } else if (/NO-WEB/.test(out)) {
      result = { ok: false, summary: `${agent.label} says it can't browse here.`, detail: out.slice(0, 400) };
    } else if (/TITLE:/i.test(out) && /example domain/i.test(out)) {
      result = { ok: true, summary: `${agent.label} read a live web page.`, detail: out.slice(0, 200) };
    } else {
      result = { ok: false, summary: `${agent.label} replied, but I can't tell it read the page.`, detail: out.slice(0, 400) };
    }
    result = { kind, ms, at: Date.now(), ...result };
    this.caps = this.caps || { checkedAt: 0, agents: {}, tests: {} };
    this.caps.tests = this.caps.tests || {};
    this.caps.tests[id] = { ...(this.caps.tests[id] || {}), [kind]: result };
    this.emit('tools', this.getCapabilities());
    return result;
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

module.exports = { Engine, DEFAULTS, TEAMS, ACCESS_LEVELS, MEMORY_MAX_CHARS, parseRepoUrl, stripAnsi, winQuote, shimArgProblem, realish, resolveCommand };
