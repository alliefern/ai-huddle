'use strict';
// Drives `grok agent stdio` (Grok Build speaking the Agent Client Protocol over stdin/stdout) so Grok can stop and
// ask before it runs a command or edits a file. We don't advertise file-system or terminal capabilities, so Grok
// uses its own tools and just asks us for permission.
//
// Flow: initialize -> authenticate -> session/new -> session/prompt, with session/update notifications streaming
// in and session/request_permission requests coming from Grok.

const { RpcPeer } = require('./jsonrpc');

const INIT_TIMEOUT_MS = 30000;

function kindOf(toolCall) {
  const k = String((toolCall && toolCall.kind) || '').toLowerCase();
  if (k === 'execute') return 'command';
  if (k === 'edit' || k === 'delete' || k === 'move') return 'files';
  if (k === 'fetch' || k === 'search') return 'web';
  return 'other';
}

function describe(params) {
  const tc = (params && params.toolCall) || {};
  const kind = kindOf(tc);
  const raw = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {};
  let detail = '';
  if (kind === 'command') detail = raw.command || raw.cmd || tc.title || '';
  else if (kind === 'files') detail = raw.path || raw.file_path || raw.filePath || (Array.isArray(tc.locations) && tc.locations.map((l) => l.path).filter(Boolean).join('\n')) || tc.title || '';
  else detail = raw.url || raw.query || tc.title || '';
  if (Array.isArray(detail)) detail = detail.join(' ');
  const titles = { command: 'wants to run a command', files: 'wants to change files', web: 'wants to use the web', other: 'is asking for permission' };
  return { kind, title: titles[kind], detail: String(detail).slice(0, 1500), cwd: raw.cwd ? String(raw.cwd) : '', reason: kind === 'other' && tc.title ? String(tc.title).slice(0, 300) : '' };
}

// Pick the option that matches what the person decided. Falls back to cancelling, which Grok treats as "no".
function outcomeFor(options, allow, forSession) {
  const opts = Array.isArray(options) ? options : [];
  const find = (...kinds) => opts.find((o) => kinds.includes(o.kind));
  const pick = allow ? (forSession && find('allow_always')) || find('allow_once') || find('allow_always') : find('reject_once') || find('reject_always');
  if (pick && pick.optionId != null) return { outcome: { outcome: 'selected', optionId: pick.optionId } };
  return { outcome: { outcome: 'cancelled' } };
}

// opts: { spawn(args)->child, args, cwd, prompt, ask(info)->{decision,forSession}, activity(text), onWaiting(bool),
//         timeoutMs, kill(child), entry, version }
function run(opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = opts.spawn(opts.args || ['agent', 'stdio']);
    } catch (e) {
      return resolve({ stdout: '', stderr: '', error: e, fallback: true });
    }
    let stderr = '';
    let text = '';
    let finished = false;
    let started = false; // session/prompt sent
    let timedOut = false;
    let waiting = 0;
    let timer = null;
    let sessionId = null;
    let peer = null;

    const arm = () => {
      clearTimeout(timer);
      if (!opts.timeoutMs || waiting > 0) return;
      timer = setTimeout(() => {
        timedOut = true;
        if (sessionId && peer) peer.notify('session/cancel', { sessionId });
        done({ code: null });
      }, opts.timeoutMs);
    };
    const done = (extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch (_) {}
      if (opts.kill) opts.kill(child);
      resolve(Object.assign({ stdout: text, stderr, timedOut }, extra));
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      if (stderr.length < 200000) stderr += d;
    });

    peer = new RpcPeer(child, {
      jsonrpc2: true,
      onNotification(msg) {
        arm();
        if (msg.method !== 'session/update') return;
        const u = (msg.params && msg.params.update) || {};
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && typeof u.content.text === 'string') text += u.content.text;
        else if (u.sessionUpdate === 'tool_call' && opts.activity) {
          const k = kindOf(u);
          const t = String(u.title || '').slice(0, 160);
          opts.activity(k === 'command' ? `running: ${t}` : k === 'files' ? `editing: ${t}` : k === 'web' ? `looking up: ${t}` : t || 'working');
        } else if (u.sessionUpdate === 'agent_thought_chunk' && opts.activity) opts.activity('thinking');
      },
      async onRequest(msg) {
        arm();
        if (msg.method !== 'session/request_permission') throw new Error('not supported by AI Huddle: ' + msg.method);
        const info = describe(msg.params);
        waiting++;
        clearTimeout(timer);
        if (opts.onWaiting) opts.onWaiting(true);
        try {
          const ans = await opts.ask(Object.assign({ method: msg.method }, info));
          return outcomeFor(msg.params && msg.params.options, !!(ans && ans.decision === 'allow'), !!(ans && ans.forSession));
        } finally {
          waiting--;
          if (opts.onWaiting) opts.onWaiting(waiting > 0);
          arm();
        }
      },
      onClose(code, err) {
        if (finished) return;
        if (!started) return done({ code, error: err || null, fallback: true });
        if (text) done({ code: 0 });
        else done({ code: code == null ? 1 : code, error: err || null });
      },
    });

    (async () => {
      try {
        const init = await peer.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, INIT_TIMEOUT_MS);
        const methods = ((init && init.authMethods) || []).map((m) => m && m.id).filter(Boolean);
        const method = methods.includes('cached_token') ? 'cached_token' : methods[0];
        if (method) await peer.request('authenticate', { methodId: method }, INIT_TIMEOUT_MS);
        const s = await peer.request('session/new', { cwd: opts.cwd, mcpServers: [] }, INIT_TIMEOUT_MS);
        sessionId = s && (s.sessionId || (s.session && s.session.id));
        if (!sessionId) throw new Error('no session id');
        arm();
        started = true;
        const r = await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: opts.prompt }] }, 0);
        const why = r && r.stopReason;
        if (why === 'cancelled') done({ code: 1, stderr: stderr + '\nit was cancelled' });
        else if (why === 'refusal') done({ code: 1, stderr: stderr + '\nGrok declined to do that' });
        else done({ code: 0 });
      } catch (e) {
        if (finished) return;
        done({ code: 1, error: e, fallback: !started });
      }
    })();

    if (opts.entry)
      opts.entry.stop = () => {
        if (sessionId && peer) peer.notify('session/cancel', { sessionId });
        done({ code: 1, stopped: true });
      };
    arm();
  });
}

module.exports = { run, describe, outcomeFor, kindOf };
