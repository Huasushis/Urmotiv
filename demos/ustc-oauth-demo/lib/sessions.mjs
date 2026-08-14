// In-memory browser session store with bounded lifetime. Session id is a 256-bit
// random value held only in the HttpOnly cookie. Entries are swept on access and
// on create so the map cannot grow without bound.
import { randomBytes } from 'node:crypto';

export class SessionStore {
  constructor({ ttlMs = 8 * 3600 * 1000, now = Date.now } = {}) {
    this.map = new Map();
    this.ttlMs = ttlMs;
    this.now = now;
  }

  sweep() {
    const nowMs = this.now();
    for (const [id, rec] of this.map) {
      if (rec.exp <= nowMs) this.map.delete(id);
    }
  }

  create(handle, extra) {
    this.sweep();
    const id = randomBytes(32).toString('base64url');
    const exp = this.now() + this.ttlMs;
    this.map.set(id, { handle, at: this.now(), exp, ...(extra || {}) });
    return id;
  }

  get(id) {
    if (!id) return undefined;
    this.sweep(); // drop every expired record (incl. unrelated sessions) on access
    return this.map.get(id);
  }

  destroy(id) {
    if (id) this.map.delete(id);
  }
}