'use strict';
// Drives `codex app-server` so Codex can stop and ask before it runs a command or changes a file,
// instead of failing quietly the way `codex exec` does with nobody there to say yes.
//
// Protocol (line-delimited JSON-RPC): initialize -> initialized -> thread/start -> turn/start, then notifications
// (item/agentMessage/delta, item/started, item/completed, turn/completed) and server requests asking for approval.

const { RpcPeer } = require('./jsonrpc');

const INIT_TIMEOUT_MS = 20000;

// How each Huddle approval level maps onto Codex's own two dials.
function policyFor(level) {
  if (level === 'auto') return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  if (level === 'folder') return { approvalPolicy: 'never', sandbox: 'workspace-write' };
  return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }; // ask, chat
}

// decision: 'allow' | 'deny'. Newer servers say accept/decline, older ones approved/denied.
function answerFor(method, decision, forSession) {
  const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
  if (legacy) return { decision: decision === 'allow' ? (forSession ? 'approved_for_session' : 'approved') : 'denied' };
  return { decision: decision === 'allow' ? (forSession ? 'acceptForSession' : 'accept') : 'decline' };
}

function describeRequest(msg) {
  const p = msg.params || {};
  const m = msg.method || '';
  if (/commandExecution|execCommand/i.test(m)) {
    const cmd = Array.isArray(p.command) ? p.command.join(' ') : String(p.command || '');
    return { kind: 'command', title: 'wants to run a command', detail: cmd.slice(0, 1500), cwd: p.cwd ? String(p.cwd) : '', reason: p.reason ? String(p.reason).slice(0, 500) : '' };
  }
  if (/fileChange|applyPatch/i.test(m)) {
    let files = '';
    if (p.fileChanges && typeof p.fileChanges === 'object') files = Object.keys(p.fileChanges).join('\n');
    else if (Array.isArray(p.changes)) files = p.changes.map((c) => c && c.path).filter(Boolean).join('\n');
    if (!files && p.grantRoot) files = `write access to ${p.grantRoot}`;
    return { kind: 'files', title: 'wants to change files', detail: files.slice(0, 1500), cwd: '', reason: p.reason ? String(p.reason).slice(0, 500) : '' };
  }
  return { kind: 'other', title: 'is asking for permission', detail: m, cwd: '', reason: '' };
}

// opts: {
//   spawn(args) -> child, args: ['app-server'], cwd, prompt, level,
//   ask(info) -> Promise<{decision:'allow'|'deny', forSession?:bool}>,
//   activity(text), onWaiting(isWaiting), timeoutMs, version
// }
// Returns {stdout, stderr, code, timedOut, error, fallback}. fallback=true means "couldn't talk to app-server at all".
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
    let started = false; // turn/start accepted
    let timedOut = false;
    let waiting = 0;
    let timer = null;
    let thread = null;
    let peer = null;

    const arm = () => {
      clearTimeout(timer);
      if (!opts.timeoutMs || waiting > 0) return;
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
        arm();
        const info = describeRequest(msg);
        waiting++;
        clearTimeout(timer);
        if (opts.onWaiting) opts.onWaiting(true);
        try {
          const ans = await opts.ask(Object.assign({ method: msg.method }, info));
          return answerFor(msg.method, ans && ans.decision === 'allow' ? 'allow' : 'deny', !!(ans && ans.forSession));
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
        const pol = policyFor(opts.level);
        const t = await peer.request('thread/start', { cwd: opts.cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox }, INIT_TIMEOUT_MS);
        thread = t && (t.thread || t);
        const threadId = thread && (thread.id || thread.threadId);
        if (!threadId) throw new Error('no thread id');
        arm();
        started = true;
        await peer.request('turn/start', { threadId, input: [{ type: 'text', text: opts.prompt }] }, INIT_TIMEOUT_MS);
      } catch (e) {
        if (finished) return;
        // Couldn't get a turn going: hand back to the normal launcher (nothing has run yet).
        done({ code: 1, error: e, fallback: !started });
      }
    })();

    if (opts.entry) opts.entry.stop = () => done({ code: 1, stopped: true });
    arm();
  });
}

module.exports = { run, policyFor, answerFor, describeRequest };
