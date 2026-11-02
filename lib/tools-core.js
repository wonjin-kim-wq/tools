const { createHmac, timingSafeEqual, randomBytes, scryptSync } = require('node:crypto');

const CATEGORIES = ['교과 교육', '계기 교육', '아침활동', '교실놀이'];
const STATUSES = ['pending', 'approved', 'rejected', 'changes_requested', 'archived'];
class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const equal = (a, b) => {
  const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
};
function text(value, label, max, required = false) {
  if (value != null && typeof value !== 'string') throw new AppError(`${label} 형식을 확인해 주세요.`);
  const result = (value || '').trim();
  if (required && !result) throw new AppError(`${label}을(를) 입력해 주세요.`);
  if (result.length > max) throw new AppError(`${label}은(는) ${max}자 이내로 입력해 주세요.`);
  return result;
}
function webUrl(value, required = false) {
  const raw = text(value, '웹앱 주소', 2000, required);
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw new AppError('https://로 시작하는 올바른 주소를 입력해 주세요.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /^(localhost|127\.|0\.|169\.254\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) {
    throw new AppError('공개된 https:// 웹앱 주소를 입력해 주세요.');
  }
  return url.href;
}
function validateApp(input, { admin = false, sessionId = '', existing = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('요청 내용을 확인해 주세요.');
  const category = text(input.cat, '분류', 30, true);
  if (!CATEGORIES.includes(category)) throw new AppError('분류를 선택해 주세요.');
  const color = text(input.color || '#ffd23f', '대표 색상', 7);
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new AppError('대표 색상을 확인해 주세요.');
  const notes = input.notes || [];
  if (!Array.isArray(notes) || notes.length > 12) throw new AppError('새로운 기능은 12개까지 입력할 수 있어요.');
  const screenshots = input.screenshots || [];
  if (!Array.isArray(screenshots) || screenshots.length > 6) throw new AppError('스크린샷은 6장까지 등록할 수 있어요.');
  if (!screenshots.length && !existing?.is_example) throw new AppError('스크린샷을 1장 이상 등록해 주세요.');
  const previousPaths = new Set((existing?.screenshots || []).map(s => s.path));
  const shots = screenshots.map(s => {
    if (!s || typeof s !== 'object') throw new AppError('스크린샷 정보를 확인해 주세요.');
    const path = text(s.path, '스크린샷 경로', 200, true);
    if (!/^uploads\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(jpg|png|webp)$/.test(path)) throw new AppError('스크린샷을 다시 업로드해 주세요.');
    if (!path.startsWith(`uploads/${sessionId}/`) && !(admin && previousPaths.has(path))) throw new AppError('이 요청에 사용할 수 없는 스크린샷이에요.', 403);
    return { path, caption: text(s.caption, '스크린샷 설명', 250, true) };
  });
  const result = {
    name: text(input.name, '앱 이름', 60, true),
    web_url: webUrl(input.web_url, !existing?.is_example),
    demo_url: webUrl(input.demo_url),
    short: text(input.short, '한 줄 소개', 160, true),
    description: text(input.description, '상세 설명', 6000, true),
    category, grade: text(input.grade, '대상 학년', 80, true),
    icon: text(input.icon || '🧩', '아이콘', 16, true), color,
    notes: notes.map(n => text(n, '새로운 기능', 250)).filter(Boolean), screenshots: shots,
    author_name: text(input.author_name, '제작자 이름', 60, true),
    contact_email: text(input.contact_email, '연락 이메일', 254)
  };
  if (result.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.contact_email)) throw new AppError('연락 이메일을 확인해 주세요.');
  if (admin) {
    if (!STATUSES.includes(input.status)) throw new AppError('처리 상태를 선택해 주세요.');
    result.status = input.status;
    result.review_note = text(input.review_note, '검토 메모', 2000);
  }
  return result;
}
function signSession(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}
function readSession(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) return null;
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  if (!equal(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (!['uploader', 'admin'].includes(payload.role) || !/^[a-f0-9-]{36}$/.test(payload.sid) || !Number.isFinite(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch { return null; }
}
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, account) {
  const candidate = hashPassword(password, account?.salt || 'unconfigured-account');
  return equal(candidate.hash, account?.password_hash || '');
}
function imageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { ext: 'png', mime: 'image/png' };
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  throw new AppError('PNG, JPG, WebP 이미지 파일만 업로드할 수 있어요.');
}
module.exports = { AppError, CATEGORIES, STATUSES, equal, text, webUrl, validateApp, signSession, readSession, hashPassword, verifyPassword, imageType };
