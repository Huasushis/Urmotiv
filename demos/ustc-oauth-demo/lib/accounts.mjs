// Owner-only account record store (0600 file, 0700 dir), OUTSIDE the worktree.
// Records carry only HMAC-redacted identifiers and presence booleans — never plaintext campus values.
// The store file is an integrity envelope { v, mac, data }: a corrupt or tampered file fails
// closed (load error, nothing reset, evidence preserved) instead of being silently overwritten.

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
  constructor(filePath, secret) {
    this.file = filePath;
    this.secret = secret;
    this.accounts = null;
  }

  // Fail closed: any unparseable or integrity-invalid store throws and the file is left
  // byte-for-byte untouched (evidence preserved for manual review).
  load() {
    if (this.accounts) return this.accounts;
    let raw;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.accounts = {};
        return this.accounts;
      }
      throw new Error('account-store-unreadable');
    }
    let envl;
    try {
      envl = JSON.parse(raw);
    } catch {
      throw new Error('account-store-corrupt');
    }
    const data = envl && typeof envl === 'object' ? envl.data : undefined;
    const mac = envl && typeof envl === 'object' ? envl.mac : undefined;
    if (envl === null || typeof envl !== 'object' || envl.v !== 1 || data === undefined || typeof mac !== 'string') {
      throw new Error('account-store-integrity-invalid');
    }
    const expected = hmacHex(this.secret, 'store', JSON.stringify(data));
    if (expected !== mac) {
      throw new Error('account-store-integrity-mismatch');
    }
    this.accounts = data;
    return this.accounts;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // Atomic write via temp file + rename in the SAME directory. rename() replaces a
    // symlink at this path with a real file, so a planted symlink is neutralized, never followed.
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    const envl = {
      v: 1,
      mac: hmacHex(this.secret, 'store', JSON.stringify(this.accounts)),
      data: this.accounts,
    };
    writeFileSync(tmp, JSON.stringify(envl, null, 1), { mode: 0o600 });
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