'use strict';
// Permission cards for Claude, using Claude Code's own documented PreToolUse hooks (no private protocol):
// each run gets a settings file with an HTTP hook pointing at a tiny server on 127.0.0.1. When Claude is about to
// run a command, change a file or use the web, it POSTs the request here, we show a card, and the hook's answer
// ("allow" or "deny") goes straight back. Everything else Claude does (reading, searching) passes through untouched.

const http = require('http');
const crypto = require('crypto');

const GATED = 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch';

function toolInfo(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Bash') return { kind: 'command', title: 'wants to run a command', detail: String(i.command || '').slice(0, 1500), reason: i.description ? String(i.description).slice(0, 300) : '' };
  if (name === 'WebFetch' || name === 'WebSearch') return { kind: 'web', title: 'wants to use the web', detail: String(i.url || i.query || '').slice(0, 1500), reason: '' };
  const file = i.file_path || i.notebook_path || '';
  return { kind: 'files', title: 'wants to change files', detail: String(file).slice(0, 1500), reason: name === 'Write' ? 'create or overwrite this file' : name === 'NotebookEdit' ? 'edit this notebook' : 'edit this file' };
}

function decision(allow, reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: String(reason || (allow ? 'allowed in AI Huddle' : 'denied in AI Huddle')) } };
}

// The settings Claude is launched with (written to a temp file and passed as --settings).
function settingsFor(url, timeoutSec) {
  return { hooks: { PreToolUse: [{ matcher: GATED, hooks: [{ type: 'http', url, timeout: timeoutSec }] }] } };
}

class HookServer {
  constructor() {
    this.server = null;
    this.port = 0;
    this.runs = new Map(); // token -> async (toolName, toolInput) => {allow, reason}
  }

  async start() {
    if (this.server) return;
    await new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => this._handle(req, res));
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => {
        this.server = s;
        this.port = s.address().port;
        s.unref();
        resolve();
      });
    });
  }

  // Returns {url, release()}. onTool(toolName, toolInput) -> Promise<{allow, reason}>
  register(onTool) {
    const token = crypto.randomBytes(18).toString('hex');
    this.runs.set(token, onTool);
    return { url: `http://127.0.0.1:${this.port}/hook/${token}`, release: () => this.runs.delete(token) };
  }

  _handle(req, res) {
    const m = /^\/hook\/([a-f0-9]+)$/.exec(req.url || '');
    const fn = m && this.runs.get(m[1]);
    if (req.method !== 'POST' || !fn) {
      res.statusCode = 404;
      return res.end();
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => {
      if (body.length < 5e6) body += d;
    });
    req.on('end', async () => {
      let evt = {};
      try {
        evt = JSON.parse(body || '{}');
      } catch (_) {}
      let out;
      try {
        const r = await fn(String(evt.tool_name || ''), evt.tool_input || {}, evt);
        out = decision(r.allow, r.reason);
      } catch (e) {
        out = decision(false, 'AI Huddle could not ask: ' + e.message);
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  }
}

module.exports = { HookServer, toolInfo, settingsFor, decision, GATED };
