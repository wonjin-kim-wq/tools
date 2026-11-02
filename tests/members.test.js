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
