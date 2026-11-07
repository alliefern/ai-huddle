'use strict';
// A stand-in for `grok agent stdio` (Agent Client Protocol). FAKE_ACP: cmd (default) | edit | quiet | dead
const fs = require('fs');
const mode = process.env.FAKE_ACP || 'cmd';
if (mode === 'dead') {
  console.error('error: unknown subcommand agent');
  process.exit(2);
}
const log = (o) => process.env.FAKE_ACP_LOG && fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(o) + '\n');
const send = (o) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, o)) + '\n');
let nid = 500;
const waiting = new Map();
const ask = (method, params) => new Promise((res) => { const id = nid++; waiting.set(id, res); send({ id, method, params }); });
const options = [
  { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'a2', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
];

async function prompt(id, sid) {
  send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } } });
  const got = [];
  const todo = mode === 'quiet' ? [] : mode === 'edit' ? ['edit'] : ['cmd'];
  for (const t of todo) {
    const toolCall = t === 'edit'
      ? { toolCallId: 'tc2', title: 'Edit logo.svg', kind: 'edit', locations: [{ path: '/work/logo.svg' }] }
      : { toolCallId: 'tc1', title: 'Run npm install sharp', kind: 'execute', rawInput: { command: 'npm install sharp' } };
    send({ method: 'session/update', params: { sessionId: sid, update: Object.assign({ sessionUpdate: 'tool_call', status: 'pending' }, toolCall) } });
    const r = await ask('session/request_permission', { sessionId: sid, toolCall, options });
    got.push((r.outcome && (r.outcome.optionId || r.outcome.outcome)) || '?');
  }
  const text = got.length ? `done. chose: ${got.join(',')}` : 'done. nothing needed approval.';
  send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  send({ id, result: { stopReason: 'end_turn' } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method) log({ method: m.method, params: m.params, v2: m.jsonrpc === '2.0' });
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, authMethods: [{ id: 'xai.api_key' }, { id: 'cached_token' }], agentCapabilities: {} } });
    else if (m.method === 'authenticate') send({ id: m.id, result: {} });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') prompt(m.id, m.params.sessionId);
    else if (m.id != null && waiting.has(m.id)) { const r = waiting.get(m.id); waiting.delete(m.id); r(m.result || {}); }
  }
});
process.stdin.on('end', () => process.exit(0));
