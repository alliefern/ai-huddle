'use strict';
// A stand-in for `claude -p` with a PreToolUse HTTP hook. FAKE_TOOLS="Bash:npm test,Write:/a.txt,Read:/b" lists what it tries.
const fs = require('fs');
const http = require('http');
const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const mode = val('--permission-mode') || 'none';
const settingsFile = val('--settings');
fs.readFileSync(0, 'utf8'); // the prompt
const post = (url, body) => new Promise((resolve) => {
  const u = new URL(url);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
    let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  req.on('error', () => resolve({ status: 0, body: '' }));
  req.end(JSON.stringify(body));
});
(async () => {
  const out = [];
  let matcher = null, url = null, hasHook = false;
  if (settingsFile) {
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const h = s.hooks.PreToolUse[0];
    matcher = new RegExp('^(' + h.matcher + ')$');
    url = h.hooks[0].url;
    hasHook = h.hooks[0].type === 'http' && h.hooks[0].timeout > 0;
  }
  for (const t of (process.env.FAKE_TOOLS || '').split(',').filter(Boolean)) {
    const at = t.indexOf(':');
    const name = t.slice(0, at);
    const arg = t.slice(at + 1);
    if (!matcher || !matcher.test(name)) { out.push(`${name}=pass`); continue; }
    const input = name === 'Bash' ? { command: arg } : name.startsWith('Web') ? { url: arg } : { file_path: arg };
    const r = await post(url, { hook_event_name: 'PreToolUse', tool_name: name, tool_input: input });
    let d = 'none';
    try { d = JSON.parse(r.body).hookSpecificOutput.permissionDecision; } catch (_) {}
    out.push(`${name}=${d}`);
  }
  console.log(`claude mode=${mode} hook=${hasHook ? 'yes' : 'no'} ${out.join(' ')}`);
})();
