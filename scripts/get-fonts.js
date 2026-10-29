'use strict';
// Copies the free Bricolage Grotesque font (SIL Open Font License) out of node_modules into the app,
// so a fresh clone looks right after `npm install`. Never fails the install: no font just means a system fallback.
const fs = require('fs');
const path = require('path');

try {
  const dir = path.join(__dirname, '..', 'node_modules', '@fontsource-variable', 'bricolage-grotesque', 'files');
  const pick = fs.readdirSync(dir).find((f) => /latin-wght-normal\.woff2$/.test(f)) || fs.readdirSync(dir).find((f) => /wght-normal\.woff2$/.test(f));
  if (!pick) throw new Error('font file not found in package');
  const dest = path.join(__dirname, '..', 'renderer', 'fonts', 'BricolageGrotesque.woff2');
  fs.copyFileSync(path.join(dir, pick), dest);
  console.log('copied Bricolage Grotesque:', pick);
} catch (e) {
  console.log('I skipped the font copy (' + e.message + '). AI Huddle will use a system font instead.');
}
