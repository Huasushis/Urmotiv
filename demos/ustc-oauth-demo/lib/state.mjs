// OAuth2 `state` correlation: random per-flow nonce, HMAC-signed, time-limited, single-use.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function sign(secret, data) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export class StateStore {
  constructor(secret, { ttlMs = 600000, now = Date.now } = {}) {
    this.secret = secret;
    this.ttlMs = ttlMs;
    this.now = now;
    this.active = new Map(); // nonce -> { exp }
  }

  issue() {
    const nonce = randomBytes(32).toString('base64url');
    const exp = this.now() + this.ttlMs;
    this.active.set(nonce, { exp });
    return { token: `${nonce}.${exp}.${sign(this.secret, `${nonce}.${exp}`)}`, exp };
  }

  // Returns 'ok' | 'malformed' | 'mismatch' | 'unknown' | 'expired'. Consumes the ticket in every case.
  consume(token) {
    if (typeof token !== 'string') return 'malformed';
    const parts = token.split('.');
    if (parts.length !== 3) return 'malformed';
    const [nonce, expStr, mac] = parts;
    const exp = Number(expStr);
    if (!Number.isFinite(exp)) return 'malformed';
    const expected = sign(this.secret, `${nonce}.${expStr}`);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return 'mismatch';
    const rec = this.active.get(nonce);
    if (!rec) return 'unknown';
    this.active.delete(nonce); // single-use: consumed on first attempt
    if (rec.exp !== exp || exp < this.now()) return 'expired';
    return 'ok';
  }
}