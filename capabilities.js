'use strict';
// What can each agent actually do on THIS computer? This file asks the real CLIs and reports only what it saw.
// It never guesses: anything it can't check comes back as "unknown" or "not tested", with the reason.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Where each CLI keeps its own skills (from the Impeccable docs). Home-relative, so it works for any user.
const SKILL_DIRS = {
  claude: ['.claude', 'skills'],
  codex: ['.agents', 'skills'],
  grok: ['.grok', 'skills'],
};

function skillsDirFor(agentId, home = os.homedir()) {
  const p = SKILL_DIRS[agentId];
  return p ? path.join(home, ...p) : '';
}

function listSkillFolders(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => !n.startsWith('.'))
      .sort();
  } catch (_) {
    return null; // folder doesn't exist or can't be read
  }
}

// Runs a short command and always comes back, with a timeout so a stalled connector can't hang the app.
function runQuick(H, resolved, args, { timeoutMs = 15000, cwd } = {}) {
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
      resolve(Object.assign({ stdout, stderr, timedOut }, extra));
    };
    const shim = H.IS_WIN && /\.(cmd|bat)$/i.test(resolved);
    let child;
    try {
      if (shim) child = spawn([resolved, ...args].map(H.winQuote).join(' '), [], { cwd, shell: true, windowsHide: true, env: process.env });
      else if (H.IS_WIN) child = spawn(resolved, args, { cwd, windowsHide: true, env: process.env });
      else child = spawn(resolved, args, { cwd, env: process.env, detached: true });
    } catch (e) {
      return finish({ error: e });
    }
    timer = setTimeout(() => {
      timedOut = true;
      H.killTree(child);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (stdout.length < 200000) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 200000) stderr += d;
    });
    child.on('error', (e) => finish({ error: e }));
    child.on('close', (code) => finish({ code }));
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

// `<cli> mcp list` prints different shapes per CLI, so this reads each line loosely and keeps the raw text
// so the app can show exactly what the CLI said.
function parseMcpList(text) {
  const servers = [];
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/^(checking|no mcp servers|name\s|[-=─]+$)/i.test(line)) continue;
    const name = (line.match(/^[\w.@/-]+/) || [''])[0];
    if (!name) continue;
    let status = 'unknown';
    if (/✗|fail|error|disconnect|unreachable/i.test(line)) status = 'failed';
    else if (/needs? auth|not logged in|unauthenticated|login required/i.test(line)) status = 'needs-auth';
    else if (/✓|connected|\bready\b/i.test(line)) status = 'connected';
    else if (/disabled/i.test(line)) status = 'off';
    else if (/enabled/i.test(line)) status = 'enabled';
    servers.push({ name, status, line: line.slice(0, 200) });
  }
  return servers;
}

async function probeMcp(H, resolved, args) {
  if (!args || !args.length) return { state: 'unknown', servers: [], note: "I don't know how to list this CLI's connectors.", raw: '' };
  const limit = H.mcpTimeoutMs || 25000;
  const r = await runQuick(H, resolved, args, { timeoutMs: limit });
  const raw = H.stripAnsi(`${r.stdout}\n${r.stderr}`).trim().slice(0, 2500);
  const cmdText = 'mcp list';
  if (r.timedOut) {
    return {
      state: 'stalled',
      servers: [],
      note: `"${cmdText}" didn't finish in ${Math.max(1, Math.round(limit / 1000))} seconds. a connector is probably stuck while starting. try again, or remove the one that hangs from that CLI's own settings.`,
      raw,
    };
  }
  if (r.error) return { state: 'unknown', servers: [], note: `I couldn't run "${cmdText}": ${r.error.message}`, raw };
  if (r.code !== 0) {
    const first = H.stripAnsi(r.stderr || r.stdout || '').split(/\r?\n/).find((l) => l.trim()) || '';
    return { state: 'unknown', servers: [], note: `this CLI didn't understand "${cmdText}" (exit ${r.code}). ${first.slice(0, 160)}`.trim(), raw };
  }
  if (!raw || /no mcp servers/i.test(raw)) return { state: 'none', servers: [], note: 'no connectors set up in this CLI.', raw };
  const servers = parseMcpList(raw);
  return { state: servers.length ? 'ok' : 'unknown', servers, note: servers.length ? '' : "I couldn't read that output. the raw text is below.", raw };
}

async function probeAgent(H, { agentId, agent, sharedSlugs, home }) {
  const out = {
    id: agentId,
    label: agent.label,
    enabled: !!agent.enabled,
    installed: false,
    path: '',
    version: '',
    mcp: null,
    skills: null,
    checkedAt: Date.now(),
  };
  const dir = skillsDirFor(agentId, home);
  const names = dir ? listSkillFolders(dir) : null;
  out.skills = {
    dir,
    known: !!dir,
    exists: names !== null,
    count: names ? names.length : 0,
    names: names ? names.slice(0, 40) : [],
    sharedTotal: sharedSlugs.length,
    sharedHere: names ? sharedSlugs.filter((s) => names.includes(s)).length : 0,
  };
  if (!agent.enabled) return out;

  const resolved = await H.resolveCommand(agent.command);
  if (!resolved) return out;
  out.installed = true;
  out.path = resolved;

  const probe = agent.probe || {};
  if (probe.version && probe.version.length) {
    const v = await runQuick(H, resolved, probe.version, { timeoutMs: 10000 });
    if (!v.error && !v.timedOut && v.code === 0) out.version = H.stripAnsi(v.stdout || v.stderr || '').split(/\r?\n/).find((l) => l.trim()) || '';
    out.version = out.version.trim().slice(0, 80);
  }
  out.mcp = await probeMcp(H, resolved, probe.mcp);
  return out;
}

module.exports = { SKILL_DIRS, skillsDirFor, listSkillFolders, runQuick, parseMcpList, probeMcp, probeAgent };
