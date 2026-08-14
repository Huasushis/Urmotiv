// Configuration loading and fail-closed validation for the USTC OAuth2 demo.
// Loads the private env file (if any) then overlays process env. No secret ever leaves this module's scope.

import { readFileSync } from 'node:fs';

const WEAK = /(changeme|change_me|your[_a-z]*|example|placeholder|xxx|todo|secret_placeholder)/i;

export function parseEnvFile(path) {
  const out = {};
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function asUrl(s) {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function configError(message) {
  const e = new Error(message);
  e.code = 'CONFIG';
  return e;
}

export function loadConfig({ env = process.env } = {}) {
  const fileVars = env.USTC_DEMO_ENV_FILE ? parseEnvFile(env.USTC_DEMO_ENV_FILE) : {};
  const v = { ...fileVars, ...env };

  const host = v.USTC_DEMO_HOST || '127.0.0.1';
  const port = Number(v.USTC_DEMO_PORT || 9797);
  const clientId = v.USTC_DEMO_CLIENT_ID || '';
  const clientSecret = v.USTC_DEMO_CLIENT_SECRET || '';
  const sessionSecret = v.USTC_DEMO_SESSION_SECRET || '';
  const redirectUri = v.USTC_DEMO_REDIRECT_URI || '';
  const dataDir = v.USTC_DEMO_DATA_DIR || '';

  const cfg = {
    host,
    port,
    clientId,
    clientSecret,
    sessionSecret,
    redirectUri,
    dataDir,
    authorizeUrl: v.USTC_DEMO_AUTHORIZE_URL || 'https://id.ustc.edu.cn/cas/oauth2.0/authorize',
    tokenUrl: v.USTC_DEMO_TOKEN_URL || 'https://id.ustc.edu.cn/cas/oauth2.0/accessToken',
    profileUrl: v.USTC_DEMO_PROFILE_URL || 'https://id.ustc.edu.cn/cas/oauth2.0/profile',
    logoutUrl: v.USTC_DEMO_LOGOUT_URL || 'https://id.ustc.edu.cn/cas/logout',
    scope: v.USTC_DEMO_SCOPE || '',
    timeoutMs: Number(v.USTC_DEMO_HTTP_TIMEOUT_MS || 10000),
    stateTtlMs: Number(v.USTC_DEMO_STATE_TTL_MS || 600000),
  };

  cfg.callbackPath = v.USTC_DEMO_CALLBACK_PATH || '/api/v1/auth/ustc/callback';

  const configured = Boolean(clientId && clientSecret && redirectUri && sessionSecret);
  cfg.mode = configured ? 'live' : 'readiness';

  if (configured) {
    if (sessionSecret.length < 16 || WEAK.test(sessionSecret)) {
      throw configError('USTC_DEMO_SESSION_SECRET is missing, weak, or placeholder-like');
    }
    if (clientSecret.length < 8 || WEAK.test(clientSecret)) {
      throw configError('USTC_DEMO_CLIENT_SECRET is missing, weak, or placeholder-like');
    }
    const u = asUrl(redirectUri);
    if (!u) throw configError('USTC_DEMO_REDIRECT_URI is not a valid URL');
    if (u.protocol !== 'https:' || !/\.ustc\.edu\.cn$/i.test(u.hostname)) {
      throw configError(
        'USTC_DEMO_REDIRECT_URI must be HTTPS on a *.ustc.edu.cn host (campus registration required)'
      );
    }
    if (!u.pathname || u.pathname === '/' || !u.pathname.startsWith('/')) {
      throw configError('USTC_DEMO_REDIRECT_URI must include a non-trivial callback path');
    }
    if (v.USTC_DEMO_CALLBACK_PATH && v.USTC_DEMO_CALLBACK_PATH !== u.pathname) {
      throw configError(
        'USTC_DEMO_CALLBACK_PATH must equal the registered redirect_uri path (exact callback equality)'
      );
    }
    // The callback is served ONLY at the exact path of the registered redirect_uri.
    cfg.callbackPath = u.pathname;
  }

  cfg.secureCookies = configured ? cfg.redirectUri.startsWith('https:') : false;
  return cfg;
}