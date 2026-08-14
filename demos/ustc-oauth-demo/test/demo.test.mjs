// Offline tests for the USTC OAuth2 demo: full flows against a mock IdP plus state/config/security units.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { loadConfig, parseEnvFile } from '../lib/config.mjs';
import { StateStore } from '../lib/state.mjs';
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

async function startApp(env, { preSeed } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ustc-demo-'));
  const dataDir = join(dir, 'data');
  if (preSeed) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify(preSeed), { mode: 0o600 });
  }
  const cfg = loadConfig({ env: { ...env, USTC_DEMO_DATA_DIR: dataDir } });
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
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
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
});