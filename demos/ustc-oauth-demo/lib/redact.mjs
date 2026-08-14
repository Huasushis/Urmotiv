// Token classification and claim redaction: names, types, semantics — never values.
// JWT/JWS payloads are decoded locally for structure only; signatures are never verified offline.

// Vetted self-profile allowlist. Only these USTC profile paths may keep their values,
// and only inside the server-side in-memory session (never on disk, never in logs).
// Any other returned field is retained as field name/type only — its value is discarded.
export const PROFILE_ALLOWLIST = Object.freeze([
  { path: 'active', label: '账户有效（active）' },
  { path: 'id', label: 'ID（id）' },
  { path: 'attributes.gid', label: '群组 ID（gid）' },
  { path: 'attributes.name', label: '姓名（name）' },
  { path: 'attributes.deptname', label: '单位/院系（deptname）' },
  { path: 'attributes.zjhm', label: '学号/工号（zjhm）' },
  { path: 'attributes.jrzjhm', label: '教工号（jrzjhm）' },
  { path: 'attributes.kind', label: '人员类别（kind）' },
  { path: 'attributes.email', label: '邮箱（email）' },
]);

function pathValue(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// Split the provider profile into (a) allowlisted fields present, with values kept
// for the in-memory session only, and (b) every other present field as name/type only.
export function retainProfile(profile) {
  const retained = [];
  if (profile && typeof profile === 'object') {
    for (const { path, label } of PROFILE_ALLOWLIST) {
      const v = pathValue(profile, path);
      if (v !== undefined && v !== null) {
        retained.push({ path, label, type: typeof v, value: String(v) });
      }
    }
  }
  const allow = new Set(PROFILE_ALLOWLIST.map((x) => x.path));
  const others = [];
  const visit = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object') visit(v, p);
      else if (!allow.has(p)) others.push({ name: p, type: typeof v });
    }
  };
  if (profile && typeof profile === 'object') visit(profile, '');
  return { retained, others };
}

const KNOWN_SEMANTIC = new Set([
  'iss', 'aud', 'sub', 'exp', 'iat', 'nbf', 'jti', 'amr', 'nonce',
  'at_hash', 'auth_time', 'client_id', 'preferred_username',
]);

export function classifyToken(token) {
  if (typeof token !== 'string' || token.length === 0) return { format: 'opaque' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    return { format: 'opaque' };
  }
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { format: 'opaque' }; // shaped like JWT but not decodable -> treat as opaque
  }
  const claims = Object.entries(payload || {}).map(([name, value]) => ({
    name,
    type: typeof value,
    semantic: KNOWN_SEMANTIC.has(name),
  }));
  const alg = header && typeof header.alg === 'string' ? header.alg : 'unknown';
  return {
    format: 'jwt-jws',
    alg,
    claims,
    note: 'structure only; JWS signature not verified offline (no JWKS in demo)',
  };
}

export function profileSummary(profile) {
  if (!profile || typeof profile !== 'object') return { claims: [] };
  const claims = [{ name: 'active', type: typeof profile.active }];
  for (const key of ['id', 'client_id']) {
    if (Object.prototype.hasOwnProperty.call(profile, key)) {
      claims.push({ name: key, type: typeof profile[key] });
    }
  }
  const attrs =
    profile.attributes && typeof profile.attributes === 'object' ? profile.attributes : {};
  for (const [key, value] of Object.entries(attrs)) {
    claims.push({ name: `attributes.${key}`, type: typeof value });
  }
  return { claims };
}