const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const loginTemplate = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'dashboard-login.html'),
  'utf8'
);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      cookies[name] = '';
    }
  }
  return cookies;
}

function requestIsSecure(request) {
  return Boolean(request.socket?.encrypted) ||
    String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function readFormBody(request, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        tooLarge = true;
        body = '';
      }
    });
    request.once('end', () => {
      if (tooLarge) reject(new Error('Login request is too large'));
      else resolve(new URLSearchParams(body));
    });
    request.once('error', reject);
  });
}

function createDashboardAuth({
  enabled,
  username,
  password,
  sessionHours = 12,
  cookieName,
  dashboardName,
}) {
  const authEnabled = Boolean(enabled);
  const maxAgeSeconds = Math.max(Number(sessionHours) || 12, 1) * 60 * 60;
  const attempts = new Map();
  const attemptWindowMs = 15 * 60 * 1000;
  const maxAttempts = 5;

  if (authEnabled && (!username || !password)) {
    throw new Error('Dashboard authentication requires a username and password');
  }
  if (authEnabled && String(password).length < 12) {
    throw new Error('Dashboard password must contain at least 12 characters');
  }

  const signingKey = crypto.createHash('sha256')
    .update(`${cookieName}:${username}:${password}`)
    .digest();

  function sign(payload) {
    return crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
  }

  function createSessionToken() {
    const payload = Buffer.from(JSON.stringify({
      username,
      expiresAt: Date.now() + maxAgeSeconds * 1000,
    })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  function verifySessionToken(token) {
    const [payload, signature, extra] = String(token || '').split('.');
    if (!payload || !signature || extra || !safeEqual(signature, sign(payload))) return false;
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return safeEqual(session.username, username) && Number(session.expiresAt) > Date.now();
    } catch {
      return false;
    }
  }

  function cookie(value, request, { clear = false } = {}) {
    const attributes = [
      `${cookieName}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      clear ? 'Max-Age=0' : `Max-Age=${maxAgeSeconds}`,
    ];
    if (requestIsSecure(request)) attributes.push('Secure');
    return attributes.join('; ');
  }

  function clientKey(request) {
    return String(request.socket?.remoteAddress || 'unknown');
  }

  function isRateLimited(request) {
    const now = Date.now();
    const key = clientKey(request);
    const recent = (attempts.get(key) || []).filter(timestamp => now - timestamp < attemptWindowMs);
    attempts.set(key, recent);
    return recent.length >= maxAttempts;
  }

  function recordFailure(request) {
    const key = clientKey(request);
    attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
  }

  function renderLogin(response, status = 200, error = '') {
    const html = loginTemplate
      .replaceAll('{{DASHBOARD_NAME}}', escapeHtml(dashboardName))
      .replaceAll('{{ERROR}}', escapeHtml(error))
      .replaceAll('{{ERROR_CLASS}}', error ? '' : 'visually-hidden');
    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(html);
  }

  async function handleRoute(request, response, url) {
    if (!authEnabled && request.method === 'POST' && url.pathname === '/logout') {
      response.writeHead(303, { Location: '/dashboard', 'Cache-Control': 'no-store' });
      response.end();
      return true;
    }
    if (!authEnabled) return false;
    if (request.method === 'GET' && url.pathname === '/login') {
      if (isAuthenticated(request)) {
        response.writeHead(303, { Location: '/dashboard', 'Cache-Control': 'no-store' });
        response.end();
        return true;
      }
      renderLogin(response);
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/login') {
      if (isRateLimited(request)) {
        renderLogin(response, 429, 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.');
        return true;
      }
      let form;
      try {
        form = await readFormBody(request);
      } catch {
        renderLogin(response, 413, 'Permintaan login terlalu besar.');
        return true;
      }
      const validUsername = safeEqual(form.get('username'), username);
      const validPassword = safeEqual(form.get('password'), password);
      const valid = validUsername && validPassword;
      if (!valid) {
        recordFailure(request);
        renderLogin(response, 401, 'Username atau password salah.');
        return true;
      }
      attempts.delete(clientKey(request));
      response.writeHead(303, {
        Location: '/dashboard',
        'Set-Cookie': cookie(createSessionToken(), request),
        'Cache-Control': 'no-store',
      });
      response.end();
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/logout') {
      response.writeHead(303, {
        Location: '/login',
        'Set-Cookie': cookie('', request, { clear: true }),
        'Cache-Control': 'no-store',
      });
      response.end();
      return true;
    }
    return false;
  }

  function isAuthenticated(request) {
    if (!authEnabled) return true;
    const token = parseCookies(request.headers.cookie)[cookieName];
    return verifySessionToken(token);
  }

  function requireAuthentication(request, response, url) {
    if (isAuthenticated(request)) return true;
    if (url.pathname.startsWith('/api/')) {
      response.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify({ error: 'Authentication required' }));
      return false;
    }
    response.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
    response.end();
    return false;
  }

  return {
    enabled: authEnabled,
    createSessionToken,
    handleRoute,
    isAuthenticated,
    requireAuthentication,
    verifySessionToken,
  };
}

module.exports = { createDashboardAuth, parseCookies, safeEqual };
