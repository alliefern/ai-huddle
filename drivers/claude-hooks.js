'use strict';
// Permission cards for Claude, using Claude Code's own documented PreToolUse hooks (no private protocol):
// each run gets a settings file with an HTTP hook pointing at a tiny server on 127.0.0.1. When Claude is about to
// run a command, change a file, use the web or call a connector (MCP tool), it POSTs the request here, we show a card,
// and the hook's answer ("allow" or "deny") goes straight back. Everything else Claude does (reading, searching)
// passes through untouched.

const http = require('http');
const crypto = require('crypto');

const GATED = 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*';
const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const MAX_BODY = 1024 * 1024; // a PreToolUse event is a few KB; a 1 MB write still fits

function toolInfo(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Bash') return { kind: 'command', title: 'wants to run a command', detail: String(i.command || '').slice(0, 1500), reason: i.description ? String(i.description).slice(0, 300) : '', paths: [] };
  if (name === 'WebFetch' || name === 'WebSearch') return { kind: 'web', title: 'wants to use the web', detail: String(i.url || i.query || '').slice(0, 1500), reason: '', paths: [] };
  if (FILE_TOOLS.includes(name)) {
    const file = String(i.file_path || i.notebook_path || '');
    return {
      kind: 'files',
      title: 'wants to change files',
      detail: file.slice(0, 1500),
      reason: name === 'Write' ? 'create or overwrite this file' : name === 'NotebookEdit' ? 'edit this notebook' : 'edit this file',
      paths: file ? [file] : [],
    };
  }
  if (/^mcp__/.test(name)) {
    const [, server, tool] = name.split('__');
    return { kind: 'connector', title: 'wants to use a connector', detail: `${server || '?'} / ${tool || '?'}`, reason: '', paths: [] };
  }
  // Anything else that reaches the hook is something we don't recognize: show its name and ask.
  return { kind: 'other', title: 'is asking for permission', detail: String(name || 'an unnamed tool').slice(0, 200), reason: '', paths: [] };
}

function decision(allow, reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: String(reason || (allow ? 'allowed in AI Huddle' : 'denied in AI Huddle')) } };
}

// The settings Claude is launched with (written to a private temp file and passed as --settings).
function settingsFor(url, timeoutSec) {
  return { hooks: { PreToolUse: [{ matcher: GATED, hooks: [{ type: 'http', url, timeout: timeoutSec }] }] } };
}

class HookServer {
  constructor() {
    this.server = null;
    this.port = 0;
    this.runs = new Map(); // token -> async (toolName, toolInput, event, abortSignal) => {allow, reason}
    this._starting = null;
  }

  // Safe to call from several runs at once: they all share one server.
  start() {
    if (this.server) return Promise.resolve();
    if (this._starting) return this._starting;
    this._starting = new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => this._handle(req, res));
      s.once('error', (e) => {
        this._starting = null;
        reject(e);
      });
      s.listen(0, '127.0.0.1', () => {
        this.server = s;
        this.port = s.address().port;
        s.unref();
        resolve();
      });
    });
    return this._starting;
  }

  // Returns {url, release()}. onTool(toolName, toolInput, event, abortSignal) -> Promise<{allow, reason}>
  // The token is 144 random bits and only exists in the run's private settings file and in memory here.
  register(onTool) {
    const token = crypto.randomBytes(18).toString('hex');
    this.runs.set(token, onTool);
    return { url: `http://127.0.0.1:${this.port}/hook/${token}`, release: () => this.runs.delete(token) };
  }

  _handle(req, res) {
    const reply = (code, obj) => {
      if (res.writableEnded || res.destroyed) return; // Claude already hung up: nobody to answer
      res.statusCode = code;
      if (obj) res.setHeader('Content-Type', 'application/json');
      res.setHeader('Connection', 'close');
      res.end(obj ? JSON.stringify(obj) : undefined);
    };
    const m = /^\/hook\/([a-f0-9]{36})$/.exec(req.url || '');
    const fn = m && this.runs.get(m[1]);
    // Only Claude, on this machine, using the address we gave it. A web page that rebinds its domain to 127.0.0.1 still
    // sends its own Host header, so it gets the same 404 as a wrong token.
    const hostOk = String(req.headers.host || '') === `127.0.0.1:${this.port}`;
    if (req.method !== 'POST' || !fn || !hostOk) {
      reply(404);
      req.resume();
      return;
    }
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
      reply(413, decision(false, 'AI Huddle refused: the request was too large to check'));
      req.destroy();
      return;
    }

    // If Claude gives up on the hook (its own timeout) or exits while a card is open, the card is closed instead of
    // leaving you a question nobody is waiting for.
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });

    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (d) => {
      if (tooBig) return;
      size += d.length;
      if (size > MAX_BODY) {
        tooBig = true;
        reply(413, decision(false, 'AI Huddle refused: the request was too large to check'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', async () => {
      if (tooBig) return;
      let evt = null;
      try {
        evt = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch (_) {}
      if (!evt || typeof evt !== 'object' || typeof evt.tool_name !== 'string' || !evt.tool_name) {
        // Never guess what an unreadable request wanted: refuse it, and say why.
        return reply(200, decision(false, "AI Huddle refused: it couldn't read what the tool wanted to do"));
      }
      let out;
      try {
        const r = await fn(evt.tool_name, evt.tool_input || {}, evt, ac.signal);
        out = decision(!!(r && r.allow), r && r.reason);
      } catch (e) {
        out = decision(false, 'AI Huddle could not ask: ' + e.message);
      }
      reply(200, out);
    });
  }
}

module.exports = { HookServer, toolInfo, settingsFor, decision, GATED, MAX_BODY };
