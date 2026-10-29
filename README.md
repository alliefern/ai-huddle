<h1 align="center">AI Huddle ✶</h1>
<p align="center"><b>Claude, Codex and Grok in one chat app. On your computer. No API keys.</b><br>
<sub>BROUGHT TO YOU BY <a href="https://alliefern.com">ALLIE FERN</a></sub></p>

![AI Huddle screenshot](docs/screenshot.png)

AI Huddle puts the AI command-line tools you already pay for into shared chat rooms. Make a room per topic, `@mention` whoever you want, and let them talk to each other too. Everything runs locally through the CLIs you're already logged into, so there are no API keys, no accounts, and no data leaving your computer except what those CLIs send themselves.

## What it does

- **Rooms.** One per topic. Each room has its own history, topic, members, and working folder. Rename, archive or delete them from the ⋯ menu that appears when you hover a room.
- **`@claude`, `@codex`, `@grok`, `@all`.** Everyone in a room sees that room's conversation. Agents can tag each other and keep going, with a cap you control so nobody quietly burns through your plan.
- **Shared skills.** One skill library for all three agents. Import skills once, call one with `/skill-name`, or pin it to a room.
- **Files and images.** Attach files, drag them in, or paste an image. Agents can send files back.
- **10 skins.** Pick one in Settings → Look.
- **Stays local.** No telemetry, no accounts, no analytics.

## Install

**Windows (easiest):** grab `AI-Huddle-Setup.exe` from the [Releases](../../releases) page and run it. Windows will say "Windows protected your PC" because the app isn't code-signed (that costs money). Click **More info**, then **Run anyway**.

**From source** (Windows, Mac or Linux):

```
git clone <this repo>
cd ai-huddle
npm install
npm start
```

Build your own installer with `npm run dist` (Windows). On Windows you can also double-click `start.bat` or `build.bat`.

## Before you open it: set up the CLIs

AI Huddle drives the command-line tools, so each one you want to use has to work in a normal terminal first, logged in. You only need one.

| Agent | Check it works |
| --- | --- |
| Claude | `claude -p "say hi"` |
| Codex | `codex exec --skip-git-repo-check "say hi"` |
| Grok | `grok -p "say hi"` (install: `irm https://x.ai/cli/install.ps1 \| iex` in PowerShell, then run `grok` once to log in) |

After installing one, close AI Huddle and reopen it, then use **Settings → Check my CLIs** to see where each was found. Anything missing shows "not found" and you can switch it off.

## Shared skills

- Click **Skills** in the sidebar. Import a skill folder, a folder of skills, a `.skill` or `.zip` file, or pull from another tool's skills folder (it detects `~/.claude/skills` and similar).
- A skill is a folder with a `SKILL.md` (optional `name` and `description` at the top, then instructions).
- Type `/skill-name` in a message (a menu pops up as you type `/`) and its full instructions go into the prompt for every agent that runs on that message. Or pin it to a room under Room → Pinned skills.
- Importing makes a copy. Your original folders aren't touched or kept in sync.
- Skills are plain instructions pasted into a prompt. Only import ones you trust.

## Files and images

- Up to 10 files per message, 25 MB each. Use the **+** button, drag them onto the window, or paste an image.
- Files are copied into a `huddle-files` folder inside the room's working folder and the agents are told the path. Whether an agent can actually *look at* an image depends on that CLI's own tools.
- Agents can send you files with a fenced block starting ` ```file:name.md ` (Huddle saves the text) or by saving a file and putting `[[file: path]]` on its own line. Files outside the room's folder are refused.

## Be aware

- **Every reply uses your real plan limits.** `@all` is three runs. Two agents ping-ponging is a lot of runs. Settings → Back-and-forth is the guardrail: cap it (default 6 per message) or choose "No cap, let them run" (Stop always works, and there is a hard ceiling of 200).
- **Leaving?** Hover a room, hit ⋯ → Export chat. You get one Markdown file of the whole conversation, every bot's replies included, ready to upload to any single AI.
- **No permission flags are added.** Each CLI runs with its own defaults. If you add something like a skip-permissions flag, that agent can act on your files without asking, in the room's folder.
- Agents are told not to touch files unless you ask. That's an instruction, not a lock.
- Check each provider's terms for how you're allowed to use their CLI. This app only runs the tools on your own computer, for you.
- Not affiliated with or endorsed by Anthropic, OpenAI or xAI. Claude, Codex, ChatGPT and Grok are their respective owners' trademarks.

## Fonts

The default skin uses Gopher headings and Bricolage Grotesque text. The Gopher font isn't included, so you'll get a system font unless you put your own copy in `renderer/fonts/` (see the README.txt in there). Bricolage Grotesque is free on Google Fonts.

## Development

```
npm test        # engine tests against fake agents, uses zero real usage
npm start       # run the app
npm run dist    # build the Windows installer + portable exe into dist/
```

- `engine.js`: rooms, routing, hand-offs, attachments, running the CLIs. No Electron in it.
- `skills.js`: the shared skill library.
- `main.js`, `preload.js`: the Electron shell.
- `renderer/`: the window. Skins are just CSS variables at the top of `styles.css` plus a list in `theme.js`.

Releases are built by GitHub Actions when you push a tag like `v0.1.0`.

## License

MIT. Made by [Allie Fern](https://alliefern.com).
