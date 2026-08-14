// Offline mock USTC IdP for tests (token + profile endpoints), configurable per-test.
import { createServer } from 'node:http';

export const FIXTURE = {
  id: 'ID-DEMO-0001',
  attributes: {
    deptCode: '304',
    email: 'demo.invalid@example.invalid',
    gid: 'GID-DEMO-0001',
    login: 'ID-DEMO-0001',
    name: '演示用户',
    zjhm: 'ZJ-DEMO-0001',
  },
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function fakeJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({
    jti: 'ST-demo',
    iss: 'https://id.ustc.edu.cn/cas/oidc',
    aud: 'demo',
    sub: 'demo-sub',
    exp: now + 3600,
    iat: now,
    nbf: now,
    client_id: 'demo',
    at_hash: 'abc123',
    preferred_username: 'demo-user',
  });
  return `${header}.${payload}.${'a'.repeat(43)}`;
}

export function startMock(opts = {}) {
  const {
    tokenDelayMs = 0,
    profileDelayMs = 0,
    tokenStatus = 200,
    profileStatus = 200,
    tokenBody = null,
    profileBody = null,
    tokenRawBody = null,
    profileRawBody = null,
    chunkedProfile = false,
    tokenShape = 'opaque',
  } = opts;
  const calls = { token: 0, profile: 0 };

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    const u = new URL(req.url, 'http://mock');

    if (u.pathname.endsWith('/accessToken')) {
      calls.token += 1;
      if (tokenDelayMs) await new Promise((r) => setTimeout(r, tokenDelayMs));
      if (tokenStatus !== 200) {
        res.writeHead(tokenStatus, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      if (tokenRawBody !== null) {
        // Single end() => Node sets Content-Length; exercises the CL cap path.
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(tokenRawBody);
      }
      let token = '';
      if (tokenShape === 'jwt') token = fakeJwt();
      else if (tokenShape !== 'none') token = `AT-mock-${'x'.repeat(40)}`;
      const out = tokenBody || { access_token: token, token_type: 'bearer', expires_in: 28800 };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }

    if (u.pathname.endsWith('/profile')) {
      calls.profile += 1;
      if (profileDelayMs) await new Promise((r) => setTimeout(r, profileDelayMs));
      if (profileStatus !== 200) {
        res.writeHead(profileStatus, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      if (profileRawBody !== null) {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (chunkedProfile) {
          // No Content-Length, multiple writes => chunked transfer; exercises the stream cap path.
          const mid = profileRawBody.length >> 1;
          res.write(profileRawBody.slice(0, mid));
          res.write(profileRawBody.slice(mid));
          return res.end();
        }
        return res.end(profileRawBody);
      }
      const out =
        profileBody || { active: true, id: FIXTURE.id, client_id: 'test', attributes: FIXTURE.attributes };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }

    res.writeHead(404);
    res.end('nope');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        url: (p) => `http://127.0.0.1:${port}${p}`,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}