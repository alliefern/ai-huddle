<h1 align="center">AI Huddle</h1>
<p align="center"><b>Claude, Codex and Grok in one chat app on your computer, using the CLIs you're already logged into, so you don't need API keys.</b><br>
<sub>brought to you by <a href="https://alliefern.com">Allie Fern</a></sub></p>

![screenshot of AI Huddle](docs/screenshot.png)

I built AI Huddle so the command-line tools you already pay for can share chat rooms. you make a room per topic, `@mention` whoever you want, and they can talk to each other too. the app keeps your chats on your computer, and the agents run through the command-line tools you're logged into. the app doesn't ask for API keys or an account. if anything leaves your computer, it's because one of those command-line tools sent it.

## what it does

- **rooms.** each topic gets its own room, with its own history, topic, members, and working folder. hover a room and the ⋯ menu is where you rename it, archive it, or delete it.
- **`@claude`, `@codex`, `@grok`, `@all`.** everyone in a room sees that room's conversation. agents can tag each other and keep going, and you can cap that so they don't burn through your plan.
- **shared skills.** there's one skill library, and Claude, Codex and Grok all use it. you import a skill once, call it with `/skill-name`, or pin it to a room.
- **files and images.** you can attach files, drag them in, or paste an image. agents can send files back.
- **skins.** there are 10, and you pick one in settings → look.
- **on your computer.** the app doesn't include telemetry or analytics.

## install

**Windows (the easy way):** grab `AI-Huddle-Setup.exe` from the [releases](../../releases) page and run it. Windows will say "Windows protected your PC" because the app isn't code-signed. I haven't signed it, since that costs money. click **More info**, then **Run anyway**.

**from source** (Windows, Mac or Linux):

```
git clone <this repo>
cd ai-huddle
npm install
npm start
```

build your own installer with `npm run dist` (Windows). on Windows you can also double-click `start.bat` or `build.bat`.

## before you open it, set up the CLIs

AI Huddle drives the command-line tools, so each one you want has to work in a normal terminal first, and you have to be logged in, though you don't need all three.

| agent | see if it works |
| --- | --- |
| Claude | `claude -p "say hi"` |
| Codex | `codex exec --skip-git-repo-check "say hi"` |
| Grok | `grok -p "say hi"` (install with `irm https://x.ai/cli/install.ps1 \| iex` in PowerShell, then run `grok` once to log in) |

after you install one, close AI Huddle and open it again, then use **settings → check my CLIs** to see where each one was found. anything missing shows "not found", and you can switch it off.

## shared skills

- click **skills** in the sidebar. you can import a skill folder, a folder of skills, a `.skill` or `.zip` file, or pull from another tool's skills folder. it looks for `~/.claude/skills` and similar folders.
- a skill is a folder with a `SKILL.md`. `name` and `description` at the top are optional, and the rest is the instructions.
- type `/skill-name` in a message. a menu pops up as you type `/`, and the full instructions go into the prompt for every agent that runs on that message. you can also pin a skill to a room under room → pinned skills.
- importing makes a copy. the app leaves your original folders alone, and it doesn't keep them in sync.
- skills are plain instructions that get pasted into a prompt. if you don't trust one, skip it.

## files and images

- up to 10 files per message, 25 MB each. use the **+** button, drag them onto the window, or paste an image.
- the app copies files into a `huddle-files` folder inside the room's working folder, and it tells the agents the path. whether an agent can look at an image depends on that CLI's own tools.
- agents can send you files with a fenced block starting ` ```file:name.md ` (the app saves the text) or by saving a file and putting `[[file: path]]` on its own line. if a file is outside the room's folder, the app refuses it.

## be aware

- **every reply uses your real plan limits.** `@all` is three runs. if two agents keep answering each other, that adds up. settings → back-and-forth is where you cap it (the default is 6 per message) or choose "no cap, let them run". you can hit stop whenever you want. even with no cap, the app cuts them off at 200 replies in a row.
- **pick your team.** all girls (Claudette, Codexa, Grokette), all boys (Claude, Codex, Grok), or mixed (Claude, Codexa, Grok). the first time you open the app, it asks for your name, then your team, then a color skin. settings has all of that later.
- **usage bars.** each agent in the sidebar has a bar and a percentage for a daily budget you set. the app counts runs it started. that number is a budget you set. the app can't see the real limit on your plan.
- **if you want the chat somewhere else,** hover a room and hit ⋯ → export chat. you get one Markdown file of the whole conversation, with every bot's replies included, and you can upload that file to any single AI.
- **the app doesn't add permission flags.** each CLI runs with its own defaults. if you add something like a skip-permissions flag, that agent can act on your files without asking, in the room's folder.
- the app tells the agents not to touch files unless you ask. that's just a line in the prompt, so it won't stop an agent that ignores it.
- check each provider's terms for how you're allowed to use their CLI. this app runs the tools on your own computer, for you.
- AI Huddle isn't affiliated with or endorsed by Anthropic, OpenAI or xAI. Claude, Codex, ChatGPT and Grok are their respective owners' trademarks.

## fonts

the default skin uses Gopher for headings and Bricolage Grotesque for the text. Bricolage Grotesque is free and open, and `npm install` fetches it for you. Gopher is a licensed font, so I left it out of the repo. headings use Bricolage Grotesque unless you drop your own copy of Gopher in `renderer/fonts/` (see the README.txt in there).

## development

```
npm test        # engine tests against fake agents, uses zero real usage
npm start       # run the app
npm run dist    # build the Windows installer + portable exe into dist/
```

- `engine.js` handles rooms, routing, hand-offs, attachments, and running the CLIs. it doesn't use Electron.
- `skills.js` holds the shared skill library.
- `main.js` and `preload.js` are the Electron shell.
- `renderer/` draws the window. skins are CSS variables at the top of `styles.css`, and the list of them is in `theme.js`.

GitHub Actions builds the release when you push a tag like `v0.1.0`.

## license

MIT. made by [Allie Fern](https://alliefern.com).
