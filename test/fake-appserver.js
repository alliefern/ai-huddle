'use strict';
// A stand-in for `codex app-server`. FAKE_APP picks the behaviour:
//   cmd (default): asks to run a command, then reports what you answered
//   file: asks to change a file      legacy: asks with the old-style method names
//   two: asks for a command twice    quiet: asks nothing      dead: exits right away (no app-server in this version)
//   hang: never finishes             midcrash: dies after starting the turn with no answer
const fs = require('fs');
const mode = process.env.FAKE_APP || 'cmd';
if (mode === 'dead') {
  console.error('error: unrecognized subcommand app-server');
  process.exit(2);
}
const log = (o) => {
  if (process.env.FAKE_APP_LOG) fs.appendFileSync(process.env.FAKE_APP_LOG, JSON.stringify(o) + '\n');
};
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    waiting.set(id, res);
    send({ id, method, params });
  });

async function turn(threadId, text) {
  send({ method: 'turn/started', params: { threadId, turn: { id: 't1' } } });
  if (mode === 'hang') return;
  if (mode === 'midcrash') process.exit(3);
  const decisions = [];
  const todo = mode === 'quiet' ? [] : mode === 'two' ? ['cmd', 'cmd'] : [mode === 'file' || mode === 'legacy-file' ? 'file' : 'cmd'];
  for (const t of todo) {
    let r;
    if (mode === 'legacy') r = await ask('execCommandApproval', { conversationId: threadId, command: ['npm', 'install', 'sharp'], cwd: '/work' });
    else if (t === 'file') r = await ask('item/fileChange/requestApproval', { threadId, itemId: 'i2', reason: 'needs to write outside the folder', grantRoot: '/etc' });
    else r = await ask('item/commandExecution/requestApproval', { threadId, itemId: 'i1', command: 'npm install sharp', cwd: '/work', reason: 'install a dependency' });
    decisions.push(r.decision);
    send({ method: 'item/started', params: { threadId, item: { type: 'commandExecution', command: 'npm install sharp' } } });
  }
  send({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'm1', delta: 'partial ' } });
  const reply = decisions.length ? `done. decisions: ${decisions.join(',')}. prompt mentions: ${/Conversation/.test(text) ? 'convo' : 'none'}` : 'done. nothing needed approval.';
  send({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', id: 'm1', text: reply } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: 't1', status: 'completed' } } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method) log({ method: m.method, params: m.params });
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake-codex' } });
    else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'th1' } } });
    else if (m.method === 'turn/start') {
      send({ id: m.id, result: { turn: { id: 't1' } } });
      turn('th1', (m.params.input[0] || {}).text || '');
    } else if (m.id != null && waiting.has(m.id)) {
      const r = waiting.get(m.id);
      waiting.delete(m.id);
      r(m.result || {});
    }
  }
});
process.stdin.on('end', () => process.exit(0));
