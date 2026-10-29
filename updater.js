'use strict';
// Auto-update from this project's GitHub Releases. Installed (NSIS) builds only: the portable exe and
// `npm start` can't update themselves, so they just say so. Nothing but a version check and the download
// goes out, and only to GitHub. The "Check for updates" switch in Settings turns the check off.

const REPO = 'github.com/alliefern/ai-huddle';

// turn electron-updater's raw errors into something a person can act on
function friendlyError(e) {
  const raw = String((e && e.message) || e || '').split('\n')[0];
  if (/latest\.yml|404/.test(raw)) {
    return "I couldn't find the update files on GitHub yet. If a new version was just released, it's probably still being built. Try again in a few minutes.";
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|net::|socket hang up/i.test(raw)) {
    return "I couldn't reach GitHub. Check your internet connection and try again.";
  }
  return "I couldn't check for updates (" + raw.slice(0, 120) + ').';
}

class Updater {
  // deps are injected so this can be tested without Electron: { autoUpdater, app, send, isEnabled, env }
  constructor(deps) {
    this.u = deps.autoUpdater;
    this.app = deps.app;
    this.send = deps.send || (() => {});
    this.isEnabled = deps.isEnabled || (() => true);
    this.env = deps.env || process.env;
    this.state = { state: 'idle', version: this.app.getVersion(), latest: null, message: '' };
    this.checking = false;

    // Why this build can't update itself, or '' if it can.
    this.unsupported = !this.app.isPackaged
      ? 'Running from source. Update with git pull and npm install.'
      : this.env.PORTABLE_EXECUTABLE_DIR
      ? 'The portable version cannot update itself. Download the newest AI-Huddle-Portable.exe from the Releases page.'
      : '';

    if (this.u && !this.unsupported) {
      this.u.autoDownload = true;
      this.u.autoInstallOnAppQuit = true;
      this.u.allowPrerelease = false;
      this.u.on('checking-for-update', () => this._set('checking'));
      this.u.on('update-available', (i) => this._set('downloading', { latest: i && i.version }));
      this.u.on('update-not-available', () => {
        this.checking = false;
        this._set('current');
      });
      this.u.on('download-progress', (p) => this._set('downloading', { message: p ? Math.round(p.percent || 0) + '%' : '' }));
      this.u.on('update-downloaded', (i) => {
        this.checking = false;
        this._set('ready', { latest: i && i.version });
      });
      this.u.on('error', (e) => {
        this.checking = false;
        this._set('error', { message: friendlyError(e) });
      });
    }
  }

  _set(state, extra) {
    this.state = { ...this.state, state, message: '', ...(extra || {}) };
    this.send(this.state);
  }

  getState() {
    return { ...this.state, unsupported: this.unsupported };
  }

  // manual = the user pressed "Check now", so ignore the on/off switch
  async check(manual) {
    if (this.unsupported) {
      this._set('unsupported', { message: this.unsupported });
      return this.getState();
    }
    if (!manual && !this.isEnabled()) return this.getState();
    if (this.checking || this.state.state === 'ready') return this.getState();
    this.checking = true;
    try {
      await this.u.checkForUpdates();
    } catch (e) {
      this.checking = false;
      this._set('error', { message: friendlyError(e) });
    }
    return this.getState();
  }

  install() {
    if (this.state.state !== 'ready') return false;
    this.u.quitAndInstall(false, true);
    return true;
  }
}

module.exports = {
  friendlyError, Updater, REPO };
