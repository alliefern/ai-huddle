'use strict';
// Drives `codex app-server` so Codex can stop and ask before it runs a command or changes a file,
// instead of failing quietly the way `codex exec` does with nobody there to say yes.
//
// Protocol (line-delimited JSON-RPC): initialize -> initialized -> thread/start -> turn/start, then notifications
// (item/agentMessage/delta, item/started, item/completed, turn/completed) and server requests asking for approval.

const { RpcPeer } = require('./jsonrpc');

const INIT_TIMEOUT_MS = 20000;

// How each Huddle approval level (and the room's access) maps onto Codex's own two dials.
//
// - "untrusted" makes Codex ask before any command it doesn't consider read-only, and before file changes, so the
//   engine sees each one and applies the room's rules (ask, remember for this chat, files-inside-the-folder, or refuse
//   commands in an edit-only room). "on-request" would let Codex run commands and edit inside its sandbox without
//   asking at all, which isn't what "ask me every time" says.
// - Only an edit-and-run room hands the decision to Codex itself: "folder" is its workspace sandbox with no questions,
//   "auto" is no sandbox and no questions.
function policyFor(level, access) {
  if (access === 'run' && level === 'auto') return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  if (access === 'run' && level === 'folder') return { approvalPolicy: 'never', sandbox: 'workspace-write' };
  return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
}

// decision: 'allow' | 'deny'. Newer servers say accept/decline, older ones approved/denied.
// "For this chat" is remembered by AI Huddle (in memory, per room), never by Codex: a session-wide yes inside Codex
// would outlive a level change made while it's still running.
function answerFor(method, decision) {
  const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
  if (legacy) return { decision: decision === 'allow' ? 'approved' : 'denied' };
  return { decision: decision === 'allow' ? 'accept' : 'decline' };
}

// items: itemId -> the item from item/started (file-change requests only name the item, the paths live on it)
function describeRequest(msg, items) {
  const p = msg.params || {};
  const m = msg.method || '';
  const item = (items && p.itemId != null && items.get(p.itemId)) || null;
  if (/commandExecution|execCommand/i.test(m)) {
    const c = p.command != null ? p.command : item && item.command;
    const cmd = Array.isArray(c) ? c.join(' ') : String(c || '');
    const cwd = p.cwd || (item && item.cwd) || '';
    return { kind: 'command', title: 'wants to run a command', detail: cmd.slice(0, 1500), cwd: String(cwd), reason: p.reason ? String(p.reason).slice(0, 500) : '', paths: [] };
  }
  if (/fileChange|applyPatch/i.test(m)) {
    let paths = [];
    if (p.fileChanges && typeof p.fileChanges === 'object') paths = Object.keys(p.fileChanges);
    else if (Array.isArray(p.changes)) paths = p.changes.map((c) => c && c.path).filter(Boolean);
    else if (item && Array.isArray(item.changes)) paths = item.changes.map((c) => c && c.path).filter(Boolean);
    paths = paths.map(String);
    // Asking for write access to a whole folder is never treated as "inside the room's folder": it always asks.
    if (p.grantRoot) paths = [];
    const detail = paths.length ? paths.join('\n') : p.grantRoot ? `write access to ${p.grantRoot}` : '(Codex did not say which files)';
    return { kind: 'files', title: 'wants to change files', detail: detail.slice(0, 1500), cwd: '', reason: p.reason ? String(p.reason).slice(0, 500) : '', paths };
  }
  return { kind: 'other', title: 'is asking for permission', detail: m, cwd: '', reason: '', paths: [] };
}

// opts: {
//   spawn(args) -> child, args: ['app-server'], cwd, prompt, level, access,
//   ask(info) -> Promise<{decision:'allow'|'deny'}>,
//   activity(text), onWaiting(isWaiting), timeoutMs, version, kill(child), entry
// }
// Returns {stdout, stderr, code, timedOut, error, fallback}. fallback=true means "couldn't get a turn going at all,
// nothing ran".
function run(opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = opts.spawn(opts.args || ['app-server']);
    } catch (e) {
      return resolve({ stdout: '', stderr: '', error: e, fallback: true });
    }

    let stderr = '';
    let lastMsg = '';
    let deltas = '';
    let finished = false;
    let started = false; // turn/start sent
    let timedOut = false;
    let waiting = 0;
    let timer = null;
    let thread = null;
    let peer = null;
    const items = new Map();

    // An inactivity clock: any message from Codex resets it, and it's paused while a card waits on you.
    const arm = () => {
      clearTimeout(timer);
      if (!opts.timeoutMs || waiting > 0 || finished) return;
      timer = setTimeout(() => {
        timedOut = true;
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
      resolve(Object.assign({ stdout: lastMsg || deltas, stderr, timedOut }, extra));
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      if (stderr.length < 200000) stderr += d;
    });

    peer = new RpcPeer(child, {
      onNotification(msg) {
        arm();
        const p = msg.params || {};
        const m = msg.method;
        if (m === 'item/agentMessage/delta' && typeof p.delta === 'string') deltas += p.delta;
        else if (m === 'item/started' && p.item) {
          const it = p.item;
          if (it.id != null) {
            items.set(it.id, it);
            if (items.size > 500) items.delete(items.keys().next().value);
          }
          if (it.type === 'commandExecution') opts.activity && opts.activity(`running: ${String(it.command || '').slice(0, 160)}`);
          else if (it.type === 'fileChange') opts.activity && opts.activity('editing files');
          else if (it.type === 'webSearch') opts.activity && opts.activity('searching the web');
          else if (it.type === 'mcpToolCall') opts.activity && opts.activity(`using ${it.server || 'a connector'}${it.tool ? ' / ' + it.tool : ''}`);
          else if (it.type === 'reasoning') opts.activity && opts.activity('thinking');
        } else if (m === 'item/completed' && p.item && p.item.type === 'agentMessage' && typeof p.item.text === 'string') {
          lastMsg = p.item.text;
        } else if (m === 'turn/completed') {
          const t = p.turn || {};
          if (t.status === 'failed') {
            const em = (t.error && (t.error.message || t.error)) || 'the turn failed';
            done({ code: 1, stderr: stderr + '\n' + String(em) });
          } else if (t.status === 'interrupted') done({ code: 1, stderr: stderr + '\nit was interrupted' });
          else done({ code: 0 });
        } else if (m === 'error' && p.error && !p.willRetry) {
          stderr += '\n' + String(p.error.message || p.error);
        }
      },

      async onRequest(msg) {
        const info = describeRequest(msg, items);
        waiting++;
        clearTimeout(timer);
        if (opts.onWaiting) opts.onWaiting(true);
        try {
          const ans = await opts.ask(Object.assign({ method: msg.method }, info));
          return answerFor(msg.method, ans && ans.decision === 'allow' ? 'allow' : 'deny');
        } finally {
          waiting--;
          if (opts.onWaiting) opts.onWaiting(waiting > 0);
          arm();
        }
      },

      onClose(code, err) {
        if (finished) return;
        if (!started) return done({ code, error: err || null, fallback: true });
        // closed mid-turn: if it gave us an answer, that's the answer
        if (lastMsg || deltas) done({ code: 0 });
        else done({ code: code == null ? 1 : code, error: err || null });
      },
    });

    (async () => {
      try {
        await peer.request(
          'initialize',
          { clientInfo: { name: 'ai-huddle', title: 'AI Huddle', version: String(opts.version || '0') } },
          INIT_TIMEOUT_MS
        );
        peer.notify('initialized');
        const pol = policyFor(opts.level, opts.access);
        const t = await peer.request('thread/start', { cwd: opts.cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox }, INIT_TIMEOUT_MS);
        thread = t && (t.thread || t);
        const threadId = thread && (thread.id || thread.threadId);
        if (!threadId) throw new Error('no thread id');
        arm();
        started = true;
        await peer.request('turn/start', { threadId, input: [{ type: 'text', text: opts.prompt }] }, INIT_TIMEOUT_MS);
      } catch (e) {
        if (finished) return;
        // Couldn't get a turn going: hand back to the engine. A JSON-RPC error on turn/start means Codex refused the
        // turn, so nothing ran either. A timeout does NOT count: the turn may have started, so it is not re-run.
        done({ code: 1, error: e, fallback: !started || !!e.rpc });
      }
    })();

    if (opts.entry) opts.entry.stop = () => done({ code: 1, stopped: true });
    arm();
  });
}

module.exports = { run, policyFor, answerFor, describeRequest };
