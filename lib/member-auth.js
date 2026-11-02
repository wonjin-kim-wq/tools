const { AppError, text } = require('./tools-core');
const COOKIE = 'chamcoding_member';
const credentials = input => {
  const email = text(input.email, '이메일', 254, true).toLowerCase();
  const password = typeof input.password === 'string' ? input.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('이메일 주소를 확인해 주세요.');
  if (password.length < 8 || password.length > 256) throw new AppError('비밀번호는 8~256자로 입력해 주세요.');
  return { email, password };
};
async function auth(path, {body, token, method = body ? 'POST' : 'GET'} = {}) {
  const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/,'')}/auth/v1${path}`, {
    method, headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {}) },
    body: body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.error_code === 'email_not_confirmed') throw new AppError('이메일 인증을 완료한 뒤 로그인해 주세요.',401);
    if (response.status === 429 || data.error_code === 'over_email_send_rate_limit') throw new AppError('인증 메일 요청이 많아요. 잠시 후 다시 시도해 주세요.',429);
    if (data.error_code === 'email_address_not_authorized' || data.error_code === 'unexpected_failure') throw new AppError('인증 메일 발송 설정을 확인해야 해요. 관리자에게 문의해 주세요.',503);
    throw new AppError(path.startsWith('/token') ? '이메일 또는 비밀번호가 맞지 않아요.' : '가입을 완료하지 못했어요. 이미 가입한 이메일인지 확인해 주세요.',400);
  }
  return data;
}
function memberCookie(res, data) {
  const secure=process.env.NODE_ENV==='development'?'':'; Secure';
  res.setHeader('Set-Cookie',`${COOKIE}=${data.access_token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.min(data.expires_in||3600,3600)}${secure}`);
}
function clearMember(res) {
  res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV==='development'?'':'; Secure'}`);
}
async function member(req, required=false) {
  const token=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
  if (!token) { if(required)throw new AppError('회원 로그인이 필요해요.',401);return null; }
  let user;
  try { user=await auth('/user',{token}); } catch(error) {if(required)throw new AppError('로그인이 만료됐어요. 다시 로그인해 주세요.',401);return null;}
  if (!user.email_confirmed_at || user.app_metadata?.chamcoding_member!==true) {if(required)throw new AppError('참코딩 회원 권한이 필요해요.',403);return null;}
  if (required && user.app_metadata?.chamcoding_content_access===false) throw new AppError('회원 전용 콘텐츠 이용 권한을 확인해 주세요.',403);
  return {id:user.id,name:user.user_metadata?.display_name||'회원',email:user.email,contentAccess:user.app_metadata?.chamcoding_content_access!==false};
}
async function signup(input, res, origin) {
  const value=credentials(input),name=text(input.name,'이름',60,true);
  const data=await auth(`/signup?redirect_to=${encodeURIComponent(origin+'/?email-confirmed=1')}`,{body:{...value,data:{display_name:name}}});
  const user=data.user||data;
  if (!user.id || !user.identities?.length) throw new AppError('가입 안내를 확인해 주세요. 기존 회원이라면 로그인해 주세요.');
  await auth(`/admin/users/${user.id}`,{method:'PUT',token:process.env.SUPABASE_SERVICE_ROLE_KEY,body:{app_metadata:{...user.app_metadata,chamcoding_member:true,chamcoding_content_access:true}}});
  if(data.access_token)memberCookie(res,data);
  return {needsConfirmation:!data.access_token};
}
async function login(input,res) {
  const data=await auth('/token?grant_type=password',{body:credentials(input)});
  if(!data.user?.email_confirmed_at || data.user.app_metadata?.chamcoding_member!==true)throw new AppError('참코딩 회원으로 가입한 이메일을 사용해 주세요.',403);
  memberCookie(res,data);
  return {ok:true};
}
module.exports={member,signup,login,clearMember};
