// Offline tests for the USTC OAuth2 demo: full flows against a mock IdP plus state/config/security units.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, lstatSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { loadConfig, parseEnvFile, OFFICIAL_ENDPOINTS } from '../lib/config.mjs';
import { StateStore } from '../lib/state.mjs';
import { SessionStore } from '../lib/sessions.mjs';
import { hmacHex } from '../lib/accounts.mjs';
import { createApp } from '../server.mjs';
import { startMock, FIXTURE, fakeJwt } from './helpers.mjs';

const HOST = 'demo-test.ustc.edu.cn';
const REDIRECT = `https://${HOST}/api/v1/auth/ustc/callback`;

function buildEnv(mock, overrides = {}) {
  return {
    USTC_DEMO_HOST: '127.0.0.1',
    USTC_DEMO_PORT: '0',
    USTC_DEMO_CLIENT_ID: 'test-client-id',
    USTC_DEMO_CLIENT_SECRET: 'Z'.repeat(24),
    USTC_DEMO_SESSION_SECRET: 'S'.repeat(32),
    USTC_DEMO_REDIRECT_URI: REDIRECT,
    USTC_DEMO_AUTHORIZE_URL: mock.url('/cas/oauth2.0/authorize'),
    USTC_DEMO_TOKEN_URL: mock.url('/cas/oauth2.0/accessToken'),
    USTC_DEMO_PROFILE_URL: mock.url('/cas/oauth2.0/profile'),
    USTC_DEMO_HTTP_TIMEOUT_MS: '500',
    USTC_DEMO_STATE_TTL_MS: '600000',
    USTC_DEMO_TEST_SEAM: '1',
    ...overrides,
  };
}

function rawGet(port, pathAndQuery, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathAndQuery, method: 'GET', headers: { host: HOST, ...headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function startApp(env, { preSeed, rawPreSeed, symlinkStore, now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ustc-demo-'));
  const dataDir = join(dir, 'data');
  if (symlinkStore) {
    // Planted symlink mimicking local escalation at the store path: load() must
    // fail closed on the non-envelope target; no write may pass through it.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'outside-target.json'), 'ORIGINAL', { mode: 0o600 });
    symlinkSync(join(dataDir, 'outside-target.json'), join(dataDir, 'accounts.json'));
  } else if (rawPreSeed !== undefined) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'accounts.json'), rawPreSeed, { mode: 0o600 });
  } else if (preSeed) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const secret = String(env.USTC_DEMO_SESSION_SECRET || 'S'.repeat(32));
    const envl = { v: 1, mac: hmacHex(secret, 'store', JSON.stringify(preSeed)), data: preSeed };
    writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify(envl, null, 1), { mode: 0o600 });
  }
  const cfg = loadConfig({ env: { ...env, USTC_DEMO_DATA_DIR: dataDir }, now });
  const logs = [];
  const app = createApp(cfg, { log: { log: (s) => logs.push(s) } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server, port: server.address().port, dataDir, logs,
    close: async () => {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function fullLogin(app, { code = 'mockcode', host = HOST } = {}) {
  const start = await rawGet(app.port, '/login', { host });
  assert.equal(start.status, 302, 'login start must redirect');
  const loc = new URL(start.headers.location);
  const state = loc.searchParams.get('state');
  assert.ok(state, 'authorize URL must carry state');
  const stateCookie = String(start.headers['set-cookie'] || '').split(';')[0];
  const cb = await rawGet(
    app.port,
    `/api/v1/auth/ustc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { host, cookie: stateCookie }
  );
  return { cb, state };
}

function accounts(app) {
  const file = join(app.dataDir, 'accounts.json');
  if (!existsSync(file)) return {};
  const envl = JSON.parse(readFileSync(file, 'utf8'));
  return envl.data;
}

describe('config', () => {
  test('readiness mode when identity config absent', () => {
    const env = {
      USTC_DEMO_REDIRECT_URI: '', USTC_DEMO_CLIENT_ID: '', USTC_DEMO_CLIENT_SECRET: '',
      USTC_DEMO_SESSION_SECRET: '', USTC_DEMO_URL_BASE: '',
    };
    assert.equal(loadConfig({ env }).mode, 'readiness');
  });
  test('refuses weak session secret', () => {
    const m = { url: (p) => `http://127.0.0.1:1${p}` };
    assert.throws(
      () => loadConfig({ env: { ...buildEnv(m), USTC_DEMO_SESSION_SECRET: 'change-me-now' } }),
      /SESSION_SECRET/
    );
  });
  test('refuses placeholder client secret', () => {
    const m = { url: (p) => `http://127.0.0.1:1${p}` };
    assert.throws(
      () => loadConfig({ env: { ...buildEnv(m), USTC_DEMO_CLIENT_SECRET: 'your-secret-value-here' } }),
      /CLIENT_SECRET/
    );
  });
  test('refuses non-https redirect', () => {
    const m = { url: (p) => `http://127.0.0.1:1${p}` };
    assert.throws(
      () => loadConfig({ env: { ...buildEnv(m), USTC_DEMO_REDIRECT_URI: `http://${HOST}/cb` } }),
      /REDIRECT_URI/
    );
  });
  test('refuses non-ustc.edu.cn redirect host', () => {
    const m = { url: (p) => `http://127.0.0.1:1${p}` };
    assert.throws(
      () => loadConfig({ env: { ...buildEnv(m), USTC_DEMO_REDIRECT_URI: 'https://evil.example.com/cb' } }),
      /REDIRECT_URI/
    );
  });
  test('parseEnvFile ignores comments and quotes', () => {
    const d = mkdtempSync(join(tmpdir(), 'ustc-env-'));
    const f = join(d, 'e');
    writeFileSync(f, 'A=1\n# comment\nB="two words"\n\nC=x=y\n');
    const out = parseEnvFile(f);
    assert.deepEqual(out, { A: '1', B: 'two words', C: 'x=y' });
    rmSync(d, { recursive: true, force: true });
  });
  test('live callback path derives from the registered redirect_uri', () => {
    const m = { url: (p) => `http://127.0.0.1:1${p}` };
    const cfg = loadConfig({ env: buildEnv(m) });
    assert.equal(cfg.mode, 'live');
    assert.equal(cfg.callbackPath, '/api/v1/auth/ustc/callback');
  });
  test('refuses callback path that differs from the registered redirect_uri', () => {
    const m = { url: (p) => `http://127.0.0.1:1${p}` };
    assert.throws(
      () => loadConfig({ env: { ...buildEnv(m), USTC_DEMO_CALLBACK_PATH: '/open/redirect' } }),
      /CALLBACK_PATH/
    );
  });
  test('refuses redirect_uri with no callback path', () => {
    const m = { url: (p) => `http://127.0.0.1:1${p}` };
    assert.throws(
      () => loadConfig({ env: { ...buildEnv(m), USTC_DEMO_REDIRECT_URI: `https://${HOST}` } }),
      /REDIRECT_URI/
    );
  });
  test('refuses non-positive session TTL', () => {
    const m = { url: (p) => `http://127.0.0.1:1${p}` };
    assert.throws(
      () => loadConfig({ env: { ...buildEnv(m), USTC_DEMO_SESSION_TTL_MS: '0' } }),
      /SESSION_TTL_MS/
    );
    assert.throws(
      () => loadConfig({ env: { ...buildEnv(m), USTC_DEMO_STATE_TTL_MS: '-5' } }),
      /STATE_TTL_MS/
    );
  });
  test('valid session TTL is honored', () => {
    const m = { url: (p) => `http://127.0.0.1:1${p}` };
    const cfg = loadConfig({ env: { ...buildEnv(m), USTC_DEMO_SESSION_TTL_MS: '3600000' } });
    assert.equal(cfg.sessionTtlMs, 3600000);
    assert.equal(cfg.sessionTtlMs, 36e5);
  });
  test('production config pins official endpoints (no seam, no overrides)', () => {
    const cfg = loadConfig({
      env: {
        USTC_DEMO_HOST: '127.0.0.1',
        USTC_DEMO_PORT: '0',
        USTC_DEMO_CLIENT_ID: 'test-client-id',
        USTC_DEMO_CLIENT_SECRET: 'Z'.repeat(24),
        USTC_DEMO_SESSION_SECRET: 'S'.repeat(32),
        USTC_DEMO_REDIRECT_URI: REDIRECT,
        USTC_DEMO_HTTP_TIMEOUT_MS: '500',
        USTC_DEMO_STATE_TTL_MS: '600000',
      },
    });
    assert.equal(cfg.authorizeUrl, OFFICIAL_ENDPOINTS.authorizeUrl);
    assert.equal(cfg.tokenUrl, OFFICIAL_ENDPOINTS.tokenUrl);
    assert.equal(cfg.profileUrl, OFFICIAL_ENDPOINTS.profileUrl);
    assert.equal(cfg.logoutUrl, OFFICIAL_ENDPOINTS.logoutUrl);
  });
  test('endpoint override without TEST_SEAM is refused', () => {
    const m = { url: (p) => `http://127.0.0.1:1${p}` };
    const env = buildEnv(m);
    delete env.USTC_DEMO_TEST_SEAM;
    assert.throws(
      () => loadConfig({ env: { ...env, USTC_DEMO_PROFILE_URL: 'https://evil.example.com/x' } }),
      /TEST_SEAM/
    );
  });
  test('endpoint override with TEST_SEAM is accepted', () => {
    const m = { url: (p) => `http://127.0.0.1:1${p}` };
    const cfg = loadConfig({ env: { ...buildEnv(m), USTC_DEMO_PROFILE_URL: 'https://seam.test/p' } });
    assert.equal(cfg.profileUrl, 'https://seam.test/p');
    assert.equal(cfg.authorizeUrl, `http://127.0.0.1:1/cas/oauth2.0/authorize`);
  });
  test('invalid URL override is refused even with TEST_SEAM', () => {
    const m = { url: (p) => `http://127.0.0.1:1${p}` };
    assert.throws(
      () => loadConfig({ env: { ...buildEnv(m), USTC_DEMO_PROFILE_URL: 'not a url' } }),
      /URL/
    );
  });
});

describe('state store', () => {
  test('ok then replay returns unknown (single use)', () => {
    const s = new StateStore('k'.repeat(32), { ttlMs: 1000 });
    const { token } = s.issue();
    assert.equal(s.consume(token), 'ok');
    assert.equal(s.consume(token), 'unknown');
  });
  test('expired token rejected', () => {
    const now = { v: Date.now() };
    const s = new StateStore('k'.repeat(32), { ttlMs: 1000, now: () => now.v });
    const { token } = s.issue();
    now.v += 5000;
    assert.equal(s.consume(token), 'expired');
  });
  test('tampered mac rejected', () => {
    const s = new StateStore('k'.repeat(32), { ttlMs: 1000 });
    const { token } = s.issue();
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    assert.equal(s.consume(tampered), 'mismatch');
  });
  test('malformed rejected', () => {
    const s = new StateStore('k'.repeat(32));
    assert.equal(s.consume('garbage'), 'malformed');
    assert.equal(s.consume('a.b'), 'malformed');
    assert.equal(s.consume(42), 'malformed');
  });
  test('issue sweeps expired nonces to bound memory', () => {
    const now = { v: 1000000 };
    const s = new StateStore('k'.repeat(32), { ttlMs: 1000, now: () => now.v });
    const first = s.issue();
    now.v += 2000;
    const second = s.issue();
    assert.equal(s.active.size, 1, 'sweep pruned the expired nonce, only the live one remains');
    assert.equal(s.consume(second.token), 'ok');
    assert.equal(s.active.size, 0, 'live nonce consumed (single-use)');
    assert.equal(s.consume(first.token), 'unknown'); // swept before it could be consumed
  });
});

describe('session store', () => {
  test('entry expires after TTL', () => {
    const now = { v: 1000000 };
    const s = new SessionStore({ ttlMs: 1000, now: () => now.v });
    const id = s.create('h');
    assert.ok(s.get(id));
    now.v += 999;
    assert.ok(s.get(id));
    now.v += 2;
    assert.equal(s.get(id), undefined);
  });
  test('create sweeps expired entries to bound the map', () => {
    const now = { v: 1000000 };
    const s = new SessionStore({ ttlMs: 1000, now: () => now.v });
    const oldId = s.create('h1');
    now.v += 2000;
    const id = s.create('h2');
    assert.equal(s.get(oldId), undefined, 'expired entry gone');
    assert.ok(s.get(id), 'fresh entry alive');
    assert.equal(s.map.size, 1);
  });
  test('destroy removes the entry (logout invalidation)', () => {
    const s = new SessionStore({ ttlMs: 3600000 });
    const id = s.create('h');
    assert.ok(s.get(id));
    s.destroy(id);
    assert.equal(s.get(id), undefined);
  });
});

describe('account store integrity', () => {
  test('corrupt store fails closed: 400, file byte-for-byte untouched', async () => {
    const mock = await startMock();
    const raw = '{"not valid json !!!';
    const app = await startApp(buildEnv(mock), { rawPreSeed: raw });
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 400);
      assert.equal(readFileSync(join(app.dataDir, 'accounts.json'), 'utf8'), raw);
    } finally {
      await app.close();
      await mock.close();
    }
  });
  test('tampered store MAC fails closed: 400, file untouched', async () => {
    const mock = await startMock();
    const envl = { v: 1, mac: '0'.repeat(32), data: {} };
    const app = await startApp(buildEnv(mock), { rawPreSeed: JSON.stringify(envl) });
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 400);
      assert.deepEqual(JSON.parse(readFileSync(join(app.dataDir, 'accounts.json'), 'utf8')), envl);
    } finally {
      await app.close();
      await mock.close();
    }
  });
  test('planted symlink at the store path fails closed, target never written through', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock), { symlinkStore: true });
    try {
      // readFileSync follows the symlink: 'ORIGINAL' is not an envelope, so load()
      // fails closed (400) and no save ever runs — the external target is never written.
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 400);
      assert.equal(
        readFileSync(join(app.dataDir, 'outside-target.json'), 'utf8'),
        'ORIGINAL',
        'symlink target must remain untouched'
      );
      assert.equal(lstatSync(join(app.dataDir, 'accounts.json')).isSymbolicLink(), true);
    } finally {
      await app.close();
      await mock.close();
    }
  });
  test('subject reappearing with a different campus id refuses takeover', async () => {
    const mock = await startMock();
    const secret = 'S'.repeat(32);
    const data = {
      [`ustc:${hmacHex(secret, 'ustc', FIXTURE.attributes.gid)}`]: {
        provider: 'ustc', handle: 'u00000000', subjectHmac: 'x',
        campusIdPresent: true, campusIdHmac: 'different-hmac-known-to-attacker',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const app = await startApp(buildEnv(mock), {
      preSeed: data,
    });
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 400, 'conflicting campus id must refuse');
      assert.deepEqual(accounts(app), data, 'store untouched');
    } finally {
      await app.close();
      await mock.close();
    }
  });
});

describe('readiness mode', () => {
  test('/login returns 503 and never initiates OAuth', async () => {
    const mock = await startMock();
    try {
      const env = buildEnv(mock);
      delete env.USTC_DEMO_CLIENT_ID;
      delete env.USTC_DEMO_CLIENT_SECRET;
      delete env.USTC_DEMO_SESSION_SECRET;
      delete env.USTC_DEMO_REDIRECT_URI;
      const app = await startApp(env);
      try {
        const health = await rawGet(app.port, '/health');
        assert.equal(health.status, 200);
        assert.ok(health.body.includes('readiness'));
        const login = await rawGet(app.port, '/login');
        assert.equal(login.status, 503);
        assert.equal(mock.calls.token, 0);
        assert.equal(mock.calls.profile, 0);
      } finally {
        await app.close();
      }
    } finally {
      await mock.close();
    }
  });
});

describe('full login', () => {
  test('success with opaque token: account created, redacted page and store', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      const { cb, state } = await fullLogin(app);
      assert.equal(cb.status, 200);
      const html = cb.body;
      assert.ok(html.includes('登录成功'));
      assert.ok(html.includes('已自动建档'));
      assert.ok(html.includes('opaque'));
      assert.ok(html.includes('attributes.gid'));
      assert.ok(html.includes('attributes.zjhm'));
      assert.ok(html.includes('校园身份号（学工号）字段'));
      assert.ok(/内部句柄（脱敏）：<code>u[0-9a-f]{8}<\/code>/.test(html));

      // No raw identity values anywhere on the page.
      for (const secret of [FIXTURE.gid, FIXTURE.id, FIXTURE.attributes.email, FIXTURE.attributes.name]) {
        assert.ok(!html.includes(secret), `page must not leak ${secret}`);
      }

      const acc = accounts(app);
      const keys = Object.keys(acc);
      assert.equal(keys.length, 1);
      const rec = acc[keys[0]];
      assert.equal(rec.provider, 'ustc');
      assert.equal(rec.campusIdPresent, true);
      // Store must not contain plaintext identifiers.
      const raw = JSON.stringify(acc);
      for (const secret of [FIXTURE.gid, FIXTURE.id, FIXTURE.attributes.email]) {
        assert.ok(!raw.includes(secret), `store must not leak ${secret}`);
      }

      // Permissions: file 0600, dir 0700.
      const fileMode = statSync(join(app.dataDir, 'accounts.json')).mode & 0o777;
      const dirMode = statSync(app.dataDir).mode & 0o777;
      assert.equal(fileMode, 0o600);
      assert.equal(dirMode, 0o700);

      assert.equal(mock.calls.token, 1);
      assert.equal(mock.calls.profile, 1);
      assert.ok(state.length >= 40, 'state must be high entropy');
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('same subject on re-login links, does not duplicate', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      const first = await fullLogin(app);
      const second = await fullLogin(app);
      assert.equal(first.cb.status, 200);
      assert.equal(second.cb.status, 200);
      assert.ok(first.cb.body.includes('已自动建档'));
      assert.ok(second.cb.body.includes('已匹配既有账户'));
      assert.equal(Object.keys(accounts(app)).length, 1);
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('unrelated pre-existing local account is never taken over', async () => {
    const profileBody = {
      active: true,
      id: FIXTURE.id,
      client_id: 'test',
      attributes: { ...FIXTURE.attributes }, // same email/name released — must still not merge
    };
    const mock = await startMock({ profileBody });
    const preSeed = {
      'local:aa11deadbeef': {
        provider: 'local', handle: 'ldeadbeef', campusIdPresent: true,
        campusIdHmac: 'ignored', createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const app = await startApp(buildEnv(mock), { preSeed });
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 200);
      const acc = accounts(app);
      assert.equal(acc['local:aa11deadbeef'].handle, 'ldeadbeef', 'local account untouched');
      assert.equal(Object.keys(acc).length, 2, 'new USTC account separate, never merged');
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('missing stable id (no gid/id) aborts provisioning', async () => {
    const mock = await startMock({
      profileBody: { active: true, attributes: { email: FIXTURE.attributes.email, name: '演示' } },
    });
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 400);
      assert.ok(cb.body.includes('未发布稳定身份字段'));
      assert.deepEqual(accounts(app), {});
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('token endpoint failure -> safe 400, no profile call', async () => {
    const mock = await startMock({ tokenStatus: 401 });
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 400);
      assert.ok(cb.body.includes('认证失败'));
      assert.equal(mock.calls.profile, 0);
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('profile endpoint failure -> safe 400', async () => {
    const mock = await startMock({ profileStatus: 500 });
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 400);
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('timeout on token endpoint -> safe 400 and timeout log', async () => {
    const mock = await startMock({ tokenDelayMs: 1500 });
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 400);
      assert.ok(app.logs.some((l) => l.includes('token_exchange:timeout')), 'timeout must be logged');
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('JWT-shaped token: classified, claims named, signature never shown', async () => {
    const mock = await startMock({ tokenShape: 'jwt' });
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 200);
      const html = cb.body;
      assert.ok(html.includes('jwt-jws'));
      assert.ok(html.includes('RS256'));
      for (const claim of ['jti', 'iss', 'aud', 'sub', 'exp', 'iat', 'nbf', 'client_id', 'at_hash', 'preferred_username']) {
        assert.ok(html.includes(claim), `claim name ${claim} expected`);
      }
      assert.ok(!html.includes('demo-sub'), 'claim values must not appear');
      assert.ok(!html.includes('a'.repeat(43)), 'signature must not appear');
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('state protection: missing, mismatch, replay', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      // Missing state
      const missing = await rawGet(app.port, '/api/v1/auth/ustc/callback?code=mockcode');
      assert.equal(missing.status, 400);
      // Mismatched state (no cookie set)
      const mismatch = await rawGet(app.port, '/api/v1/auth/ustc/callback?code=mockcode&state=stolen-value');
      assert.equal(mismatch.status, 400);
      assert.equal(mock.calls.token, 0);
      // Success then replay of same state
      const { cb, state } = await fullLogin(app);
      assert.equal(cb.status, 200);
      assert.equal(mock.calls.token, 1);
      const replay = await rawGet(
        app.port,
        `/api/v1/auth/ustc/callback?code=mockcode&state=${encodeURIComponent(state)}`,
        { host: HOST, cookie: String(cb.headers['set-cookie'] || '').split(';')[0] }
      );
      assert.equal(replay.status, 400);
      assert.equal(mock.calls.token, 1, 'replay must not reach token exchange');
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('invalid callback host rejected before any provider call', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      const res = await rawGet(app.port, '/api/v1/auth/ustc/callback?code=x&state=y', { host: 'evil.example.com' });
      assert.equal(res.status, 400);
      assert.equal(mock.calls.token, 0);
      assert.equal(mock.calls.profile, 0);
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('X-Forwarded-Host forgery cannot bypass the host guard', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      // Forged XFH with a wrong real Host: still rejected before the provider.
      const forged = await rawGet(app.port, '/api/v1/auth/ustc/callback?code=x&state=y', {
        host: 'evil.example.com',
        'x-forwarded-host': HOST,
      });
      assert.equal(forged.status, 400);
      assert.equal(mock.calls.token, 0);
      // Real Host with forged XFH: reaches the guard only (state gate fails next).
      const real = await rawGet(app.port, '/api/v1/auth/ustc/callback?code=x&state=y', {
        host: HOST,
        'x-forwarded-host': 'evil.example.com',
      });
      assert.equal(real.status, 400);
      assert.equal(mock.calls.token, 0, 'X-Forwarded-Host must never be consulted');
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('callback served only at the exact registered path', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock, { USTC_DEMO_REDIRECT_URI: `https://${HOST}/custom/cb` }));
    try {
      // The default path is no longer mounted once a different callback is registered.
      const notFound = await rawGet(app.port, '/api/v1/auth/ustc/callback?code=x&state=y');
      assert.equal(notFound.status, 404);
      // The registered path is mounted: state gate fails (400) before any provider call.
      const mounted = await rawGet(app.port, '/custom/cb?code=x&state=y');
      assert.equal(mounted.status, 400);
      assert.equal(mock.calls.token, 0);
      assert.equal(mock.calls.profile, 0);
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('logs never contain tokens, codes, state, or identity values', async () => {
    const mock = await startMock({ tokenShape: 'jwt' });
    const app = await startApp(buildEnv(mock));
    try {
      const { cb, state } = await fullLogin(app);
      assert.equal(cb.status, 200);
      const logText = app.logs.join('\n');
      const token = 'AT-mock-' + 'x'.repeat(40);
      const jwtSig = 'a'.repeat(43);
      for (const secret of [token, jwtSig, 'mockcode', state, FIXTURE.gid, FIXTURE.id, FIXTURE.attributes.email, FIXTURE.attributes.zjhm]) {
        assert.ok(!logText.includes(secret), `log must not contain ${secret}`);
      }
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('cookies are HttpOnly, SameSite=Lax and Secure', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      const start = await rawGet(app.port, '/login', { host: HOST });
      const startSet = String(start.headers['set-cookie'] || '');
      assert.match(startSet, /HttpOnly/);
      assert.match(startSet, /SameSite=Lax/);
      assert.match(startSet, /Secure/);
      const { cb } = await fullLogin(app);
      const cbSet = String(cb.headers['set-cookie'] || '');
      assert.match(cbSet, /HttpOnly/);
      assert.match(cbSet, /SameSite=Lax/);
      assert.match(cbSet, /Secure/);
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('identity provider error query aborts safely and invalidates the session', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      // Establish a real session first, then prove the failed callback kills it.
      const good = await fullLogin(app);
      const sidCookie = String(good.cb.headers['set-cookie'] || '').split(';')[0];
      const meBefore = await rawGet(app.port, '/me', { host: HOST, cookie: sidCookie });
      assert.equal(meBefore.status, 200);
      assert.ok(meBefore.body.includes('登录成功：内部句柄'), 'session handle visible before invalidation');
      const tokensBefore = mock.calls.token;

      const start = await rawGet(app.port, '/login', { host: HOST });
      const state = new URL(start.headers.location).searchParams.get('state');
      const stateCookie = String(start.headers['set-cookie'] || '').split(';')[0];

      // Error param with a valid state: 400, session destroyed, cookie cleared, no IdP calls.
      const cb = await rawGet(
        app.port,
        `/api/v1/auth/ustc/callback?error=access_denied&state=${encodeURIComponent(state)}`,
        { host: HOST, cookie: `${stateCookie}; ${sidCookie}` }
      );
      assert.equal(cb.status, 400);
      assert.ok(cb.body.includes('身份源返回错误'));
      assert.match(String(cb.headers['set-cookie'] || ''), /Max-Age=0/, 'session cookie must be cleared');
      assert.equal(mock.calls.token, tokensBefore, 'no token exchange on the error path');

      // The previously valid session handle no longer resolves.
      const meAfter = await rawGet(app.port, '/me', { host: HOST, cookie: sidCookie });
      assert.equal(meAfter.status, 200);
      assert.ok(meAfter.body.includes('未登录'), 'session must be destroyed after failed callback');
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('no campus id released: success, account without campus identifier', async () => {
    const mock = await startMock({
      profileBody: {
        active: true,
        client_id: 'test',
        attributes: { gid: FIXTURE.attributes.gid, email: FIXTURE.attributes.email, name: '演示' },
      },
    });
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 200);
      assert.ok(cb.body.includes('未发布'));
      assert.ok(!cb.body.includes('已发布'));
      const acc = accounts(app);
      const rec = Object.values(acc)[0];
      assert.equal(rec.campusIdPresent, false);
      assert.equal(rec.campusIdHmac, null);
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('timeout on profile endpoint -> safe 400 and timeout log', async () => {
    const mock = await startMock({ profileDelayMs: 1500 });
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 400);
      assert.ok(app.logs.some((l) => l.includes('profile:timeout')), 'profile timeout must be logged');
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('token response over Content-Length cap is rejected', async () => {
    const mock = await startMock({
      tokenRawBody: JSON.stringify({ access_token: 'x'.repeat(9000), token_type: 'bearer', expires_in: 28800 }),
    });
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 400);
      assert.ok(app.logs.some((l) => l.includes('token_exchange:response_too_large')), 'cap rejection logged');
      assert.equal(mock.calls.profile, 0);
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('chunked profile response over stream cap is rejected mid-body', async () => {
    const mock = await startMock({
      profileRawBody: JSON.stringify({ active: true, attributes: { gid: 'x'.repeat(20000) } }),
      chunkedProfile: true,
    });
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 400);
      assert.ok(app.logs.some((l) => l.includes('profile:response_too_large')), 'stream cap rejection logged');
    } finally {
      await app.close();
      await mock.close();
    }
  });
});

describe('self profile page', () => {
  const FULL_CSP =
    "default-src 'none'; script-src 'none'; img-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  function sidOf(res) {
    return String(res.headers['set-cookie'] || '').split(';')[0];
  }

  test('unauthenticated and forged-session requests are denied without data', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      const anon = await rawGet(app.port, '/profile', { host: HOST });
      assert.equal(anon.status, 200);
      assert.ok(anon.body.includes('未登录'));
      assert.ok(!anon.body.includes(FIXTURE.attributes.name), 'no profile data for anonymous');
      // Forged/tampered session id resolves to no session.
      const forged = await rawGet(app.port, '/profile', { host: HOST, cookie: 'ustc_demo_sid=forged' });
      assert.equal(forged.status, 200);
      assert.ok(forged.body.includes('未登录'));
      assert.ok(!forged.body.includes(FIXTURE.attributes.name));
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('wrong host is rejected even with a valid session', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      const res = await rawGet(app.port, '/profile', { host: 'evil.example.com', cookie: sidOf(cb) });
      assert.equal(res.status, 403);
      assert.ok(!res.body.includes(FIXTURE.attributes.name), 'no data on wrong host');
      // Denials carry the same immutable security headers as the success page.
      assert.equal(String(res.headers['content-security-policy'] || ''), FULL_CSP, 'exact full CSP, no dropped directive');
      assert.equal(String(res.headers['referrer-policy'] || ''), 'no-referrer');
      assert.equal(String(res.headers['x-content-type-options'] || ''), 'nosniff');
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('allowlisted values shown to the owner, non-allowlisted fields name/type only', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      const res = await rawGet(app.port, '/profile', { host: HOST, cookie: sidOf(cb) });
      assert.equal(res.status, 200);
      const html = res.body;
      for (const v of [FIXTURE.attributes.name, FIXTURE.attributes.zjhm, FIXTURE.attributes.gid, FIXTURE.attributes.email]) {
        assert.ok(html.includes(v), `allowlisted value visible to owner: ${v}`);
      }
      // Non-allowlisted fields: name/type present in the summary, value never retained.
      assert.ok(html.includes('attributes.deptCode'));
      assert.ok(html.includes('attributes.login'));
      assert.ok(!html.includes(FIXTURE.attributes.deptCode), 'deptCode value must not be retained');
      assert.ok(html.includes('值未保留'));
      assert.ok(html.includes('Demo 专用'));
      assert.ok(html.includes('仅内存'));
      // Restrictive headers.
      assert.equal(String(res.headers['content-security-policy'] || ''), FULL_CSP, 'exact full CSP, no dropped directive');
      assert.equal(String(res.headers['referrer-policy'] || ''), 'no-referrer');
      assert.equal(String(res.headers['x-content-type-options'] || ''), 'nosniff');
      assert.equal(String(res.headers['cache-control'] || ''), 'no-store');
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('unsafe allowlisted value is escaped (no script execution)', async () => {
    const profileBody = {
      active: true,
      id: FIXTURE.id,
      client_id: 'test',
      attributes: { ...FIXTURE.attributes, name: "<script>alert('xss')</script>" },
    };
    const mock = await startMock({ profileBody });
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      const res = await rawGet(app.port, '/profile', { host: HOST, cookie: sidOf(cb) });
      const html = res.body;
      assert.ok(html.includes('&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;'), 'value must be HTML-escaped');
      assert.ok(!html.includes('<script>alert'), 'raw script tag must never appear rendered');
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('expired session denies profile access', async () => {
    const mock = await startMock();
    const now = { v: Date.now() };
    const app = await startApp(buildEnv(mock, { USTC_DEMO_SESSION_TTL_MS: '60000' }), { now: () => now.v });
    try {
      const { cb } = await fullLogin(app);
      const sid = sidOf(cb);
      const before = await rawGet(app.port, '/profile', { host: HOST, cookie: sid });
      assert.ok(before.body.includes(FIXTURE.attributes.name), 'live session sees profile');
      now.v += 61 * 1000;
      const after = await rawGet(app.port, '/profile', { host: HOST, cookie: sid });
      assert.ok(after.body.includes('未登录'));
      assert.ok(!after.body.includes(FIXTURE.attributes.name), 'expired session shows nothing');
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('logout discards the retained profile', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      const sid = sidOf(cb);
      const before = await rawGet(app.port, '/profile', { host: HOST, cookie: sid });
      assert.ok(before.body.includes(FIXTURE.attributes.name));
      await rawGet(app.port, '/logout', { host: HOST, cookie: sid });
      const after = await rawGet(app.port, '/profile', { host: HOST, cookie: sid });
      assert.ok(after.body.includes('未登录'));
      assert.ok(!after.body.includes(FIXTURE.attributes.name));
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('profile retention never persists to the account store or logs', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      await rawGet(app.port, '/profile', { host: HOST, cookie: sidOf(cb) });
      const raw = JSON.stringify(accounts(app));
      for (const v of [FIXTURE.attributes.name, FIXTURE.attributes.zjhm, FIXTURE.attributes.email, FIXTURE.attributes.gid]) {
        assert.ok(!raw.includes(v), `store must not contain ${v}`);
      }
      const logText = app.logs.join('\n');
      for (const v of [FIXTURE.attributes.name, FIXTURE.attributes.zjhm, FIXTURE.attributes.email, FIXTURE.attributes.gid]) {
        assert.ok(!logText.includes(v), `logs must not contain ${v}`);
      }
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('success page advertises the self-profile route and its in-memory semantics', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      assert.equal(cb.status, 200);
      assert.ok(cb.body.includes('/profile'));
      assert.ok(cb.body.includes('服务器内存'));
      assert.ok(cb.body.includes('不写入文件'));
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('malformed cookie and malformed Host are contained; server stays healthy', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      // Malformed percent-encoding in the session cookie must not crash the request path.
      const badCookie = await rawGet(app.port, '/profile', { host: HOST, cookie: 'ustc_demo_sid=%zz; other=x' });
      assert.equal(badCookie.status, 200);
      assert.ok(badCookie.body.includes('未登录'));
      // Malformed Host header must be contained by the handler's error boundary.
      const badHost = await rawGet(app.port, '/profile', { host: 'x:99999' });
      assert.ok([400, 403].includes(badHost.status), `contained status, got ${badHost.status}`);
      // Both cases leave the server fully functional.
      const health = await rawGet(app.port, '/health', { host: HOST });
      assert.equal(health.status, 200);
      assert.match(health.body, /"ok":true/);
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('X-Forwarded-Host never overrides the real Host on /profile', async () => {
    const mock = await startMock();
    const app = await startApp(buildEnv(mock));
    try {
      const { cb } = await fullLogin(app);
      const sid = sidOf(cb);
      // Real Host correct + spoofed X-Forwarded-Host: session owner is still authorized.
      const ok = await rawGet(app.port, '/profile', { host: HOST, cookie: sid, 'x-forwarded-host': 'evil.example.com' });
      assert.equal(ok.status, 200);
      assert.ok(ok.body.includes(FIXTURE.attributes.name));
      // Real Host wrong even with a plausible X-Forwarded-Host: denied.
      const denied = await rawGet(app.port, '/profile', { host: 'evil.example.com', cookie: sid, 'x-forwarded-host': HOST });
      assert.equal(denied.status, 403);
      assert.ok(!denied.body.includes(FIXTURE.attributes.name));
    } finally {
      await app.close();
      await mock.close();
    }
  });
});

describe('session store sweep', () => {
  test('any session access discards stale unrelated retained profiles', () => {
    const now = { v: 1000 };
    const st = new SessionStore({ ttlMs: 100, now: () => now.v });
    const a = st.create('h1', { retained: [{ path: 'attributes.name', label: '姓名', type: 'string', value: 'secret-value' }] });
    const b = st.create('h2');
    now.v = 1200; // both expired
    st.get(b); // access sweeps every expired record, not just the requested one
    assert.equal(st.map.has(a), false, 'stale retained profile must be swept on any access');
    assert.equal(st.map.size, 0);
  });
});
