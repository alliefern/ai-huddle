'use strict';
// A tiny JSON-RPC peer over a child process's stdin/stdout, one JSON message per line.
// Used for CLIs that can talk to us while they work (so they can ask permission mid-task).

const MAX_LINE = 16 * 1024 * 1024;

class RpcPeer {
  // handlers: { onRequest(msg) -> Promise<result>, onNotification(msg), onClose(code) }
  constructor(child, handlers = {}) {
    this.child = child;
    this.h = handlers;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.closed = false;
    this.v2 = !!handlers.jsonrpc2;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this._data(d));
    child.stdin.on('error', () => {});
    child.on('close', (code) => this._close(code));
    child.on('error', (e) => this._close(null, e));
  }

  _data(d) {
    this.buf += d;
    // One message per line. A "line" this long means the other side isn't speaking this protocol: stop listening
    // rather than buffer without limit.
    if (this.buf.length > MAX_LINE && this.buf.indexOf('\n') < 0) {
      this.buf = '';
      this._close(null, new Error('the CLI sent a message too large to read'));
      try {
        this.child.kill();
      } catch (_) {}
      return;
    }
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        if (this.h.onJunk) this.h.onJunk(line);
        continue;
      }
      this._message(msg);
    }
  }

  _message(msg) {
    if (msg && msg.id != null && (Object.prototype.hasOwnProperty.call(msg, 'result') || msg.error) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'rpc error'), { rpc: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    if (msg && msg.method && msg.id != null) {
      // the other side is asking us something (an approval, usually)
      Promise.resolve()
        .then(() => (this.h.onRequest ? this.h.onRequest(msg) : Promise.reject(new Error('unsupported'))))
        .then(
          (result) => this._send({ id: msg.id, result: result == null ? {} : result }),
          (e) => this._send({ id: msg.id, error: { code: -32601, message: String((e && e.message) || e) } })
        );
      return;
    }
    if (msg && msg.method && this.h.onNotification) this.h.onNotification(msg);
  }

  _send(obj) {
    if (this.closed) return false;
    try {
      this.child.stdin.write(JSON.stringify(this.v2 ? Object.assign({ jsonrpc: '2.0' }, obj) : obj) + '\n');
      return true;
    } catch (_) {
      return false;
    }
  }

  request(method, params, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('connection closed'));
      const id = this.nextId++;
      const p = { resolve, reject, timer: null };
      if (timeoutMs > 0) p.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out`), { timeout: true }));
      }, timeoutMs);
      this.pending.set(id, p);
      if (!this._send({ id, method, params: params || {} })) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        reject(new Error('connection closed'));
      }
    });
  }

  notify(method, params) {
    this._send(params === undefined ? { method } : { method, params });
  }

  _close(code, err) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err || new Error('connection closed'));
    }
    this.pending.clear();
    if (this.h.onClose) this.h.onClose(code, err);
  }
}

module.exports = { RpcPeer };
