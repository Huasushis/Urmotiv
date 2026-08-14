// Token classification and claim redaction: names, types, semantics — never values.
// JWT/JWS payloads are decoded locally for structure only; signatures are never verified offline.

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