# contributing to AI Huddle

thanks for wanting to help. bug reports and fixes are both welcome. I build and test AI Huddle on Windows only, so if you get it running on a Mac or Linux, an issue telling me what worked and what broke helps a lot.

## reporting a bug

[open an issue](https://github.com/alliefern/ai-huddle/issues) and tell me your OS, your AI Huddle version (it's in settings), which CLIs you have set up, and what happened versus what you expected. if a CLI shows "not found", include what settings → **Check my CLIs** says. please leave out API keys, tokens, and anything from your shared memory you wouldn't post publicly.

## running it locally

you need Node.js and git.

```
git clone https://github.com/alliefern/ai-huddle.git
cd ai-huddle
npm install
npm start
```

`npm install` also fetches the free Bricolage Grotesque font. Gopher is licensed, so it isn't in the repo, and the app falls back to Bricolage Grotesque without it.

## tests

```
npm test
```

the tests run the engine against fake agents, so they don't use any of your real Claude, Codex or Grok usage. GitHub Actions runs them on every pull request, so please make sure they pass locally first. if you change how rooms, hand-offs, attachments or CLI calls work in `engine.js`, add a test in `test/engine.test.js`.

## where things live

- `engine.js` handles rooms, routing, hand-offs, attachments, and running the CLIs. it doesn't use Electron, which is why it can be tested on its own.
- `skills.js` is the shared skill library.
- `main.js` and `preload.js` are the Electron shell, and `updater.js` handles auto-updates.
- `renderer/` draws the window. skins are CSS variables at the top of `styles.css`, and the list of them is in `theme.js`.

## pull requests

- keep each PR to one change, and say in the description what it fixes and how you tested it.
- AI Huddle doesn't collect telemetry, and the only network calls it makes itself are the GitHub update check and `git clone` when you press clone. please don't add new ones.
- if your change affects what users see or do, update the README too.

by contributing, you agree your work is released under the [MIT license](LICENSE).
