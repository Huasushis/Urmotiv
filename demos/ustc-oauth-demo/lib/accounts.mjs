// Owner-only account record store (0600 file, 0700 dir), OUTSIDE the worktree.
// Records carry only HMAC-redacted identifiers and presence booleans — never plaintext campus values.

import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function hmacHex(secret, scope, value) {
  return createHmac('sha256', secret).update(`${scope}:${value}`).digest('hex').slice(0, 32);
}

// Stable binding key: fixed provider namespace + authoritative immutable subject (gid preferred, then id).
export function subjectBinding(secret, subject) {
  const mac = hmacHex(secret, 'ustc', subject);
  return { key: `ustc:${mac}`, handle: `u${mac.slice(0, 8)}` };
}

export class AccountStore {
  constructor(filePath) {
    this.file = filePath;
    this.accounts = null;
  }

  load() {
    if (this.accounts) return this.accounts;
    try {
      this.accounts = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.accounts = {};
    }
    return this.accounts;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.accounts, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  // Links or auto-provisions strictly under (provider=ustc, subject). Never takes over unrelated accounts:
  // a different provider namespace or a different subject is a separate key, never merged.
  // If the same subject reappears with a DIFFERENT campus-ID HMAC, refuse (integrity mismatch) for manual review.
  linkOrCreate(binding, { campusIdPresent, campusIdHmac }) {
    this.load();
    const existing = this.accounts[binding.key];
    if (existing) {
      if (existing.campusIdPresent && campusIdPresent && existing.campusIdHmac !== campusIdHmac) {
        throw new Error('account-integrity-mismatch: subject reappeared with a different campus identifier');
      }
      return { account: existing, created: false };
    }
    const account = {
      provider: 'ustc',
      handle: binding.handle,
      subjectHmac: binding.key,
      campusIdPresent: Boolean(campusIdPresent),
      campusIdHmac: campusIdPresent ? campusIdHmac : null,
      createdAt: new Date().toISOString(),
    };
    this.accounts[binding.key] = account;
    this.save();
    return { account, created: true };
  }
}