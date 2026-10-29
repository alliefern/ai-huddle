'use strict';
// Run with: npm test   (uses fake agents, burns zero real usage)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine, stripAnsi, winQuote, resolveCommand } = require('../engine');

const FAKE = path.join(__dirname, 'fake-agent.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let passes = 0;

function check(name, cond, extra) {
  if (cond) {
    passes++;
    console.log('  PASS', name);
  } else {
    failures++;
    console.log('  FAIL', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '');
  }
}

function fakeConfig(extra = {}) {
  const agents = {};
  for (const id of ['claude', 'codex', 'grok']) {
    agents[id] = { command: process.execPath, args: [FAKE, id], input: 'stdin', enabled: true };
  }
  return { agents, settings: { timeoutSec: 20, maxAutoRuns: 6, autoHandoff: true, ...extra } };
}

function mk(extra, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-test-'));
  const cfg = fakeConfig(extra);
  if (mutate) mutate(cfg);
  const e = new Engine(dir, { config: cfg });
  e.dir = dir;
  e.maxRunning = 0;
  e.on('status', (s) => {
    const n = Object.values(s.running).reduce((a, l) => a + l.length, 0);
    e.maxRunning = Math.max(e.maxRunning, n);
  });
  return e;
}

const idleNow = (e) => e.running.size === 0 && Object.values(e.queues).every((q) => !q.length);
async function idle(e, timeout = 15000) {
  const t0 = Date.now();
  await sleep(60);
  for (;;) {
    if (idleNow(e)) {
      await sleep(80);
      if (idleNow(e)) return;
    }
    if (Date.now() - t0 > timeout) throw new Error('engine never went idle');
    await sleep(25);
  }
}

const R = (e) => e.rooms[0].id;
const tr = (e, rid) => e._room(rid || R(e)).transcript;
const agentMsgs = (e, rid) => tr(e, rid).filter((m) => m.from !== 'you' && m.from !== 'system');
const sysMsgs = (e, rid) => tr(e, rid).filter((m) => m.from === 'system');
const order = (e, rid) => agentMsgs(e, rid).map((m) => m.from).join(',');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
};

(async () => {
  console.log('basic routing');
  {
    const e = mk();
    const r = R(e);
    check('starts with one room called general', e.rooms.length === 1 && e.rooms[0].name === 'general');
    e.send(r, '@claude hello there');
    await idle(e);
    check('only claude replied', order(e) === 'claude', order(e));
    check('reply came back', /claude: got \d+ chars; last from You: @claude hello there/.test(agentMsgs(e)[0].text), agentMsgs(e)[0] && agentMsgs(e)[0].text);
    check('messages carry their room', tr(e).every((m) => m.room === r));

    e.send(r, 'no mention this time');
    await idle(e);
    check('no mention goes to last responder', order(e) === 'claude,claude', order(e));

    e.send(r, '@codex you now');
    await idle(e);
    e.send(r, 'and again without a tag');
    await idle(e);
    check('last responder updates', order(e) === 'claude,claude,codex,codex', order(e));
  }

  console.log('prompt shape');
  {
    const e = mk();
    e.updateRoom(R(e), { name: 'kablock', topic: 'Naming and launch plan for Kablock' });
    e.send(R(e), '@grok first');
    await idle(e);
    const p = e._buildPrompt(e.rooms[0], 'codex');
    check('prompt names the agent and the room', p.includes('You are Codex (@codex)') && p.includes('"kablock"'));
    check('prompt carries the room topic', p.includes('What this room is for: Naming and launch plan for Kablock'));
    check('prompt lists the others', p.includes('Claude (@claude)') && p.includes('Grok (@grok)'));
    check('prompt includes transcript', p.includes('[You] @grok first') && p.includes('[Grok] grok:'));
    check('system notes stay out of prompt', !p.includes('[Huddle]'));
    const e2 = mk();
    check('no topic line when there is no topic', !e2._buildPrompt(e2.rooms[0], 'claude').includes('What this room is for'));
  }

  console.log('@all runs in parallel');
  {
    const e = mk();
    e.send(R(e), '@all SLOW hi');
    await idle(e);
    check('all three replied', ['claude', 'codex', 'grok'].every((id) => agentMsgs(e).some((m) => m.from === id)), order(e));
    check('they ran at the same time', e.maxRunning === 3, e.maxRunning);
  }

  console.log('chain hand-off');
  {
    const e = mk();
    e.send(R(e), '@claude CHAIN please');
    await idle(e);
    check('claude → codex → grok', order(e) === 'claude,codex,grok', order(e));
    check('no handoff chips left over', agentMsgs(e).every((m) => !m.handoffs));
  }

  console.log('loop guard');
  {
    const e = mk({ maxAutoRuns: 4 });
    e.send(R(e), '@claude PINGPONG');
    await idle(e);
    check('1 + maxAutoRuns replies then stops', agentMsgs(e).length === 5, order(e));
    const last = agentMsgs(e).pop();
    check('last message keeps a tag so you can continue', last.handoffs && last.handoffs.length === 1, last);
    check('pause note posted', sysMsgs(e).some((m) => /Paused after 4/.test(m.text)));

    const before = agentMsgs(e).length;
    e.relay(R(e), last.handoffs[0], last.id);
    await idle(e);
    check('relay continues the thread', agentMsgs(e).length > before, agentMsgs(e).length);
    check('relay removed the clicked chip', !last.handoffs.length);
  }

  console.log('no-cap mode');
  {
    const e = mk({ capHandoffs: false, maxAutoRuns: 2 });
    e.send(R(e), '@claude CHAIN go');
    await idle(e);
    check('with no cap the chain runs past maxAutoRuns', order(e) === 'claude,codex,grok', order(e));

    const e2 = mk({ capHandoffs: false });
    e2.send(R(e2), '@claude PINGPONG');
    await sleep(1500);
    check('with no cap, ping-pong keeps going well past 6', agentMsgs(e2).length > 8, agentMsgs(e2).length);
    e2.stop(R(e2));
    await idle(e2, 8000);
    check('and Stop ends it', !sysMsgs(e2).some((m) => /safety ceiling/.test(m.text)) && e2.running.size === 0);
    const n = agentMsgs(e2).length;
    await sleep(400);
    check('nothing keeps running after Stop', agentMsgs(e2).length === n);

    const e3 = mk({ capHandoffs: true, maxAutoRuns: 3 });
    e3.send(R(e3), '@claude PINGPONG');
    await idle(e3);
    check('cap mode still caps (1 + 3)', agentMsgs(e3).length === 4 && sysMsgs(e3).some((m) => /Paused after 3/.test(m.text)));
    e3.updateConfig({ settings: { capHandoffs: false } });
    check('the setting saves as a boolean', e3.config.settings.capHandoffs === false);
  }

  console.log('export');
  {
    const e = mk({});
    e.send(R(e), '@claude hello');
    await idle(e);
    const md = e.exportMarkdown(R(e));
    check('export has a handoff note and every speaker', /Exported from AI Huddle/.test(md) && /\*\*Claude\*\*/.test(md) && /\*\*You\*\*/.test(md), md.slice(0, 200));
  }

  console.log('auto hand-off off');
  {
    const e = mk({ autoHandoff: false });
    e.send(R(e), '@claude CHAIN go');
    await idle(e);
    check('only claude ran', order(e) === 'claude', order(e));
    const m = agentMsgs(e)[0];
    check('tag offered instead', m.handoffs && m.handoffs[0] === 'codex', m.handoffs);
    check('no pause note when it is simply off', sysMsgs(e).length === 0, sysMsgs(e));
    e.relay(R(e), 'codex', m.id);
    await idle(e);
    check('manual relay ran codex', order(e) === 'claude,codex', order(e));
  }

  console.log('mention edge cases');
  {
    const e = mk();
    e.send(R(e), '@claude SELF');
    await idle(e);
    check('self-mention and agent @all are ignored', order(e) === 'claude', order(e));

    const e2 = mk();
    e2.send(R(e2), '@claude FENCE');
    await idle(e2);
    check('mentions inside code are ignored', order(e2) === 'claude', order(e2));

    const e3 = mk();
    e3.send(R(e3), 'hey @claudette and me@claude.com');
    await idle(e3);
    check('look-alikes do not route, falls back to first agent', order(e3) === 'claude', order(e3));
  }

  console.log('stop button');
  {
    const e = mk();
    const pidfile = path.join(e.dir, 'pid');
    process.env.FAKE_PIDFILE = pidfile;
    e.send(R(e), '@claude SLEEP now');
    await sleep(700);
    check('claude is running', e.running.size === 1);
    const pid = Number(fs.readFileSync(pidfile + '.claude', 'utf8'));
    e.stop(R(e));
    await idle(e, 8000);
    check('process was killed', !alive(pid));
    check('no agent message posted after stop', agentMsgs(e).length === 0, order(e));
    check('stopped note posted', sysMsgs(e).some((m) => /Stopped/.test(m.text)));

    e.send(R(e), '@codex still alive?');
    await idle(e);
    check('works again after stop', order(e) === 'codex', order(e));
    delete process.env.FAKE_PIDFILE;
  }

  console.log('failures are shown, not swallowed');
  {
    const e = mk({}, (cfg) => (cfg.agents.codex.command = 'definitely-not-a-real-cli-xyz'));
    e.send(R(e), '@codex hi');
    await idle(e);
    check('missing CLI explained', sysMsgs(e).some((m) => m.kind === 'error' && /Couldn't start/.test(m.text)), sysMsgs(e));

    const e2 = mk();
    e2.send(R(e2), '@grok BADEXIT');
    await idle(e2);
    check('non-zero exit surfaced with stderr', sysMsgs(e2).some((m) => /code 2/.test(m.text) && /boom/.test(m.text)), sysMsgs(e2));

    const eN = mk();
    eN.send(R(eN), '@codex BADNOISE');
    await idle(eN);
    check('MCP noise is filtered so the real error shows', sysMsgs(eN).some((m) => /code 1/.test(m.text) && /not logged in/.test(m.text) && !/rmcp|Transport channel/.test(m.text)), sysMsgs(eN));

    const e3 = mk();
    e3.send(R(e3), '@grok EMPTY');
    await idle(e3);
    check('empty reply surfaced', sysMsgs(e3).some((m) => /came back empty/.test(m.text)), sysMsgs(e3));

    const e4 = mk({ timeoutSec: 1 });
    e4.send(R(e4), '@claude SLEEP');
    await idle(e4, 10000);
    check('timeout kills and reports', sysMsgs(e4).some((m) => /longer than 1s/.test(m.text)), sysMsgs(e4));
  }

  console.log('how the prompt reaches the CLI');
  {
    const e = mk({}, (cfg) => {
      cfg.agents.codex.args = [FAKE, 'codex', '{promptFile}'];
      cfg.agents.codex.input = 'file';
    });
    e.send(R(e), '@codex file mode');
    await idle(e);
    check('file mode: codex read the prompt from a temp file', order(e) === 'codex' && /last from You: @codex file mode/.test(agentMsgs(e)[0].text), agentMsgs(e));
    check('temp prompt file cleaned up', !fs.readdirSync(os.tmpdir()).some((f) => f.startsWith(`huddle-${process.pid}-codex-`)));

    const e2 = mk({}, (cfg) => {
      cfg.agents.grok.args = [FAKE, 'grok', '{prompt}'];
      cfg.agents.grok.input = 'arg';
    });
    e2.send(R(e2), '@grok arg mode');
    await idle(e2);
    check('arg mode: prompt passed as an argument', order(e2) === 'grok' && /last from You: @grok arg mode/.test(agentMsgs(e2)[0].text), agentMsgs(e2));

    const e3 = mk({ contextChars: 100000, contextMessages: 200 }, (cfg) => {
      cfg.agents.grok.args = [FAKE, 'grok', '{prompt}'];
      cfg.agents.grok.input = 'arg';
    });
    for (let i = 0; i < 30; i++) e3._post(e3.rooms[0], { from: 'you', text: 'filler ' + i + ' ' + 'x'.repeat(2000) });
    e3.send(R(e3), '@grok big');
    await idle(e3);
    const n = Number((agentMsgs(e3)[0].text.match(/got (\d+) chars/) || [])[1]);
    check('arg mode caps the prompt length', n > 1000 && n < 17500, n);
  }

  console.log('finding a CLI that is not on PATH');
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-home-'));
    fs.mkdirSync(path.join(home, '.grok', 'bin'), { recursive: true });
    const fakeGrok = path.join(home, '.grok', 'bin', 'grok');
    fs.writeFileSync(fakeGrok, '#!/bin/sh\ncat >/dev/null\necho "grok found in its install folder"\n');
    fs.chmodSync(fakeGrok, 0o755);
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const p = await resolveCommand('grok');
    check('resolveCommand finds ~/.grok/bin/grok', p === fakeGrok, p);
    check('resolveCommand returns null for nonsense', (await resolveCommand('definitely-not-a-real-cli-xyz')) === null);

    const e = mk({}, (cfg) => {
      cfg.agents.grok.command = 'grok';
      cfg.agents.grok.args = ['-p'];
      cfg.agents.grok.input = 'stdin';
    });
    const found = await e.checkAgents();
    check('Check my CLIs reports the fallback path', found.grok.found && found.grok.path === fakeGrok, found.grok);
    e.send(R(e), '@grok hi');
    await idle(e);
    check('a run works through the fallback', /found in its install folder/.test((agentMsgs(e)[0] || {}).text || ''), agentMsgs(e));
    const typed = await e.checkAgents({ grok: 'nonsense-typed-cmd' });
    check('Check can test what is typed before saving', typed.grok.found === false);
    process.env.HOME = oldHome;
  }

  console.log('rooms');
  {
    const e = mk();
    const a = R(e);
    const b = e.createRoom({ name: '#Carousels ', topic: 'Instagram carousel ideas', agents: ['claude', 'codex'] }).id;
    check('room created, # stripped from the name', e._room(b).name === 'Carousels');

    e.send(a, '@claude hello from general');
    e.send(b, '@claude hello from carousels');
    await idle(e);
    check('chats are separate', tr(e, a).filter((m) => m.from === 'you').length === 1 && tr(e, b).filter((m) => m.from === 'you').length === 1);
    check('replies land in their own room', agentMsgs(e, a).length === 1 && agentMsgs(e, b).length === 1);
    check('each prompt only sees its own room', !/from general/.test(e._buildPrompt(e._room(b), 'claude')) && !/from carousels/.test(e._buildPrompt(e._room(a), 'claude')));
    check('prompt for room b names it', e._buildPrompt(e._room(b), 'claude').includes('"Carousels"'));

    e.send(b, '@grok are you here?');
    await idle(e);
    check('tagging someone who is not in the room explains why', sysMsgs(e, b).some((m) => /Grok isn't in Carousels/.test(m.text)), sysMsgs(e, b));
    check('and nobody runs', agentMsgs(e, b).length === 1, order(e, b));

    e.send(b, '@all SLOW hi');
    await idle(e);
    check('@all only reaches members', order(e, b).split(',').slice(1).sort().join() === 'claude,codex', order(e, b));

    e.updateRoom(b, { agents: ['codex'], name: 'carousel-ideas' });
    check('members and name can be edited', e._room(b).agents.join() === 'codex' && e._room(b).name === 'carousel-ideas');
    e.send(b, 'no tag now');
    await idle(e);
    check('with one member, untagged messages go to them', agentMsgs(e, b).pop().from === 'codex');

    check('cannot delete the last room', (() => { const x = mk(); return x.deleteRoom(R(x)) === false && x.rooms.length === 1; })());
    check('rooms can be deleted', e.deleteRoom(b) === true && e.rooms.length === 1 && !e._room(b));
  }

  console.log('rooms: stop and delete are per room');
  {
    const e = mk();
    const a = R(e);
    const b = e.createRoom({ name: 'other' }).id;
    process.env.FAKE_PIDFILE = path.join(e.dir, 'pid');
    e.send(a, '@claude SLEEP');
    await sleep(500);
    const pidA = Number(fs.readFileSync(process.env.FAKE_PIDFILE + '.claude', 'utf8'));
    e.send(b, '@codex SLOW quick one');
    e.stop(a);
    await idle(e, 8000);
    check('stopping room A killed A', !alive(pidA));
    check('room B still got its reply', order(e, b) === 'codex', order(e, b));
    check('A has the stopped note, B does not', sysMsgs(e, a).some((m) => /Stopped/.test(m.text)) && !sysMsgs(e, b).some((m) => /Stopped/.test(m.text)));

    e.send(a, '@claude SLEEP again');
    await sleep(500);
    const pid2 = Number(fs.readFileSync(process.env.FAKE_PIDFILE + '.claude', 'utf8'));
    e.deleteRoom(a);
    await idle(e, 8000);
    check('deleting a room kills what it was running', !alive(pid2));
    delete process.env.FAKE_PIDFILE;
  }

  console.log('rooms: archive');
  {
    const e = mk();
    const a = R(e);
    e.updateRoom(a, { archived: true });
    check('cannot archive the only active room', e.rooms[0].archived === false);
    const b = e.createRoom({ name: 'second' }).id;
    process.env.FAKE_PIDFILE = path.join(e.dir, 'pid');
    e.send(a, '@claude SLEEP');
    await sleep(500);
    const pid = Number(fs.readFileSync(process.env.FAKE_PIDFILE + '.claude', 'utf8'));
    e.updateRoom(a, { archived: true });
    await idle(e, 8000);
    check('archiving works and stops anything running in it', e._room(a).archived === true && !alive(pid));
    check('summary carries the flag', e.getState().rooms.find((r) => r.id === a).archived === true);
    check('archived room keeps its history', e._room(a).transcript.length >= 1);
    check('cannot archive the last remaining active room', (e.updateRoom(b, { archived: true }), e._room(b).archived === false));
    check('cannot delete the last active room even with archived ones around', e.deleteRoom(b) === false);
    check('an archived room can be deleted', e.deleteRoom(a) === true && e.rooms.length === 1);
    const c = e.createRoom({ name: 'third' }).id;
    e.updateRoom(c, { archived: true });
    e.send(c, '@claude hello again');
    await idle(e);
    check('sending into an archived room brings it back', e._room(c).archived === false && order(e, c) === 'claude');
    e.updateRoom(c, { archived: true });
    e.updateRoom(c, { archived: false });
    check('unarchive works', e._room(c).archived === false);
    e.updateRoom(c, { archived: true });
    e.flush();
    const e2 = new Engine(e.dir);
    check('archived state survives a restart', e2._room(c).archived === true);
    delete process.env.FAKE_PIDFILE;
  }

  console.log('rooms: working folder');
  {
    const e = mk();
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-proj-'));
    const b = e.createRoom({ name: 'proj', workDir: folder }).id;
    e.send(b, '@claude WHERE');
    e.send(R(e), '@codex WHERE');
    await idle(e);
    check('room folder is used', fs.realpathSync(agentMsgs(e, b)[0].text.replace('cwd=', '')) === fs.realpathSync(folder), agentMsgs(e, b)[0]);
    check('other rooms use the default workspace', agentMsgs(e)[0].text.includes('workspace'), agentMsgs(e)[0]);
  }

  console.log('disabled agent, settings, persistence');
  {
    const e = mk({}, (cfg) => (cfg.agents.grok.enabled = false));
    e.send(R(e), '@all hello');
    await idle(e);
    check('@all skips disabled agents', order(e).split(',').sort().join() === 'claude,codex', order(e));

    const e2 = mk({}, (cfg) => ['claude', 'codex', 'grok'].forEach((i) => (cfg.agents[i].enabled = false)));
    e2.send(R(e2), 'anyone?');
    await idle(e2);
    check('all off gives a clear message', sysMsgs(e2).some((m) => /Nobody in general is switched on/.test(m.text)));

    const e3 = mk();
    e3.updateConfig({ settings: { maxAutoRuns: 9999, timeoutSec: -5, contextMessages: 'abc', userName: '  ' } });
    const S = e3.config.settings;
    check('settings are clamped and sanitised', S.maxAutoRuns === 30 && S.timeoutSec === 10 && S.contextMessages === 40 && S.userName === 'You', S);
    e3.updateConfig({ agents: { nope: { command: 'x' }, claude: { args: ['-p', '--model', 'x'], input: 'weird' }, grok: { input: 'arg' } } });
    check('unknown agents ignored, bad input mode ignored, arg accepted', !e3.config.agents.nope && e3.config.agents.claude.input === 'stdin' && e3.config.agents.claude.args.length === 3 && e3.config.agents.grok.input === 'arg');

    const e4 = mk();
    const b = e4.createRoom({ name: 'second', topic: 'hello topic' }).id;
    e4.send(R(e4), '@claude remember me');
    e4.send(b, '@codex me too');
    await idle(e4);
    e4.flush();
    const e5 = new Engine(e4.dir);
    check('rooms survive a restart', e5.rooms.length === 2 && e5.rooms[1].name === 'second' && e5.rooms[1].topic === 'hello topic');
    check('history survives a restart', e5.rooms[0].transcript.length === e4.rooms[0].transcript.length && e5.lastResponder.get(e5.rooms[0].id) === 'claude');
    check('ids keep counting up after a restart', e5.nextMsgId > Math.max(...e5.rooms.flatMap((r) => r.transcript.map((m) => m.id))));
    check('settings survive a restart', e5.config.settings.timeoutSec === 20);
    const md = e5.exportMarkdown(e5.rooms[1].id);
    check('markdown export is per room', /^# second/m.test(md) && /hello topic/.test(md) && /\*\*You\*\*/.test(md) && !/remember me/.test(md));
    e5.clear(e5.rooms[0].id);
    check('clear empties only that room', e5.rooms[0].transcript.length === 0 && e5.rooms[1].transcript.length > 0);
  }

  console.log('upgrading an older save file');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-old-'));
    fs.writeFileSync(
      path.join(dir, 'huddle.json'),
      JSON.stringify({
        version: 1,
        config: {
          settings: { userName: 'Allie' },
          agents: { grok: { command: 'grok', args: ['--prompt-file', '{promptFile}'], input: 'file', enabled: true } },
        },
        transcript: [
          { id: 1, ts: 1, from: 'you', text: 'old hello' },
          { id: 2, ts: 2, from: 'claude', text: 'old reply' },
        ],
      })
    );
    const e = new Engine(dir);
    check('old single chat becomes #general', e.rooms.length === 1 && e.rooms[0].name === 'general' && e.rooms[0].transcript.length === 2);
    check('old messages are tagged with the room', e.rooms[0].transcript.every((m) => m.room === e.rooms[0].id));
    check('new messages continue the numbering', e.nextMsgId === 3);
    check('kept her name setting', e.config.settings.userName === 'Allie');
    check('old guessed grok flag is replaced with the documented one', e.config.agents.grok.input === 'arg' && e.config.agents.grok.args.join(' ') === '--no-auto-update -p {prompt}', e.config.agents.grok);
    check('old codex default gains --skip-git-repo-check', e.config.agents.codex.args.join(' ') === 'exec --skip-git-repo-check -', e.config.agents.codex.args);
    check('last responder restored', e.lastResponder.get(e.rooms[0].id) === 'claude');

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-old2-'));
    fs.writeFileSync(path.join(dir2, 'huddle.json'), JSON.stringify({ version: 1, config: { agents: { grok: { args: ['--my-own'], input: 'file' } } }, transcript: [] }));
    const e2 = new Engine(dir2);
    check('a grok setup she customised is left alone', e2.config.agents.grok.args.join() === '--my-own' && e2.config.agents.grok.input === 'file');
  }

  console.log('shared skills');
  {
    const e = mk();
    const mkSkill = (root, slug, desc, body) => {
      fs.mkdirSync(path.join(root, slug), { recursive: true });
      fs.writeFileSync(path.join(root, slug, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${desc}\n---\n${body}\n`);
    };
    mkSkill(e.skills.dir, 'brand-voice', 'Write in Allie\'s voice', 'RULE ONE: sound like a human, with jokes.');
    mkSkill(e.skills.dir, 'carousel', 'Lay out carousels', 'CAROUSEL BODY HERE');
    const L = e.listSkills();
    check('skills are listed with their descriptions', L.skills.length === 2 && L.skills[0].description === "Write in Allie's voice", L.skills);

    e.send(R(e), '/brand-voice write me a tagline');
    await idle(e);
    for (const id of ['claude', 'codex', 'grok']) {
      const p = e._buildPrompt(e.rooms[0], id);
      check(`${id} sees the invoked skill`, p.includes('=== SKILL: /brand-voice') && p.includes('RULE ONE: sound like a human'));
    }
    const p0 = e._buildPrompt(e.rooms[0], 'claude');
    check('skill index lists every skill', p0.includes('- /brand-voice: ') && p0.includes('- /carousel: Lay out carousels'));
    check('skills that were not called are not inlined', !p0.includes('CAROUSEL BODY HERE'));

    e.send(R(e), 'now something else, no skill');
    await idle(e);
    check('skill drops out when the next message does not call it', !e._buildPrompt(e.rooms[0], 'codex').includes('RULE ONE'));

    e.send(R(e), 'look at /usr/bin and `/carousel` and ```\n/carousel\n```');
    await idle(e);
    check('paths and slashes in code are not skills', !e._buildPrompt(e.rooms[0], 'claude').includes('CAROUSEL BODY HERE'));

    e.updateRoom(R(e), { skills: ['carousel'] });
    check('pinned skills are always included', e._buildPrompt(e.rooms[0], 'grok').includes('CAROUSEL BODY HERE'));
    check('room summary carries pins', e.getState().rooms[0].skills.join() === 'carousel');

    e.send(R(e), '/BRAND-VOICE and /carousel');
    await idle(e);
    const both = e._buildPrompt(e.rooms[0], 'claude');
    check('case-insensitive, pinned + called both included once', both.includes('RULE ONE') && both.split('=== SKILL: /carousel').length === 2);

    // size budget in arg mode
    mkSkill(e.skills.dir, 'huge', 'big one', 'X'.repeat(60000));
    e.send(R(e), '/huge go');
    await idle(e);
    const capped = e._buildPrompt(e.rooms[0], 'claude', 16000);
    check('a giant skill is truncated so arg mode still fits', capped.length < 16500 && capped.includes('[skill truncated'), capped.length);
    e.skills.remove('huge');

    // import
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-skillsrc-'));
    mkSkill(src, 'alpha', 'A', 'alpha body');
    mkSkill(src, 'beta', 'B', 'beta body');
    fs.mkdirSync(path.join(src, 'not-a-skill'));
    fs.writeFileSync(path.join(src, 'alpha', 'extra.txt'), 'helper file');
    const r1 = e.importSkills([src]);
    check('import copies every skill folder in a folder', r1.added.sort().join() === 'alpha,beta' && fs.existsSync(path.join(e.skills.dir, 'alpha', 'extra.txt')), r1);
    const r2 = e.importSkills([path.join(src, 'alpha')]);
    check('importing one skill folder directly works, and re-import updates', r2.updated.join() === 'alpha', r2);
    const r3 = e.importSkills([fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-empty-'))]);
    check('importing a folder with no skills says so', r3.failed.length === 1 && /no SKILL.md/.test(r3.failed[0]), r3);

    const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-zip-'));
    const have = require('child_process').spawnSync('zip', ['-qr', path.join(zipDir, 'gamma.skill'), 'gamma'], { cwd: (() => { mkSkill(zipDir, 'gamma', 'G', 'gamma body'); return zipDir; })() });
    if (!have.error && have.status === 0) {
      const r4 = e.importSkills([path.join(zipDir, 'gamma.skill')]);
      check('a .skill / .zip file imports', r4.added.join() === 'gamma' && e.skills.read('gamma').body === 'gamma body', r4);
    } else console.log('  skip  zip import (no zip tool in this sandbox)');

    e.updateRoom(R(e), { skills: ['alpha', 'carousel'] });
    check('removing a skill removes it from the library', e.removeSkill('alpha') === true && !e.skills.find('alpha'));
    check('and unpins it from rooms', e.rooms[0].skills.join() === 'carousel');
    e.skills.remove('beta');
  }

  console.log('attachments');
  {
    const e = mk();
    const r = R(e);
    const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
    const m = e.send(r, 'look at this', [{ name: 'cat.png', data: new Uint8Array(png), mime: 'image/png' }]);
    await idle(e);
    const wd = e.workDir(r);
    check('file saved in the room folder under huddle-files', fs.readFileSync(path.join(wd, 'huddle-files', 'cat.png')).equals(png));
    check('message carries the attachment', m.attachments && m.attachments[0].kind === 'image' && m.attachments[0].name === 'cat.png' && m.attachments[0].size === png.length, m.attachments);
    check('prompt tells agents where it is', e._buildPrompt(e.rooms[0], 'codex').includes('[Attached image: huddle-files/cat.png'));

    e.send(r, 'again', [{ name: 'cat.png', data: png, mime: 'image/png' }]);
    await idle(e);
    check('same name gets a new name instead of overwriting', fs.existsSync(path.join(wd, 'huddle-files', 'cat-2.png')));

    const evil = e.send(r, '', [{ name: '../../evil.txt', data: Buffer.from('x') }]);
    await idle(e);
    check('a sneaky file name cannot escape the folder, and a file alone is a valid message', evil && fs.existsSync(path.join(wd, 'huddle-files', 'evil.txt')) && !fs.existsSync(path.join(wd, '..', 'evil.txt')) && evil.text === '');
    check('empty message with no files is ignored', e.send(r, '  ', []) === null);
    check('prompt shows (no text) for file-only messages', e._buildPrompt(e.rooms[0], 'claude').includes('(no text)\n[Attached file: huddle-files/evil.txt'));

    e.send(r, 'too big', [{ name: 'huge.bin', data: Buffer.alloc(26 * 1024 * 1024) }]);
    await idle(e);
    check('files over 25 MB are refused with a note', sysMsgs(e).some((x) => /huge.bin is over 25 MB/.test(x.text)) && !fs.existsSync(path.join(wd, 'huddle-files', 'huge.bin')));

    check('image data URLs only for files Huddle knows', (e.fileDataUrl(path.join(wd, 'huddle-files', 'cat.png')) || '').startsWith('data:image/png;base64,') && e.fileDataUrl(__filename) === null);

    // agent -> you
    fs.writeFileSync(path.join(wd, '..', 'outside.txt'), 'secret');
    e.send(r, '@claude SENDFILE please');
    await idle(e);
    const reply = agentMsgs(e).pop();
    const names = (reply.attachments || []).map((a) => a.name).sort().join();
    check('agent sent a file two ways: fenced text and a file it made', names === 'made.txt,notes.md', reply);
    check('fenced file content saved', fs.readFileSync(path.join(wd, 'huddle-files', 'notes.md'), 'utf8') === '# Notes\nhi');
    check('file markers and fences are stripped from the text', !/```|\[\[file/.test(reply.text) && /here you go/.test(reply.text));
    check('a file outside the room folder is refused, not attached', /outside this room's folder/.test(reply.text) && !names.includes('outside'));
    check('a missing file is reported', /nope.txt: file not found/.test(reply.text));
    check('agent files are openable from the UI', e.isKnownFile(reply.attachments[0].path));

    e.flush();
    const e2 = new Engine(e.dir);
    check('attachments survive a restart and stay openable', e2.isKnownFile(path.join(wd, 'huddle-files', 'cat.png')) && e2.rooms[0].transcript.some((x) => x.attachments));
    check('export lists attachments', /Attachment: cat.png/.test(e2.exportMarkdown(e2.rooms[0].id)));
  }

  console.log('context trimming');
  {
    const e = mk({ contextMessages: 5, contextChars: 2000 });
    for (let i = 0; i < 12; i++) e._post(e.rooms[0], { from: 'you', text: 'filler ' + i + ' ' + 'x'.repeat(300) });
    const p = e._buildPrompt(e.rooms[0], 'claude');
    check('prompt stays within the cap', p.split('--- Conversation so far ---')[1].length < 3000, p.length);
    check('newest message kept', p.includes('filler 11'));
    check('oldest dropped', !p.includes('filler 0 '));
  }

  console.log('helpers');
  check('stripAnsi', stripAnsi('\u001b[31mred\u001b[0m ok') === 'red ok');
  check('winQuote plain', winQuote('exec') === 'exec');
  check('winQuote spaces', winQuote('C:\\Users\\A B\\p.txt') === '"C:\\Users\\A B\\p.txt"');
  check('winQuote empty', winQuote('') === '""');

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH', e);
  process.exit(2);
});
