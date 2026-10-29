'use strict';
// Huddle's shared skill library. One folder, every agent in every room can use it.
//
// A skill is a folder with a SKILL.md in it (the same format Claude skills use):
//
//   my-skill/
//     SKILL.md        <- optional "---\nname: ...\ndescription: ...\n---" header, then the instructions
//     (anything else the skill refers to)
//
// Pure Node, no Electron, so it's testable.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const SKIP = new Set(['node_modules', '.git', '__pycache__']);

function parseFrontmatter(text) {
  const m = String(text).replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text) };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === '>' || v === '|' || v === '>-' || v === '|-') {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(' ');
    }
    meta[kv[1].toLowerCase()] = v.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return { meta, body: m[2] };
}

const slugOf = (s) =>
  String(s)
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function hasSkill(dir) {
  try {
    return fs.statSync(path.join(dir, 'SKILL.md')).isFile();
  } catch (_) {
    return false;
  }
}

// Find skill folders at or under `root` (a few levels deep, so ~/.claude/skills and unzipped bundles both work).
function findSkillDirs(root, depth = 3) {
  if (hasSkill(root)) return [root];
  if (depth <= 0) return [];
  let kids = [];
  try {
    kids = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const k of kids) {
    if (!k.isDirectory() || SKIP.has(k.name) || k.name.startsWith('.')) continue;
    out.push(...findSkillDirs(path.join(root, k.name), depth - 1));
  }
  return out;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
    // symlinks and other oddities are skipped on purpose
  }
}

function extractArchive(file, dest) {
  const tries = IS_WIN
    ? [
        ['tar', ['-xf', file, '-C', dest]],
        ['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]],
      ]
    : [
        ['unzip', ['-q', '-o', file, '-d', dest]],
        ['tar', ['-xf', file, '-C', dest]],
      ];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

class SkillStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  list() {
    let kids = [];
    try {
      kids = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch (_) {
      return [];
    }
    const out = [];
    for (const k of kids) {
      if (!k.isDirectory() || !hasSkill(path.join(this.dir, k.name))) continue;
      const file = path.join(this.dir, k.name, 'SKILL.md');
      let meta = {};
      let size = 0;
      try {
        const txt = fs.readFileSync(file, 'utf8');
        meta = parseFrontmatter(txt).meta;
        size = txt.length;
      } catch (_) {}
      out.push({
        slug: k.name,
        name: meta.name || k.name,
        description: meta.description || '',
        dir: path.join(this.dir, k.name),
        file,
        size,
      });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  // match by folder name first, then by the name in the header, ignoring case
  find(token) {
    const t = String(token).toLowerCase();
    const all = this.list();
    return all.find((s) => s.slug.toLowerCase() === t) || all.find((s) => String(s.name).toLowerCase() === t) || null;
  }

  read(slug) {
    const s = this.find(slug);
    if (!s) return null;
    try {
      const { body } = parseFrontmatter(fs.readFileSync(s.file, 'utf8'));
      return { ...s, body: body.trim() };
    } catch (_) {
      return null;
    }
  }

  remove(slug) {
    const s = this.find(slug);
    if (!s) return false;
    fs.rmSync(s.dir, { recursive: true, force: true });
    return true;
  }

  // src can be: a skill folder, a folder full of skill folders, or a .zip / .skill file.
  // Copies (a snapshot, not a link). Re-importing the same name replaces it.
  importFrom(src) {
    const res = { added: [], updated: [], failed: [] };
    let root = src;
    let tmp = null;
    try {
      const st = fs.statSync(src);
      if (st.isFile()) {
        if (/SKILL\.md$/i.test(src)) root = path.dirname(src);
        else {
          tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-skill-'));
          if (!extractArchive(src, tmp)) {
            res.failed.push(`${path.basename(src)}: couldn't unzip it`);
            return res;
          }
          root = tmp;
        }
      }
      const found = findSkillDirs(root);
      if (!found.length) res.failed.push(`${path.basename(src)}: no SKILL.md found in it`);
      for (const d of found) {
        // a bundle unzipped to a temp folder may have a meaningless folder name; prefer the skill's own name
        let slug = slugOf(path.basename(d));
        try {
          const nm = parseFrontmatter(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8')).meta.name;
          if ((tmp && d === tmp) || /^huddle-skill-/.test(slug)) slug = slugOf(nm || slug);
        } catch (_) {}
        if (!slug) {
          res.failed.push(`${d}: no usable name`);
          continue;
        }
        const dest = path.join(this.dir, slug);
        if (path.resolve(d) === path.resolve(dest)) continue; // already the library
        const existed = fs.existsSync(dest);
        try {
          if (existed) fs.rmSync(dest, { recursive: true, force: true });
          copyDir(d, dest);
          (existed ? res.updated : res.added).push(slug);
        } catch (e) {
          res.failed.push(`${slug}: ${e.message}`);
        }
      }
    } catch (e) {
      res.failed.push(`${path.basename(String(src))}: ${e.message}`);
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
    return res;
  }
}

// Places other tools keep skills. Only the ones that exist are returned.
function candidateSources(home = os.homedir()) {
  const rels = [
    ['Claude Code', ['.claude', 'skills']],
    ['Codex', ['.codex', 'skills']],
    ['Grok', ['.grok', 'skills']],
    ['Agents', ['.agents', 'skills']],
  ];
  const out = [];
  for (const [label, rel] of rels) {
    const p = path.join(home, ...rel);
    const n = findSkillDirs(p).length;
    if (n) out.push({ label, path: p, count: n });
  }
  return out;
}

module.exports = { SkillStore, parseFrontmatter, candidateSources, findSkillDirs };
