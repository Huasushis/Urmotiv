// In-memory browser session store. Session id is a 256-bit random value held only in the HttpOnly cookie.
import { randomBytes } from 'node:crypto';

export class SessionStore {
  constructor() {
    this.map = new Map();
  }

  create(handle) {
    const id = randomBytes(32).toString('base64url');
    this.map.set(id, { handle, at: Date.now() });
    return id;
  }

  get(id) {
    return id ? this.map.get(id) : undefined;
  }

  destroy(id) {
    if (id) this.map.delete(id);
  }
}