// Minimal USTC OAuth2 authorization-code client (official endpoints, offline-testable).
// Never logs codes, tokens, or profile values.

export class AppError extends Error {
  constructor(stage, reason) {
    super(`${stage}:${reason}`);
    this.name = 'AppError';
    this.stage = stage;
    this.reason = reason;
  }
}

export function authorizeUrl(cfg, stateToken) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    state: stateToken,
  });
  if (cfg.scope) q.set('scope', cfg.scope);
  return `${cfg.authorizeUrl}?${q}`;
}

async function postForm(url, params, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  const text = await res.text();
  if (!res.ok) throw new AppError(`${res.status}`.startsWith('4') ? 'provider_client_error' : 'provider_server_error', `http_${res.status}`);
  return text;
}

export async function exchangeCode(cfg, code) {
  if (typeof code !== 'string' || code.length === 0 || code.length > 200) {
    throw new AppError('token_exchange', 'bad_code_shape');
  }
  let text;
  try {
    text = await postForm(
      cfg.tokenUrl,
      {
        grant_type: 'authorization_code',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: cfg.redirectUri,
        code,
      },
      cfg.timeoutMs
    );
  } catch (e) {
    throw mapNetError('token_exchange', 'network_or_timeout', e);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError('token_exchange', 'bad_json');
  }
  const accessToken = json && typeof json.access_token === 'string' ? json.access_token : '';
  if (!accessToken) throw new AppError('token_exchange', 'no_access_token');
  return { accessToken };
}

export async function fetchProfile(cfg, accessToken) {
  if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > 4096) {
    throw new AppError('profile', 'bad_token_shape');
  }
  let text;
  try {
    text = await postForm(
      cfg.profileUrl,
      { access_token: accessToken },
      cfg.timeoutMs
    );
  } catch (e) {
    throw mapNetError('profile', 'network_or_timeout', e);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError('profile', 'bad_json');
  }
  if (!json || json.active === false) throw new AppError('profile', 'inactive');
  return json;
}

function mapNetError(stage, fallback, e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return new AppError(stage, 'timeout');
  }
  if (e && e.name === 'AppError') return e;
  return new AppError(stage, fallback);
}