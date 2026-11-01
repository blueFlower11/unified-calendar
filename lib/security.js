// Crypto, cookies and outbound-request safety. Zero dependencies.
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function loadSecret(dir) {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const f = path.join(dir, '.secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}

function makeCrypto(secret) {
  const encKey = crypto.createHash('sha256').update('enc:' + secret).digest();
  const macKey = crypto.createHash('sha256').update('mac:' + secret).digest();
  const b64u = b => Buffer.from(b).toString('base64url');
  return {
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
      const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    },
    decrypt(blob) {
      const b = Buffer.from(blob, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', encKey, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
    sign(obj) {
      const body = b64u(JSON.stringify(obj));
      return body + '.' + crypto.createHmac('sha256', macKey).update(body).digest('base64url');
    },
    verify(token) {
      if (!token || typeof token !== 'string') return null;
      const [body, mac] = token.split('.');
      if (!body || !mac) return null;
      const want = crypto.createHmac('sha256', macKey).update(body).digest();
      const got = Buffer.from(mac, 'base64url');
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
      try {
        const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (o.exp && o.exp < Date.now()) return null;
        return o;
      } catch { return null; }
    },
  };
}

function parseCookies(h) {
  const out = {};
  for (const part of (h || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookie(name, value, { maxAge, secure } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) s += `; Max-Age=${maxAge}`;
  if (secure) s += '; Secure';
  return s;
}

// ---- SSRF protection for user-supplied calendar links ----
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function makeLookup(allowPrivate) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const ok = addrs.filter(a => allowPrivate || !isPrivateIp(a.address));
      if (!ok.length) return cb(new Error('That address is not allowed'));
      if (options.all) return cb(null, ok);
      cb(null, ok[0].address, ok[0].family);
    });
  };
}

function fetchText(url, { allowPrivate = false, redirects = 5, maxBytes = 25e6 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url.replace(/^webcal:/i, 'https:')); } catch { return reject(new Error('That is not a valid link')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Only http(s)/webcal links are supported'));
    if (!allowPrivate) {
      if (u.port && !['80', '443'].includes(u.port)) return reject(new Error('That address is not allowed'));
      if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateIp(u.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('That address is not allowed'));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { lookup: makeLookup(allowPrivate), headers: { 'User-Agent': 'unified-calendar/0.2', Accept: 'text/calendar,*/*' }, timeout: 20000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        return resolve(fetchText(new URL(res.headers.location, u).toString(), { allowPrivate, redirects: redirects - 1, maxBytes }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`The calendar server answered HTTP ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > maxBytes) req.destroy(new Error('Feed too large')); else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

module.exports = { loadSecret, makeCrypto, parseCookies, cookie, isPrivateIp, fetchText };
