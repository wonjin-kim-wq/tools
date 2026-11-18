const { AppError, text } = require('./tools-core');
const COOKIE = 'chamcoding_member';
const REFRESH = 'chamcoding_member_refresh';
const REFRESH_AGE = 14 * 24 * 60 * 60;
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const normalEmail = value => String(value || '').trim().toLowerCase().slice(0, 254);
const emailOnly = input => {
  const email = text(input.email, '이메일', 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('이메일 주소를 확인해 주세요.');
  return email;
};
const passwordOnly = (value, label = '비밀번호') => {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 8 || password.length > 256) throw new AppError(`${label}는 8~256자로 입력해 주세요.`);
  return password;
};
const credentials = input => ({ email: emailOnly(input), password: passwordOnly(input.password) });

// Supabase Auth 오류 코드를 사용자가 할 일을 알 수 있는 안내로 바꾼다.
function authError(path, status, data) {
  const code = data.error_code || data.code;
  if (code === 'email_not_confirmed') return new AppError('이메일 인증을 완료한 뒤 로그인해 주세요. 메일을 못 받았다면 아래 ‘인증 메일 다시 받기’를 눌러 주세요.', 401);
  if (status === 429 || ['over_email_send_rate_limit', 'over_request_rate_limit'].includes(code)) return new AppError('요청이 많아요. 몇 분 뒤 다시 시도해 주세요.', 429);
  if (['email_address_not_authorized', 'unexpected_failure'].includes(code)) return new AppError('인증 메일 발송 설정을 확인해야 해요. 관리자에게 문의해 주세요.', 503);
  if (code === 'weak_password') {
    const reasons = data.weak_password?.reasons || [];
    return new AppError(reasons.includes('pwned') ? '유출된 적 있는 비밀번호예요. 다른 비밀번호를 사용해 주세요.' : '비밀번호가 너무 쉬워요. 영문·숫자·기호를 섞어 더 길게 만들어 주세요.');
  }
  if (code === 'same_password') return new AppError('지금 쓰는 비밀번호와 다른 비밀번호를 입력해 주세요.');
  if (code === 'reauthentication_needed') return new AppError('보안을 위해 로그아웃 후 다시 로그인한 뒤 비밀번호를 바꿔 주세요.', 401);
  if (['email_address_invalid', 'validation_failed'].includes(code)) return new AppError('이 이메일 주소로는 가입할 수 없어요. 주소를 다시 확인해 주세요.');
  if (['signup_disabled', 'email_provider_disabled'].includes(code)) return new AppError('지금은 회원가입을 받을 수 없어요. 관리자에게 문의해 주세요.', 503);
  if (['user_already_exists', 'email_exists'].includes(code)) return new AppError('이미 가입한 이메일이에요. 로그인해 주세요.', 409);
  if (status >= 500) return new AppError('회원 서버 응답이 늦어요. 잠시 후 다시 시도해 주세요.', 503);
  if (path.includes('grant_type=password')) return new AppError('이메일 또는 비밀번호가 맞지 않아요.', 400);
  if (path.includes('grant_type=refresh_token') || path === '/user' || path.startsWith('/logout') || status === 401 || status === 403) {
    return new AppError('로그인이 만료됐어요. 다시 로그인해 주세요.', 401);
  }
  if (path.startsWith('/signup')) return new AppError('가입을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.');
  return new AppError('요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
}
async function auth(path, { body, token, method = body ? 'POST' : 'GET' } = {}) {
  let response;
  try {
    response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1${path}`, {
      method, headers: { apikey: serviceKey(), 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000)
    });
  } catch { throw new AppError('회원 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.', 503); }
  // 게이트웨이 오류처럼 JSON이 아닌 응답도 500 대신 안내로 바꾼다.
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    if (path.startsWith('/admin/users/') && method === 'GET') {
      if (response.status === 404) return null;
      throw new AppError('회원 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.', 503);
    }
    throw authError(path, response.status, data || {});
  }
  return data || {};
}

function cookie(req, name) {
  return String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}
// 한 응답에 회원 쿠키 두 개를 함께 보낸다. 다른 Set-Cookie를 덮어쓰지 않는다.
function addCookie(res, value) {
  res.toolsCookies ||= [];
  const name = value.slice(0, value.indexOf('='));
  res.toolsCookies = res.toolsCookies.filter(v => !v.startsWith(`${name}=`)).concat(value);
  res.setHeader('Set-Cookie', res.toolsCookies.length === 1 ? res.toolsCookies[0] : res.toolsCookies);
}
const flags = () => `HttpOnly; SameSite=Strict${process.env.NODE_ENV === 'development' ? '' : '; Secure'}`;
function memberCookie(res, data) {
  // 접근 토큰이 끝나기 1분 전에 쿠키를 지워 만료 토큰으로 요청하지 않게 한다.
  const age = Math.max(60, Math.min(Number(data.expires_in) || 3600, 3600) - 60);
  addCookie(res, `${COOKIE}=${data.access_token}; Path=/; ${flags()}; Max-Age=${age}`);
  // 갱신 토큰은 API 요청에만 보낸다. 1시간마다 다시 로그인하지 않게 서버가 접근 토큰을 새로 받는다.
  if (data.refresh_token) addCookie(res, `${REFRESH}=${data.refresh_token}; Path=/api; ${flags()}; Max-Age=${REFRESH_AGE}`);
}
function clearMember(res) {
  addCookie(res, `${COOKIE}=; Path=/; ${flags()}; Max-Age=0`);
  addCookie(res, `${REFRESH}=; Path=/api; ${flags()}; Max-Age=0`);
}
function verifiedMember(user) {
  if (!user?.email_confirmed_at || user.app_metadata?.chamcoding_member !== true ||
      user.is_anonymous || Date.parse(user.banned_until) > Date.now()) return null;
  return { id: user.id, name: user.user_metadata?.display_name || '회원', email: user.email, contentAccess: user.app_metadata?.chamcoding_content_access !== false };
}
// 가입 도중 권한 저장에 실패한 계정이나 대시보드에서 직접 만든 계정은
// 본인이 비밀번호나 메일 링크로 확인했을 때 참코딩 회원으로 연결한다.
// 관리자가 chamcoding_member=false로 막은 계정과 이용 권한을 끈 계정은 그대로 둔다.
async function linkMember(user) {
  const meta = user?.app_metadata || {};
  if (!user?.id || !user.email_confirmed_at || user.is_anonymous || meta.chamcoding_member !== undefined) return user;
  const app_metadata = { ...meta, chamcoding_member: true, ...(meta.chamcoding_content_access === undefined ? { chamcoding_content_access: true } : {}) };
  const updated = await auth(`/admin/users/${encodeURIComponent(user.id)}`, { method: 'PUT', token: serviceKey(), body: { app_metadata } });
  return updated?.id ? updated : { ...user, app_metadata };
}

// 쿠키의 접근 토큰을 확인하고, 만료됐으면 갱신 토큰으로 새로 받는다(res가 있을 때).
async function current(req, res) {
  const token = cookie(req, COOKIE);
  if (token) {
    try { return { user: await auth('/user', { token }), token }; }
    catch (error) { if (error.status !== 401) throw error; }
  }
  const refresh = cookie(req, REFRESH);
  if (!refresh || !res) return null;
  let data;
  try { data = await auth('/token?grant_type=refresh_token', { body: { refresh_token: refresh } }); }
  catch (error) { if (error.status === 401) clearMember(res); throw error; }
  if (!verifiedMember(data.user)) { clearMember(res); return null; }
  memberCookie(res, data);
  return { user: data.user, token: data.access_token };
}
async function member(req, required = false, { requireContentAccess = true, res } = {}) {
  let found;
  try { found = await current(req, res); }
  catch (error) {
    if (!required) return null;
    throw error.status === 401 ? new AppError('로그인이 만료됐어요. 다시 로그인해 주세요.', 401) : error;
  }
  if (!found) { if (required) throw new AppError('회원 로그인이 필요해요.', 401); return null; }
  const account = verifiedMember(found.user);
  if (!account) { if (required) throw new AppError('참코딩 회원 권한이 필요해요.', 403); return null; }
  if (required && requireContentAccess && !account.contentAccess) throw new AppError('회원 전용 콘텐츠 이용 권한을 확인해 주세요.', 403);
  return account;
}
async function memberById(id) {
  const data = await auth(`/admin/users/${encodeURIComponent(id)}`, { token: serviceKey() });
  return verifiedMember(data?.user || data);
}
// Supabase Redirect URLs 허용 목록에 등록된 주소 하나만 쓴다. 인증·재설정은 돌아온 주소 해시의 type으로 구분한다.
const back = origin => encodeURIComponent(`${origin}/?email-confirmed=1`);
async function signup(input, res, origin) {
  const value = credentials(input), name = text(input.name, '이름', 60, true);
  const data = await auth(`/signup?redirect_to=${back(origin)}`, { body: { ...value, data: { display_name: name } } });
  const user = data.user || data;
  if (!user.id || !user.identities?.length) {
    throw new AppError('이미 가입한 이메일이에요. 로그인해 주세요. 비밀번호가 기억나지 않으면 ‘비밀번호 찾기’를 이용해 주세요.', 409);
  }
  let linked = user;
  try {
    linked = await auth(`/admin/users/${encodeURIComponent(user.id)}`, { method: 'PUT', token: serviceKey(), body: { app_metadata: { ...user.app_metadata, chamcoding_member: true, chamcoding_content_access: true } } });
  } catch (error) {
    // 계정은 이미 만들어졌다. 인증 후 로그인할 때 linkMember가 다시 연결하므로 가입 안내는 그대로 보여준다.
    console.error('Member metadata update failed', error.status);
  }
  if (data.access_token) {
    if (!verifiedMember(await linkMember(linked?.id ? linked : user))) throw new AppError('가입은 됐지만 회원 권한을 확인하지 못했어요. 잠시 후 로그인해 주세요.', 503);
    memberCookie(res, data);
  }
  return { needsConfirmation: !data.access_token };
}
async function login(input, res) {
  const data = await auth('/token?grant_type=password', { body: credentials(input) });
  if (!verifiedMember(await linkMember(data.user))) throw new AppError('이 계정은 참코딩 회원으로 사용할 수 없어요. 관리자에게 문의해 주세요.', 403);
  memberCookie(res, data);
  return { ok: true };
}
// 인증·비밀번호 재설정 메일 링크가 주소 해시로 돌려준 토큰을 HttpOnly 쿠키로 옮긴다.
async function linkSession(input, res) {
  const token = text(input.access_token, '인증 정보', 4096, true);
  const refresh = text(input.refresh_token, '인증 정보', 512);
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) || (refresh && !/^[\w-]+$/.test(refresh))) throw new AppError('인증 링크를 다시 확인해 주세요.');
  const user = await linkMember(await auth('/user', { token }));
  if (!verifiedMember(user)) throw new AppError('이 계정은 참코딩 회원으로 사용할 수 없어요. 관리자에게 문의해 주세요.', 403);
  memberCookie(res, { access_token: token, refresh_token: refresh, expires_in: Number(input.expires_in) || 3600 });
  return { ok: true };
}
// 가입 여부를 드러내지 않도록 결과는 항상 같은 안내로 돌려준다.
async function resend(input, origin) {
  const email = emailOnly(input);
  try { await auth(`/resend?redirect_to=${back(origin)}`, { body: { type: 'signup', email } }); }
  catch (error) { if ([429, 503].includes(error.status)) throw error; }
  return { ok: true };
}
async function recover(input, origin) {
  const email = emailOnly(input);
  try { await auth(`/recover?redirect_to=${back(origin)}`, { body: { email } }); }
  catch (error) { if ([429, 503].includes(error.status)) throw error; }
  return { ok: true };
}
async function changePassword(req, res, input) {
  const password = passwordOnly(input.password, '새 비밀번호');
  if (password !== input.confirm) throw new AppError('새 비밀번호 확인이 일치하지 않아요.');
  let found;
  try { found = await current(req, res); } catch (error) { if (error.status !== 401) throw error; }
  if (!found || !verifiedMember(found.user)) throw new AppError('로그인이 만료됐어요. 다시 로그인해 주세요.', 401);
  await auth('/user', { method: 'PUT', token: found.token, body: { password } });
  return { ok: true };
}
async function logout(req, res) {
  const token = cookie(req, COOKIE), refresh = cookie(req, REFRESH);
  clearMember(res);
  // 브라우저 쿠키만 지우지 않고 Supabase 세션도 끊는다. 실패해도 로그아웃은 진행한다.
  try {
    const access = token || (refresh ? (await auth('/token?grant_type=refresh_token', { body: { refresh_token: refresh } })).access_token : '');
    if (access) await auth('/logout?scope=local', { method: 'POST', token: access });
  } catch {}
  return { ok: true };
}
module.exports = { member, memberById, signup, login, linkSession, resend, recover, changePassword, logout, clearMember, normalEmail };
