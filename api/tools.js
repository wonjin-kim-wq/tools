const { randomUUID, createHash } = require('node:crypto');
const { AppError, DEV_STATUSES, INQUIRY_STATUSES, equal, text, validateApp, validateDevRequest, validateInquiry, signSession, readSession, hashPassword, verifyPassword, imageType } = require('../lib/tools-core');

const BUCKET = 'chamcoding-screenshots';
const COOKIE = 'chamcoding_session';
const members = require('../lib/member-auth');
const config = () => ({ url: process.env.SUPABASE_URL?.replace(/\/$/, ''), key: process.env.SUPABASE_SERVICE_ROLE_KEY, secret: process.env.SESSION_SECRET });
const isConfigured = () => Object.values(config()).every(Boolean);

async function db(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}${path}`, {
    method, headers: { apikey: key, Authorization: `Bearer ${key}`, ...(raw ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body == null ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    // Keep database details and credentials out of browser responses and logs.
    console.error('Supabase request failed', response.status, path.split('?')[0]);
    throw new AppError('저장소 연결을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.', 503);
  }
  if (response.status === 204) return null;
  const value = await response.text();
  return value ? JSON.parse(value) : null;
}
async function rate(req, action, limit, seconds) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const key = createHash('sha256').update(`${config().secret}:${action}:${ip}`).digest('hex');
  const allowed = await db('/rest/v1/rpc/tools_check_rate', { method: 'POST', body: { p_key: key, p_limit: limit, p_seconds: seconds } });
  if (!allowed) throw new AppError('요청이 너무 많아요. 잠시 후 다시 시도해 주세요.', 429);
}
function session(req) {
  const cookies = String(req.headers.cookie || '').split(';').map(v => v.trim());
  const token = cookies.find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return readSession(token, config().secret);
}
function setSession(res, role, version) {
  const lifetime = role === 'admin' ? 2 * 60 * 60 : 8 * 60 * 60;
  const data = { role, sid: randomUUID(), exp: Date.now() + lifetime * 1000, ...(version ? (role === 'uploader' ? { uv: version } : { av: version }) : {}) };
  const secure = process.env.NODE_ENV !== 'development' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${signSession(data, config().secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetime}${secure}`);
  return data;
}
function adminAccount(req) {
  // Reuse only within this HTTP request; never cache authorization across users.
  return req.toolsAccountPromise ||= db('/rest/v1/tools_admins?id=eq.1&select=*&limit=1').then(rows=>rows[0]);
}
function uploaderVersion(account) {
  return account?.upload_password_salt || 'environment-v1';
}
function validUploaderSession(actor, account) {
  return actor?.role === 'uploader' && (actor.uv || 'environment-v1') === uploaderVersion(account);
}
function uploaderPasswordMatches(password, account) {
  if (account?.upload_password_hash || account?.upload_password_salt) {
    return verifyPassword(password, {salt: account.upload_password_salt, password_hash: account.upload_password_hash});
  }
  return equal(password, process.env.UPLOAD_PASSWORD);
}
async function requireRole(req, adminOnly = false) {
  const actor = session(req);
  if (!actor) throw new AppError('다시 로그인해 주세요.', 401);
  if (adminOnly && actor.role !== 'admin') throw new AppError('관리자만 사용할 수 있어요.', 403);
  if (actor.role === 'uploader' && !validUploaderSession(actor, await adminAccount(req))) {
    throw new AppError('업로드 비밀번호가 변경됐어요. 새 비밀번호로 다시 입장해 주세요.', 401);
  }
  if (adminOnly) {
    if (actor.role !== 'admin') throw new AppError('관리자만 사용할 수 있어요.', 403);
    const account = await adminAccount(req);
    if (!account || actor.av !== account.salt) throw new AppError('관리자 로그인이 만료됐어요.', 401);
  }
  return actor;
}
async function isAdmin(req) {
  const actor = session(req);
  return actor?.role === 'admin' && (await adminAccount(req))?.salt === actor.av;
}
// 한국 날짜(YYYY-MM-DD), offset일 전후
function kstDay(offset) {
  return new Date(Date.now() + 9 * 3600 * 1000 + offset * 86400 * 1000).toISOString().slice(0, 10);
}
function uuid(value, label) {
  const id = text(value, label, 36, true);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError(`${label}를 확인해 주세요.`);
  return id;
}
function assertMutation(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  const local = process.env.NODE_ENV === 'development';
  if (!origin || origin !== `${local ? 'http' : 'https'}://${host}`) throw new AppError('이 사이트에서 다시 요청해 주세요.', 403);
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError('요청 형식을 확인해 주세요.', 415);
}
function publicFields(row) {
  const { contact_email, review_note, submitted_session, ...safe } = row;
  return safe;
}
async function withImages(rows, admin = false) {
  const paths = [...new Set(rows.flatMap(r => (r.screenshots || []).map(s => s.path)))];
  const urls = new Map();
  if (paths.length) {
    const signed = await db(`/storage/v1/object/sign/${BUCKET}`, { method: 'POST', body: { paths, expiresIn: 3600 } });
    for (const item of signed) {
      const value = item.signedURL || item.signedUrl;
      if (value) urls.set(item.path, value.startsWith('http') ? value : `${config().url}/storage/v1${value}`);
    }
  }
  return rows.map(r => ({ ...(admin ? r : publicFields(r)), screenshots: (r.screenshots || []).map(s => ({ ...s, url: urls.get(s.path) || '' })) }));
}
async function verifyUploads(shots, actor, existing) {
  const previous = new Set((existing?.screenshots || []).map(s => s.path));
  await Promise.all(shots.map(async shot => {
    if (actor.role === 'admin' && previous.has(shot.path)) return;
    const rows = await db(`/rest/v1/tools_uploads?path=eq.${encodeURIComponent(shot.path)}&session_id=eq.${actor.sid}&select=path&limit=1`);
    if (!rows.length) throw new AppError('스크린샷을 다시 업로드해 주세요.');
  }));
}
async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('action') || 'apps';
  const send = (data, status = 200) => res.status(status).json(data);
  try {
    if (!['GET', 'POST', 'PATCH'].includes(req.method)) { res.setHeader('Allow', 'GET, POST, PATCH'); throw new AppError('지원하지 않는 요청이에요.', 405); }
    if (req.method !== 'GET') assertMutation(req);
    if (!isConfigured()) {
      if (action === 'session' && req.method === 'GET') return send({ role: null, configured: false, adminReady: false });
      throw new AppError('저장소 연결을 준비하고 있어요. 연결을 마치면 사용할 수 있어요.', 503);
    }
    if (action === 'visits' && ['GET','POST'].includes(req.method)) {
      return send(await db('/rest/v1/rpc/tools_visit_counts', {method:'POST',body:{p_increment:req.method==='POST'}}));
    }
    if (req.method === 'GET' && action === 'session') {
      const actor = session(req);
      const [account, member] = await Promise.all([adminAccount(req), members.member(req)]);
      const role = actor?.role === 'admin' ? account?.salt === actor.av ? 'admin' : null : validUploaderSession(actor, account) ? 'uploader' : null;
      return send({ role, configured: true, adminReady: !!account, member });
    }
    if (req.method === 'GET' && action === 'apps') {
      const [rows, extras] = await Promise.all([
        // 예시 앱(is_example)은 공개 목록에서 뺀다. 관리자 검토 화면에서는 계속 보인다.
        db('/rest/v1/tools_apps?status=eq.approved&is_example=eq.false&select=*&order=created_at.desc&limit=500'),
        // 별점·순위는 부가 정보라서 실패해도 목록은 그대로 보여준다.
        Promise.allSettled([
          db('/rest/v1/tools_reviews?hidden=eq.false&rating=not.is.null&select=app_id,rating&limit=20000'),
          db('/rest/v1/rpc/tools_rank_snapshot', { method: 'POST', body: {} }),
          db(`/rest/v1/tools_use_daily?day=gte.${kstDay(-59)}&select=app_id,day,count&limit=50000`)
        ])
      ]);
      // 인기순 기간 보기: 오늘·어제, 최근 7일·그 전 7일, 최근 30일·그 전 30일 사용 횟수
      const periods = new Map();
      const bounds = { d0: [kstDay(0), kstDay(0)], d1: [kstDay(-1), kstDay(-1)], w0: [kstDay(-6), kstDay(0)], w1: [kstDay(-13), kstDay(-7)], m0: [kstDay(-29), kstDay(0)], m1: [kstDay(-59), kstDay(-30)] };
      for (const r of extras[2].status === 'fulfilled' ? extras[2].value : []) {
        const p = periods.get(r.app_id) || { d0: 0, d1: 0, w0: 0, w1: 0, m0: 0, m1: 0 };
        for (const [key, [from, to]] of Object.entries(bounds)) if (r.day >= from && r.day <= to) p[key] += r.count;
        periods.set(r.app_id, p);
      }
      const ratings = extras[0].status === 'fulfilled' ? extras[0].value : [];
      const ranks = extras[1].status === 'fulfilled' && extras[1].value ? extras[1].value : {};
      const stats = new Map();
      for (const r of ratings) { const s = stats.get(r.app_id) || { sum: 0, count: 0 }; s.sum += r.rating; s.count++; stats.set(r.app_id, s); }
      const apps = (await withImages(rows)).map(app => {
        const s = stats.get(app.id), rank = ranks[app.id];
        return { ...app, use_periods: periods.get(app.id) || { d0: 0, d1: 0, w0: 0, w1: 0, m0: 0, m1: 0 }, rating_avg: s ? Math.round(s.sum / s.count * 10) / 10 : 0, rating_count: s?.count || 0, rank: rank?.rank || null, rank_prev: rank?.prev ?? null };
      });
      return send({ apps });
    }
    if (req.method === 'GET' && action === 'queue') {
      const actor = await requireRole(req, session(req)?.role === 'admin');
      const admin = actor.role === 'admin';
      const fields = admin ? '*' : 'id,name,category,grade,status,created_at,updated_at,review_note';
      const rows = await db(`/rest/v1/tools_apps?${admin ? '' : 'is_example=eq.false&'}select=${fields}&order=created_at.desc&limit=500`);
      return send({ apps: admin ? await withImages(rows, true) : rows });
    }
    const body = req.body || {};
    if (req.method === 'GET' && action === 'upload-password') {
      await requireRole(req, true);
      const account = await adminAccount(req);
      return send({ updatedAt: account.upload_password_changed_at || null, customPassword: !!account.upload_password_hash });
    }
    if (req.method === 'POST' && action === 'upload-password') {
      await requireRole(req, true);
      await rate(req, 'upload-password', 5, 900);
      const account = await adminAccount(req);
      if (!verifyPassword(text(body.adminPassword, '현재 관리자 비밀번호', 256, true), account)) {
        throw new AppError('현재 관리자 비밀번호가 맞지 않아요.', 403);
      }
      const password = body.newPassword;
      if (typeof password !== 'string' || password.length < 8 || password.length > 256 || password !== password.trim()) {
        throw new AppError('새 비밀번호는 앞뒤 공백 없이 8~256자로 입력해 주세요.');
      }
      if (password !== body.confirmPassword) throw new AppError('새 비밀번호 확인이 일치하지 않아요.');
      if (uploaderPasswordMatches(password, account)) throw new AppError('현재 업로드 비밀번호와 다른 비밀번호를 입력해 주세요.');
      if ((body.expectedUpdatedAt || null) !== (account.upload_password_changed_at || null)) {
        throw new AppError('다른 창에서 비밀번호가 변경됐어요. 설정을 다시 열어 주세요.', 409);
      }
      const {salt, hash} = hashPassword(password);
      const filter = account.upload_password_changed_at ? `eq.${encodeURIComponent(account.upload_password_changed_at)}` : 'is.null';
      const rows = await db(`/rest/v1/tools_admins?id=eq.1&upload_password_changed_at=${filter}`, {
        method: 'PATCH', headers: {Prefer: 'return=representation'},
        body: {upload_password_hash: hash, upload_password_salt: salt, upload_password_changed_at: new Date().toISOString()}
      });
      if (!rows.length) throw new AppError('다른 창에서 비밀번호가 변경됐어요. 설정을 다시 열어 주세요.', 409);
      return send({ ok: true, updatedAt: rows[0].upload_password_changed_at });
    }
    if(req.method==='POST' && action==='member-signup') {
      await rate(req,'member-signup',5,3600);
      return send(await members.signup(body,res,`${process.env.NODE_ENV==='development'?'http':'https'}://${req.headers.host}`),201);
    }
    if(req.method==='POST' && action==='member-login') {
      await rate(req,'member-login',10,900);
      return send(await members.login(body,res));
    }
    if(req.method==='POST' && action==='member-logout') {members.clearMember(res);return send({ok:true});}
    if(req.method==='GET' && action==='member-content') {
      const account=await members.member(req,true);
      return send({member:account,items:[]});
    }
    if (req.method === 'POST' && action === 'login') {
      await rate(req, 'login', 10, 900);
      const password = text(body.password, '비밀번호', 256, true);
      if (body.kind === 'uploader') {
        const account = await adminAccount(req);
        if (!uploaderPasswordMatches(password, account)) throw new AppError('공통 비밀번호가 맞지 않아요.', 401);
        setSession(res, 'uploader', uploaderVersion(account));
        return send({ role: 'uploader' });
      }
      if (body.kind !== 'admin') throw new AppError('로그인 종류를 확인해 주세요.');
      const account = await adminAccount(req);
      const username = text(body.username, '아이디', 80, true);
      const correct = verifyPassword(password, account);
      if (!account || !equal(username, account.username) || !correct) throw new AppError('관리자 아이디 또는 비밀번호가 맞지 않아요.', 401);
      setSession(res, 'admin', account.salt);
      return send({ role: 'admin' });
    }
    if (req.method === 'POST' && action === 'logout') {
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV !== 'development' ? '; Secure' : ''}`);
      return send({ ok: true });
    }
    if (req.method === 'POST' && action === 'setup') {
      await rate(req, 'setup', 5, 900);
      if (!process.env.ADMIN_SETUP_TOKEN || !equal(body.setupToken, process.env.ADMIN_SETUP_TOKEN)) throw new AppError('관리자 등록 전용 링크가 필요해요.', 403);
      if (await adminAccount(req)) throw new AppError('관리자 계정이 이미 등록되어 있어요.', 409);
      const username = text(body.username, '관리자 아이디', 80, true);
      const password = text(body.password, '관리자 비밀번호', 256, true);
      if (!/^[A-Za-z0-9@._+-]{3,80}$/.test(username)) throw new AppError('아이디는 영문·숫자·@._+-를 사용해 3자 이상 입력해 주세요.');
      if (password.length < 12) throw new AppError('비밀번호를 12자 이상 입력해 주세요.');
      const { salt, hash } = hashPassword(password);
      // A singleton primary key prevents two simultaneous setup requests from creating two admins.
      const response = await fetch(`${config().url}/rest/v1/tools_admins`, {
        method: 'POST', headers: { apikey: config().key, Authorization: `Bearer ${config().key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 1, username, salt, password_hash: hash }), signal: AbortSignal.timeout(15000)
      });
      if (response.status === 409) throw new AppError('관리자 계정이 이미 등록되어 있어요.', 409);
      if (!response.ok) throw new AppError('관리자 계정을 저장하지 못했어요. 다시 시도해 주세요.', 503);
      setSession(res, 'admin', salt);
      return send({ role: 'admin' }, 201);
    }
    if (req.method === 'POST' && action === 'upload') {
      const actor = await requireRole(req, session(req)?.role === 'admin');
      await rate(req, 'upload', 36, 3600);
      const data = text(body.data, '이미지', 2800000, true);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new AppError('이미지를 다시 선택해 주세요.');
      const file = Buffer.from(data, 'base64');
      if (file.length > 2 * 1024 * 1024 || file.length < 12) throw new AppError('이미지는 2MB 이하로 등록해 주세요.');
      const type = imageType(file);
      const path = `uploads/${actor.sid}/${randomUUID()}.${type.ext}`;
      await db(`/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', body: file, raw: true, headers: { 'Content-Type': type.mime, 'x-upsert': 'false' } });
      await db('/rest/v1/tools_uploads', { method: 'POST', body: { path, session_id: actor.sid } });
      return send({ path }, 201);
    }
    if (req.method === 'POST' && action === 'submit') {
      const actor = await requireRole(req, session(req)?.role === 'admin');
      await rate(req, 'submit', 12, 3600);
      const value = validateApp(body, { sessionId: actor.sid });
      await verifyUploads(value.screenshots, actor);
      const rows = await db('/rest/v1/tools_apps', { method: 'POST', body: { ...value, status: 'pending', submitted_session: actor.sid }, headers: { Prefer: 'return=representation' } });
      return send({ id: rows[0].id, status: 'pending' }, 201);
    }
    if (req.method === 'PATCH' && action === 'review') {
      const actor = await requireRole(req, true);
      const id = text(body.id, '요청 번호', 36, true);
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError('요청 번호를 확인해 주세요.');
      const existing = (await db(`/rest/v1/tools_apps?id=eq.${id}&select=*&limit=1`))[0];
      if (!existing) throw new AppError('요청을 찾을 수 없어요.', 404);
      if (!Number.isInteger(body.version) || body.version !== existing.version) throw new AppError('다른 창에서 수정된 요청이에요. 목록을 새로 불러와 주세요.', 409);
      const value = validateApp(body, { admin: true, sessionId: actor.sid, existing });
      await verifyUploads(value.screenshots, actor, existing);
      const rows = await db(`/rest/v1/tools_apps?id=eq.${id}&version=eq.${body.version}`, { method: 'PATCH', body: value, headers: { Prefer: 'return=representation' } });
      if (!rows.length) throw new AppError('다른 창에서 수정된 요청이에요. 목록을 새로 불러와 주세요.', 409);
      return send({ app: (await withImages(rows, true))[0] });
    }
    // 리뷰: 누구나 별점(1~5)과 함께 익명으로 남긴다. 회원은 앱마다 1개를 고쳐 쓰고, 관리자는 숨길 수 있다.
    if (req.method === 'GET' && action === 'reviews') {
      const appId = uuid(url.searchParams.get('app'), '앱 번호');
      const [rows, member, admin] = await Promise.all([
        db(`/rest/v1/tools_reviews?app_id=eq.${appId}&hidden=eq.false&select=id,member_id,rating,body,created_at,updated_at&order=updated_at.desc&limit=200`),
        members.member(req), isAdmin(req)
      ]);
      const rated = rows.filter(r => r.rating);
      const dist = [1, 2, 3, 4, 5].map(n => rated.filter(r => r.rating === n).length);
      const mine = member ? rows.find(r => r.member_id === member.id) : null;
      return send({
        reviews: rows.slice(0, 50).map(({ member_id, ...r }) => ({ ...r, name: '익명', mine: !!member && member_id === member.id })),
        summary: { count: rated.length, average: rated.length ? Math.round(rated.reduce((a, r) => a + r.rating, 0) / rated.length * 10) / 10 : 0, dist },
        member: !!member, mine: mine ? { body: mine.body, rating: mine.rating } : null, admin
      });
    }
    if (req.method === 'POST' && action === 'app-review') {
      const member = await members.member(req);
      await rate(req, member ? 'app-review' : 'app-review-anon', member ? 10 : 5, 3600);
      const appId = uuid(body.appId, '앱 번호');
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new AppError('별점을 1~5점 중에서 골라 주세요.');
      const value = text(body.body, '리뷰', 1000, true);
      const app = await db(`/rest/v1/tools_apps?id=eq.${appId}&status=eq.approved&select=id&limit=1`);
      if (!app.length) throw new AppError('리뷰를 남길 수 있는 앱을 찾지 못했어요.', 404);
      const review = { app_id: appId, member_name: '익명', rating, body: value };
      if (member) {
        // 같은 회원이 다시 쓰면 기존 리뷰를 고친다. 숨김 여부는 관리자가 정한 값을 유지한다.
        await db('/rest/v1/tools_reviews?on_conflict=app_id,member_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: { ...review, member_id: member.id } });
      } else {
        await db('/rest/v1/tools_reviews', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: review });
      }
      return send({ ok: true }, 201);
    }
    // 사용하기·체험하기를 누르면 사용 횟수를 센다. 같은 접속에서 같은 앱은 10분에 한 번만 센다.
    if (req.method === 'POST' && action === 'use') {
      const appId = uuid(body.appId, '앱 번호');
      try { await rate(req, `use:${appId}`, 1, 600); }
      catch (error) { if (error.status === 429) return send({ ok: true, counted: false }); throw error; }
      await db('/rest/v1/rpc/tools_use_app', { method: 'POST', body: { p_app: appId } });
      return send({ ok: true, counted: true });
    }
    if (req.method === 'PATCH' && action === 'app-review') {
      await requireRole(req, true);
      const id = uuid(body.id, '리뷰 번호');
      const rows = await db(`/rest/v1/tools_reviews?id=eq.${id}`, { method: 'PATCH', body: { hidden: body.hidden === true }, headers: { Prefer: 'return=representation' } });
      if (!rows.length) throw new AppError('리뷰를 찾을 수 없어요.', 404);
      return send({ ok: true });
    }
    // 앱 개발 요청: 로그인 없이 보낼 수 있고, 내용과 연락처는 관리자만 본다.
    if (req.method === 'POST' && action === 'dev-request') {
      await rate(req, 'dev-request', 5, 3600);
      const rows = await db('/rest/v1/tools_dev_requests', { method: 'POST', body: validateDevRequest(body), headers: { Prefer: 'return=representation' } });
      return send({ id: rows[0].id, status: 'pending' }, 201);
    }
    if (req.method === 'GET' && action === 'dev-requests') {
      await requireRole(req, true);
      return send({ requests: await db('/rest/v1/tools_dev_requests?select=*&order=created_at.desc&limit=500') });
    }
    if (req.method === 'PATCH' && action === 'dev-request') {
      await requireRole(req, true);
      const id = uuid(body.id, '요청 번호');
      if (!DEV_STATUSES.includes(body.status)) throw new AppError('처리 상태를 선택해 주세요.');
      const rows = await db(`/rest/v1/tools_dev_requests?id=eq.${id}`, { method: 'PATCH', body: { status: body.status, admin_note: text(body.admin_note, '관리자 메모', 2000) }, headers: { Prefer: 'return=representation' } });
      if (!rows.length) throw new AppError('요청을 찾을 수 없어요.', 404);
      return send({ request: rows[0] });
    }
    // 기타 문의: 로그인 없이 보낼 수 있고, 내용과 연락처는 관리자만 본다.
    if (req.method === 'POST' && action === 'inquiry') {
      await rate(req, 'inquiry', 5, 3600);
      const rows = await db('/rest/v1/tools_inquiries', { method: 'POST', body: validateInquiry(body), headers: { Prefer: 'return=representation' } });
      return send({ id: rows[0].id, status: 'pending' }, 201);
    }
    if (req.method === 'GET' && action === 'inquiries') {
      await requireRole(req, true);
      return send({ inquiries: await db('/rest/v1/tools_inquiries?select=*&order=created_at.desc&limit=500') });
    }
    if (req.method === 'PATCH' && action === 'inquiry') {
      await requireRole(req, true);
      const id = uuid(body.id, '문의 번호');
      if (!INQUIRY_STATUSES.includes(body.status)) throw new AppError('처리 상태를 선택해 주세요.');
      const rows = await db(`/rest/v1/tools_inquiries?id=eq.${id}`, { method: 'PATCH', body: { status: body.status, admin_note: text(body.admin_note, '관리자 메모', 2000) }, headers: { Prefer: 'return=representation' } });
      if (!rows.length) throw new AppError('문의를 찾을 수 없어요.', 404);
      return send({ inquiry: rows[0] });
    }
    throw new AppError('요청을 찾을 수 없어요.', 404);
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    if (status === 500) console.error('Tools API failed', error.name);
    return send({ error: error instanceof AppError ? error.message : '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.' }, status);
  }
}
module.exports = handler;
