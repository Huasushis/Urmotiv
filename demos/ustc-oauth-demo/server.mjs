// Minimal standalone USTC OAuth2 login demo server (Node 24 built-ins only).
// Modes: 'readiness' (never initiates OAuth) when institutional config is absent; 'live' otherwise.
// See README.md for institutional registration prerequisites and reverse-proxy mapping.

import { createServer } from 'node:http';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { loadConfig } from './lib/config.mjs';
import { StateStore } from './lib/state.mjs';
import { authorizeUrl, exchangeCode, fetchProfile, AppError } from './lib/oauth.mjs';
import { classifyToken, profileSummary, retainProfile } from './lib/redact.mjs';
import { AccountStore, subjectBinding, hmacHex } from './lib/accounts.mjs';
import { SessionStore } from './lib/sessions.mjs';

const STATE_COOKIE = 'ustc_demo_state';
const SESSION_COOKIE = 'ustc_demo_sid';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;
  return { status, html };
}

// Authenticated self-profile page: shows the OWN session holder's USTC profile fields.
// Only allowlisted fields carry values (kept in the in-memory session, never on disk or
// in logs); all other returned fields appear as name/type with their value discarded.
// Restrictive CSP/referrer protections; no scripts, images, forms, or frames.
function profilePage(s) {
  const allowed = (s.retained || [])
    .map(
      (f) =>
        `<tr><td>${esc(f.label)}</td><td><code>${esc(f.path)}</code></td><td><code>${esc(f.type)}</code></td><td><code>${esc(f.value)}</code></td></tr>`
    )
    .join('');
  const others = (s.others || [])
    .map(
      (f) =>
        `<tr><td><code>${esc(f.name)}</code></td><td><code>${esc(f.type)}</code></td><td>值未保留</td></tr>`
    )
    .join('');
  const body =
    `<h1>我的 USTC 资料</h1>` +
    `<p><strong>Demo 专用</strong>：仅你本人可见；白名单字段的值只保存在服务器内存中，不写入文件、不记日志，退出登录或会话过期即丢弃。</p>` +
    `<h2>白名单字段（值已保留，仅内存）</h2>` +
    `<table border="1" cellspacing="0" cellpadding="4"><tbody>${allowed || '<tr><td>（无）</td></tr>'}</tbody></table>` +
    `<h2>其他返回字段（仅字段名与类型，值未保留）</h2>` +
    `<table border="1" cellspacing="0" cellpadding="4"><tbody>${others || '<tr><td>（无）</td></tr>'}</tbody></table>` +
    `<p><a href="/">首页</a> | <a href="/logout">退出登录（立即丢弃本次资料）</a></p>`;
  const p = page('我的 USTC 资料', body);
  p.headers = {
    'content-security-policy':
      "default-src 'none'; script-src 'none'; img-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
  return p;
}

export function createApp(cfg, { log = console } = {}) {
  const states = new StateStore(cfg.sessionSecret, { ttlMs: cfg.stateTtlMs });
  const sessions = new SessionStore({ ttlMs: cfg.sessionTtlMs, now: cfg.now });
  const accounts = cfg.dataDir ? new AccountStore(join(cfg.dataDir, 'accounts.json'), cfg.sessionSecret) : null;
  const redirect = cfg.redirectUri ? new URL(cfg.redirectUri) : null;

  function logline(kind, detail) {
    log.log(JSON.stringify({ t: new Date().toISOString(), kind, ...detail }));
  }

  function cookie(name, value, { maxAge } = {}) {
    const bits = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (cfg.secureCookies) bits.push('Secure');
    if (maxAge !== undefined) bits.push(`Max-Age=${maxAge}`);
    return bits.join('; ');
  }

  function readCookies(req) {
    const out = {};
    const raw = req.headers.cookie;
    if (!raw) return out;
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return out;
  }

  // Host guard: only the real Host header of the registered redirect host is trusted.
  // X-Forwarded-* is never accepted (the demo binds loopback; a forwarding proxy must
  // preserve Host). Shared by the callback and the authenticated self-profile page.
  function hostMatches(req, redirect) {
    if (!redirect) return false;
    const hostHeader = (req.headers.host || '').split(':')[0].toLowerCase();
    return hostHeader === redirect.hostname.toLowerCase();
  }

  // Safe invalidation on callback/logout errors: destroys the browser session and
  // clears its cookie, then writes the error page directly.
  function fail(req, res, status, bodyHtml, why) {
    const sid = readCookies(req)[SESSION_COOKIE];
    if (sid) sessions.destroy(sid);
    logline('callback_rejected', { why });
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }),
    });
    res.end(bodyHtml);
    return null;
  }

  async function callback(req, res, url) {
    if (cfg.mode !== 'live') {
      return fail(req, res, 503, page('只读', '<p>就绪模式，不接受回调。</p>').html, 'readiness');
    }
    // Host guard: only the real Host header is trusted. X-Forwarded-* is never
    // accepted (the demo binds loopback; a forwarding proxy must preserve Host).
    if (!hostMatches(req, redirect)) {
      return fail(req, res, 400, page('拒绝', '<p>回调主机与注册地址不一致。</p>').html, 'host_mismatch');
    }

    const cookies = readCookies(req);
    const state = url.searchParams.get('state');
    const cookieState = cookies[STATE_COOKIE];
    if (!state || !cookieState || state !== cookieState) {
      return fail(req, res, 400, page('失败', '<p>state 校验失败。</p>').html, 'state_missing_or_mismatch');
    }
    const verdict = states.consume(state);
    if (verdict !== 'ok') {
      return fail(req, res, 400, page('失败', '<p>state 无效、已使用或已过期。</p>').html, `state_${verdict}`);
    }

    if (url.searchParams.get('error')) {
      return fail(req, res, 400, page('失败', '<p>身份源返回错误（细节不展示）。</p>').html, 'idp_error_parameter');
    }
    const code = url.searchParams.get('code');
    if (!code) {
      return fail(req, res, 400, page('失败', '<p>缺少授权码。</p>').html, 'no_code');
    }

    const { accessToken } = await exchangeCode(cfg, code);
    const profile = await fetchProfile(cfg, accessToken);

    // Stable subject: attributes.gid preferred, then top-level id (both documented immutable).
    const attrs = profile.attributes && typeof profile.attributes === 'object' ? profile.attributes : {};
    const gid = typeof attrs.gid === 'string' && attrs.gid.length > 0 ? attrs.gid : '';
    const id = typeof profile.id === 'string' && profile.id.length > 0 ? profile.id : '';
    const subject = gid || id;
    if (!subject) {
      return fail(req, res, 400, page('失败', '<p>身份源未发布稳定身份字段（gid/id），无法建档。请管理员确认属性配置。</p>').html, 'missing_stable_id');
    }
    const binding = subjectBinding(cfg.sessionSecret, subject);

    // Campus identifier (学工号): top-level id, then attributes.zjhm / attributes.jrzjhm.
    const campusId =
      typeof profile.id === 'string' && profile.id.length > 0
        ? profile.id
        : typeof attrs.zjhm === 'string' && attrs.zjhm.length > 0
          ? attrs.zjhm
          : typeof attrs.jrzjhm === 'string' && attrs.jrzjhm.length > 0
            ? attrs.jrzjhm
            : '';
    const campusIdHmac = campusId ? hmacHex(cfg.sessionSecret, 'ustc-campus', campusId) : null;

    const { account, created } = accounts.linkOrCreate(binding, {
      campusIdPresent: Boolean(campusId),
      campusIdHmac,
    });

    const sid = sessions.create(account.handle, retainProfile(profile));
    const tokenInfo = classifyToken(accessToken);
    const summary = profileSummary(profile);
    logline('login_success', {
      handle: account.handle,
      created,
      tokenFormat: tokenInfo.format,
      profileClaimCount: summary.claims.length,
    });

    const lines = [];
    lines.push(`<h1>登录成功</h1>`);
    lines.push(`<p>${created ? '已自动建档' : '已匹配既有账户'}</p>`);
    lines.push(`<p>内部句柄（脱敏）：<code>${esc(account.handle)}</code></p>`);
    lines.push(`<p>令牌格式：<code>${esc(tokenInfo.format)}</code></p>`);
    if (tokenInfo.format === 'jwt-jws') {
      lines.push(`<p>JWT/JWS 算法：<code>${esc(tokenInfo.alg)}</code>（仅结构分析，未离线验签；无 JWKS）</p>`);
      lines.push(`<p>JWT 声明（仅名称/类型）：</p><ul>` +
        tokenInfo.claims.map((c) => `<li>${esc(c.name)} : ${esc(c.type)}${c.semantic ? '（语义字段）' : ''}</li>`).join('') + `</ul>`);
    }
    lines.push(`<p>Profile 字段（仅名称/类型）：</p><ul>` +
      summary.claims.map((c) => `<li>${esc(c.name)} : ${esc(c.type)}</li>`).join('') + `</ul>`);
    lines.push(`<p>校园身份号（学工号）字段：<code>${campusId ? '已发布（值不展示）' : '未发布'}</code></p>`);
    lines.push(`<p><a href="/profile">查看我自己的真实资料字段（demo 专用）</a></p>`);
    lines.push(
      `<p>资料页说明：仅本次登录会话可见；白名单字段的值只保存在服务器内存中，不写入文件、不记日志，退出登录或会话过期即丢弃。</p>`
    );
    lines.push(`<p><a href="/me">查看会话</a> | <a href="/logout">退出</a></p>`);

    const p = page('登录成功', lines.join(''), 200);
    res.writeHead(p.status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'Set-Cookie': cookie(SESSION_COOKIE, sid),
    });
    res.end(p.html);
    return null;
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'unknown'}`);
    const path = url.pathname;
    let result;
    try {
      if (path === '/health' && req.method === 'GET') {
        result = { status: 200, json: { ok: true, mode: cfg.mode } };
      } else if (path === '/' && req.method === 'GET') {
        result = page(
          'USTC OAuth 演示',
          `<h1>USTC 统一身份认证 OAuth2 演示</h1><p>模式：<code>${esc(cfg.mode)}</code></p>` +
            `<p><a href="/login">使用统一身份认证登录</a></p><p><a href="/me">当前会话</a></p>`
        );
      } else if (path === '/login' && req.method === 'GET') {
        if (cfg.mode !== 'live') {
          result = page('只读', '<p>当前为就绪模式（未配置身份源），不会发起 OAuth。</p>', 503);
        } else {
          const { token } = states.issue();
          const location = authorizeUrl(cfg, token);
          res.writeHead(302, {
            Location: location,
            'Set-Cookie': cookie(STATE_COOKIE, token, { maxAge: Math.floor(cfg.stateTtlMs / 1000) }),
          });
          res.end();
          return;
        }
      } else if (path === cfg.callbackPath) {
        result = await callback(req, res, url);
        if (result === null) return;
      } else if (path === '/profile' && req.method === 'GET') {
        if (!hostMatches(req, redirect)) {
          result = page('拒绝', '<p>主机不符，拒绝展示。</p>', 403);
        } else {
          const sid = readCookies(req)[SESSION_COOKIE];
          const s = sid ? sessions.get(sid) : undefined;
          result = s
            ? s.retained
              ? profilePage(s)
              : page('我的资料', '<p>本会话未保留资料，需要重新登录一次后才能查看。</p>')
            : page('我的资料', '<p>未登录，无法查看资料。</p>');
        }
      } else if (path === '/me' && req.method === 'GET') {
        const sid = readCookies(req)[SESSION_COOKIE];
        const s = sid ? sessions.get(sid) : undefined;
        result = s
          ? page('会话', `<p>登录成功：内部句柄 <code>${esc(s.handle)}</code></p><p><a href="/profile">我的资料</a> | <a href="/logout">退出</a></p>`)
          : page('会话', '<p>未登录。</p>');
      } else if (path === '/logout' && req.method === 'GET') {
        const sid = readCookies(req)[SESSION_COOKIE];
        if (sid) sessions.destroy(sid);
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }),
        });
        res.end();
        return;
      } else {
        result = page('404', '<p>not found</p>', 404);
      }

      if (result.json !== undefined) {
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result.json));
      } else {
        res.writeHead(result.status, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          ...(result.headers || {}),
        });
        res.end(result.html);
      }
    } catch (e) {
      const sid = readCookies(req)[SESSION_COOKIE];
      if (sid) sessions.destroy(sid);
      const stage = e && e.name === 'AppError' ? `${e.stage}:${e.reason}` : 'internal';
      logline('auth_error', { stage });
      res.writeHead(400, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }),
      });
      res.end(page('失败', '<p>认证失败，请重试。详情仅记录在服务端日志（不含敏感值）。</p>', 400).html);
    }
  };

  return createServer(handler);
}

// Direct-run entry point.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  if (!cfg.dataDir) {
    throw new Error('USTC_DEMO_DATA_DIR must be set (owner-only path outside the worktree)');
  }
  const server = createApp(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`ustc-oauth-demo mode=${cfg.mode} listening on http://${cfg.host}:${cfg.port}`);
  });
}