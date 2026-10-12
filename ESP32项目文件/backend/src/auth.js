/**
 * 认证与权限 —— 自实现 JWT(HS256) + scrypt 密码哈希, 零依赖
 * 角色: 'admin'(全部权限) / 'viewer'(只读, 不能控制设备/改配置/管用户)
 */
const crypto = require('crypto');
const config = require('../config');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** 签发 JWT(payload 里带 username / role / userId) */
function sign(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + config.jwt.expiresIn }));
  const sig = crypto
    .createHmac('sha256', config.jwt.secret)
    .update(h + '.' + body)
    .digest('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${h}.${body}.${sig}`;
}

/** 校验 JWT, 有效返回 payload, 否则 null */
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, b, s] = parts;
    const expect = crypto
      .createHmac('sha256', config.jwt.secret)
      .update(h + '.' + b)
      .digest('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    if (s !== expect) return null;
    const payload = JSON.parse(b64urlDecode(b).toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/** scrypt 密码哈希: 格式 salt:hash */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const h = crypto.scryptSync(pw, salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) {
    return false;
  }
}

/** 需要登录(任意角色) */
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : h;
  const payload = verify(token);
  if (!payload) return res.status(401).json({ ok: false, error: '未登录或登录已过期' });
  req.user = payload;
  next();
}

/** 需要管理员 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '需要管理员权限' });
  }
  next();
}

module.exports = { sign, verify, hashPassword, verifyPassword, requireAuth, requireAdmin };
