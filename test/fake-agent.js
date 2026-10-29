'use strict';
// A stand-in for claude / codex / grok so the engine can be tested without burning real usage.
// usage: node fake-agent.js <id> [promptFile | - | literal prompt text]
const fs = require('fs');

const argv = process.argv.slice(2);
const id = argv.find((a) => ['claude', 'codex', 'grok'].includes(a)) || 'claude';
const rest = argv.filter((a) => a !== id && !a.startsWith('--'));
const src = rest[rest.length - 1];

if (process.env.FAKE_PIDFILE) {
  try {
    fs.writeFileSync(process.env.FAKE_PIDFILE + '.' + id, String(process.pid));
  } catch (_) {}
}

let prompt;
if (src && src !== '-') prompt = fs.existsSync(src) && fs.statSync(src).isFile() ? fs.readFileSync(src, 'utf8') : src;
else prompt = fs.readFileSync(0, 'utf8');

const startI = prompt.lastIndexOf('--- Conversation so far ---');
const afterStart = startI < 0 ? '' : prompt.slice(startI + '--- Conversation so far ---'.length);
const endI = afterStart.lastIndexOf('--- End of conversation ---');
const body = endI < 0 ? afterStart : afterStart.slice(0, endI);
const msgs = [];
const re = /^\[([^\]\n]+)\] ([\s\S]*?)(?=\n\n\[[^\]\n]+\] |\s*$)/gm;
let m;
while ((m = re.exec(body.trim()))) msgs.push({ who: m[1], text: m[2] });
const last = msgs[msgs.length - 1] || { who: '?', text: '' };
const lt = last.text;

const other = { claude: 'codex', codex: 'claude', grok: 'claude' }[id];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (/SLEEP/.test(lt)) {
    await sleep(20000);
    console.log('should never be seen');
    return;
  }
  if (/SLOW/.test(lt)) await sleep(400);

  if (/BADEXIT/.test(lt)) {
    console.error('boom: something broke');
    process.exit(2);
  }
  if (/BADNOISE/.test(lt)) {
    console.error('2026-10-29T09:40:04Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed');
    console.error('(HttpRequest(HttpRequest("http/request failed")))');
    console.error('real problem: not logged in');
    process.exit(1);
  }
  if (/EMPTY/.test(lt)) return;
  if (/PINGPONG/.test(lt)) return console.log(`${id} says PINGPONG @${other}`);
  if (/SELF/.test(lt)) return console.log(`I am @${id}, and also @all, and @${id} again`);
  if (/FENCE/.test(lt)) return console.log('look:\n```\n@codex\n```\nand `@grok` inline');
  if (/CHAIN/.test(lt)) {
    if (id === 'claude' && last.who === 'You') return console.log('claude here CHAIN @codex your turn');
    if (id === 'codex' && last.who === 'Claude') return console.log('codex here CHAIN @grok your turn');
    if (id === 'grok') return console.log('grok here, done.');
  }
  if (/SHOWPROMPT/.test(lt)) return console.log(prompt.replace(/@/g, '(at)')); // no real @tags, or the dump would hand off to everyone
  if (/SENDFILE/.test(lt)) {
    fs.writeFileSync('made.txt', 'made by agent');
    return console.log('here you go\n```file:notes.md\n# Notes\nhi\n```\n[[file: made.txt]]\n[[file: ../outside.txt]]\n[[file: nope.txt]]');
  }
  if (/SHOWARGS/.test(lt)) return console.log('ARGS: ' + argv.join(' '));
  if (/WHERE/.test(lt)) return console.log('cwd=' + process.cwd());
  console.log(`${id}: got ${prompt.length} chars; last from ${last.who}: ${lt.slice(0, 60)}`);
})();
