const test=require('node:test');
const assert=require('node:assert/strict');
const members=require('../lib/member-auth');
test('member authorization requires verified app membership; client metadata cannot grant access',async()=>{
  process.env.SUPABASE_URL='https://fixture.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture';
  const original=global.fetch;
  const req={headers:{cookie:'chamcoding_member=verified-token'}};
  let user={id:'member-id',email:'member@example.com',email_confirmed_at:'2026-11-03',app_metadata:{},user_metadata:{chamcoding_member:true,role:'admin'}};
  global.fetch=async()=>new Response(JSON.stringify(user));
  try{
    assert.equal(await members.member(req),null);
    await assert.rejects(()=>members.member(req,true),{status:403});
    user.app_metadata={chamcoding_member:true,chamcoding_content_access:true};
    assert.equal((await members.member(req,true)).contentAccess,true);
    user.app_metadata.chamcoding_content_access=false;
    await assert.rejects(()=>members.member(req,true),{status:403});
    user.email_confirmed_at=null;assert.equal(await members.member(req),null);
    await assert.rejects(()=>members.member({headers:{}},true),{status:401});
  }finally{global.fetch=original;}
});
test('signup uses normal email verification and server-managed membership; duplicates cannot mutate other accounts',async()=>{
  const original=global.fetch,calls=[];let duplicate=false;
  const user={id:'new-member',identities:[{id:'identity'}],app_metadata:{provider:'email'}};
  global.fetch=async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    return new Response(JSON.stringify(url.includes('/signup')?{user:{...user,identities:duplicate?[]:user.identities},session:null}:user));
  };
  const res={setHeader(){throw new Error('Unverified signup must not issue a session');}};
  try{
    const result=await members.signup({email:'new@example.com',password:'test-password',name:'새 회원',role:'admin'},res,'https://tools.example');
    assert.equal(result.needsConfirmation,true);assert.equal(calls[0].body.role,undefined);
    assert.equal(calls[1].body.app_metadata.chamcoding_member,true);
    assert.equal(calls[1].body.app_metadata.role,undefined);
    duplicate=true;calls.length=0;
    await assert.rejects(()=>members.signup({email:'new@example.com',password:'test-password',name:'새 회원'},res,'https://tools.example'));
    assert.equal(calls.length,1);
  }finally{global.fetch=original;}
});
test('member login returns HttpOnly cookie without exposing Supabase token to frontend JSON',async()=>{
  const original=global.fetch,headers={};
  global.fetch=async()=>new Response(JSON.stringify({access_token:'fixture-access-token',expires_in:3600,user:{email_confirmed_at:'2026-11-03',app_metadata:{chamcoding_member:true}}}));
  try{
    const result=await members.login({email:'member@example.com',password:'test-password'},{setHeader(k,v){headers[k]=v;}});
    assert.deepEqual(result,{ok:true});assert.match(headers['Set-Cookie'],/HttpOnly/);assert.match(headers['Set-Cookie'],/Secure/);
  }finally{global.fetch=original;}
});
// Supabase Auth 응답을 경로별로 흉내 낸다.
function fakeAuth(routes){
  const calls=[];
  global.fetch=async(url,options={})=>{
    const u=new URL(url),key=`${options.method||'GET'} ${u.pathname}${u.searchParams.get('grant_type')?`?${u.searchParams.get('grant_type')}`:''}`;
    calls.push({key,url:u,options,body:options.body?JSON.parse(options.body):null});
    const route=routes[key];
    if(!route)return new Response(JSON.stringify({error_code:'not_mocked'}),{status:400});
    const [status,body]=typeof route==='function'?route(calls.at(-1)):route;
    return new Response(typeof body==='string'?body:JSON.stringify(body),{status});
  };
  return calls;
}
const cookieRes=()=>{const res={cookies:[],setHeader(k,v){res.cookies=[].concat(v);}};return res;};
const confirmed=meta=>({id:'shared-user',email:'teacher@example.com',email_confirmed_at:'2026-11-01',app_metadata:meta,user_metadata:{}});
test('login links a confirmed account that lacks the membership flag, but keeps revoked members blocked',async()=>{
  const original=global.fetch;
  try{
    const calls=fakeAuth({
      'POST /auth/v1/token?password':[200,{access_token:'a.b.c',refresh_token:'refresh1',expires_in:3600,user:confirmed({provider:'email'})}],
      'PUT /auth/v1/admin/users/shared-user':c=>[200,{...confirmed(c.body.app_metadata)}]
    });
    const res=cookieRes();
    assert.deepEqual(await members.login({email:'teacher@example.com',password:'test-password'},res),{ok:true});
    const put=calls.find(c=>c.key.startsWith('PUT'));
    assert.equal(put.body.app_metadata.chamcoding_member,true);assert.equal(put.body.app_metadata.provider,'email');
    assert.equal(res.cookies.length,2);assert.match(res.cookies[1],/chamcoding_member_refresh=refresh1; Path=\/api; HttpOnly/);
    fakeAuth({'POST /auth/v1/token?password':[200,{access_token:'a.b.c',user:confirmed({chamcoding_member:false})}]});
    await assert.rejects(()=>members.login({email:'teacher@example.com',password:'test-password'},cookieRes()),{status:403});
  }finally{global.fetch=original;}
});
test('signup survives a failed membership write and explains Supabase errors instead of a generic duplicate message',async()=>{
  const original=global.fetch;
  try{
    fakeAuth({'POST /auth/v1/signup':[200,{id:'u1',identities:[{}],app_metadata:{}}],'PUT /auth/v1/admin/users/u1':[502,'<html>Bad gateway</html>']});
    const res={setHeader(){throw new Error('no session before confirmation');}};
    assert.deepEqual(await members.signup({email:'a@b.kr',password:'test-password',name:'가'},res,'https://www.chamssaem.kr'),{needsConfirmation:true});
    fakeAuth({'POST /auth/v1/signup':[422,{error_code:'weak_password',weak_password:{reasons:['characters']}}]});
    await assert.rejects(()=>members.signup({email:'a@b.kr',password:'abcdefgh',name:'가'},res,'https://x'),{message:/너무 쉬워요/});
    fakeAuth({'POST /auth/v1/signup':[502,'<html>Bad gateway</html>']});
    await assert.rejects(()=>members.signup({email:'a@b.kr',password:'abcdefgh',name:'가'},res,'https://x'),{status:503});
    fakeAuth({'POST /auth/v1/signup':[200,{id:'u1',identities:[]}]});
    await assert.rejects(()=>members.signup({email:'a@b.kr',password:'abcdefgh',name:'가'},res,'https://x'),{status:409,message:/이미 가입한 이메일/});
  }finally{global.fetch=original;}
});
test('expired access cookie is renewed from the refresh cookie; a bad refresh token clears both cookies',async()=>{
  const original=global.fetch;
  const req={headers:{cookie:'chamcoding_member=old.token.x; chamcoding_member_refresh=refresh1'}};
  try{
    const calls=fakeAuth({'GET /auth/v1/user':[401,{error_code:'bad_jwt'}],'POST /auth/v1/token?refresh_token':[200,{access_token:'new.token.y',refresh_token:'refresh2',expires_in:3600,user:confirmed({chamcoding_member:true})}]});
    const res=cookieRes();
    assert.equal((await members.member(req,true,{res})).id,'shared-user');
    assert.equal(calls.find(c=>c.key.includes('refresh_token')).body.refresh_token,'refresh1');
    assert.match(res.cookies[0],/chamcoding_member=new\.token\.y; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=3540/);
    assert.match(res.cookies[1],/refresh2/);
    assert.equal(await members.member(req),null,'without a response object the request cannot renew');
    fakeAuth({'GET /auth/v1/user':[401,{}],'POST /auth/v1/token?refresh_token':[400,{error_code:'refresh_token_not_found'}]});
    const bad=cookieRes();
    await assert.rejects(()=>members.member(req,true,{res:bad}),{status:401});
    assert.ok(bad.cookies.every(c=>/Max-Age=0/.test(c)));
  }finally{global.fetch=original;}
});
test('mail links, resend, recovery, password change and logout',async()=>{
  const original=global.fetch;
  try{
    let calls=fakeAuth({'GET /auth/v1/user':[200,confirmed({})],'PUT /auth/v1/admin/users/shared-user':c=>[200,confirmed(c.body.app_metadata)]});
    const res=cookieRes();
    await members.linkSession({access_token:'h.p.s',refresh_token:'r1',expires_in:3600},res);
    assert.equal(calls[0].options.headers.Authorization,'Bearer h.p.s');assert.equal(res.cookies.length,2);
    await assert.rejects(()=>members.linkSession({access_token:'not a jwt'},cookieRes()),{status:400});
    calls=fakeAuth({'POST /auth/v1/resend':[400,{error_code:'validation_failed'}],'POST /auth/v1/recover':[200,{}]});
    assert.deepEqual(await members.resend({email:'A@B.kr'},'https://www.chamssaem.kr'),{ok:true},'never reveals whether the email exists');
    assert.equal(calls[0].body.email,'a@b.kr');assert.equal(calls[0].url.searchParams.get('redirect_to'),'https://www.chamssaem.kr/?email-confirmed=1');
    await members.recover({email:'a@b.kr'},'https://www.chamssaem.kr');
    assert.equal(calls[1].url.searchParams.get('redirect_to'),'https://www.chamssaem.kr/?email-confirmed=1');
    fakeAuth({'POST /auth/v1/recover':[429,{error_code:'over_email_send_rate_limit'}]});
    await assert.rejects(()=>members.recover({email:'a@b.kr'},'https://x'),{status:429});
    const req={headers:{cookie:'chamcoding_member=h.p.s'}};
    calls=fakeAuth({'GET /auth/v1/user':[200,confirmed({chamcoding_member:true})],'PUT /auth/v1/user':[200,confirmed({chamcoding_member:true})]});
    await assert.rejects(()=>members.changePassword(req,cookieRes(),{password:'new-password',confirm:'other'}));
    await members.changePassword(req,cookieRes(),{password:'new-password',confirm:'new-password'});
    assert.equal(calls.at(-1).body.password,'new-password');
    calls=fakeAuth({'POST /auth/v1/logout':[204,'']});
    const out=cookieRes();
    await members.logout(req,out);
    assert.equal(calls[0].options.headers.Authorization,'Bearer h.p.s');assert.ok(out.cookies.every(c=>/Max-Age=0/.test(c)));
  }finally{global.fetch=original;}
});
test('member login rate limit is per email, so one school network is not blocked by its first ten logins',async()=>{
  const handler=require('../api/tools');
  const original=global.fetch,env={...process.env};
  Object.assign(process.env,{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture',SESSION_SECRET:'fixture-secret'});
  const limits=[];
  global.fetch=async(url,options={})=>{
    const u=new URL(url),body=options.body?JSON.parse(options.body):{};
    if(u.pathname==='/rest/v1/rpc/tools_check_rate'){limits.push(body);return new Response('true');}
    if(u.pathname==='/auth/v1/token')return new Response(JSON.stringify({access_token:'a.b.c',expires_in:3600,user:{id:'m',email_confirmed_at:'x',app_metadata:{chamcoding_member:true}}}));
    return new Response('{}',{status:404});
  };
  try{
    const res={statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},status(c){this.statusCode=c;return this;},json(v){this.body=v;return this;}};
    await handler({method:'POST',url:'/api/tools?action=member-login',headers:{origin:'https://www.chamssaem.kr',host:'www.chamssaem.kr','content-type':'application/json','x-forwarded-for':'203.0.113.7'},body:{email:'Teacher@Example.com',password:'test-password'}},res);
    assert.equal(res.statusCode,200);
    assert.deepEqual(limits.map(l=>l.p_limit),[100,10]);
    assert.notEqual(limits[0].p_key,limits[1].p_key);
  }finally{global.fetch=original;process.env=env;}
});
