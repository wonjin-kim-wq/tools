const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {hashPassword,signSession,verifyPassword}=require('../lib/tools-core');
const handler=require('../api/tools');

test('admin password rotation rejects unauthorized requests, replaces fallback, and expires all prior uploader sessions',async()=>{
  const original=global.fetch;
  const adminSecret='fixture-admin-password',oldPassword='fixture-original-upload',newPassword='fixture-replacement-upload';
  const salt=hashPassword(adminSecret);
  let admin={id:1,username:'fixture-admin',salt:salt.salt,password_hash:salt.hash};
  let adminReads=0;
  Object.assign(process.env,{SUPABASE_URL:'https://rotation.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',SESSION_SECRET:'fixture-session-secret',UPLOAD_PASSWORD:oldPassword});
  global.fetch=async(input,options={})=>{
    const url=new URL(input);let data;
    if(url.pathname==='/rest/v1/tools_admins'){
      if(options.method==='PATCH'){
        const filter=url.searchParams.get('upload_password_changed_at');
        if(filter==='is.null'?!!admin.upload_password_changed_at:filter!==`eq.${admin.upload_password_changed_at}`)data=[];
        else {Object.assign(admin,JSON.parse(options.body));data=[admin];}
      }else {adminReads++;data=[admin];}
    }else if(url.pathname==='/rest/v1/rpc/tools_check_rate')data=true;
    else if(url.pathname==='/rest/v1/tools_apps')data=[];
    else throw new Error('Unexpected test request');
    return new Response(JSON.stringify(data));
  };
  const adminToken=signSession({role:'admin',sid:randomUUID(),av:admin.salt,exp:Date.now()+60000},process.env.SESSION_SECRET);
  const legacyToken=signSession({role:'uploader',sid:randomUUID(),exp:Date.now()+60000},process.env.SESSION_SECRET);
  async function invoke(action,{method='GET',body={},token='',origin='https://tools.test'}={}){
    const req={url:`/api/tools?action=${action}`,method,body,headers:{host:'tools.test',origin,'content-type':'application/json',cookie:`chamcoding_session=${token}`}};
    const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.statusCode=code;return this;},json(data){this.data=data;}};
    await handler(req,res);return res;
  }
  const body={adminPassword:adminSecret,newPassword,confirmPassword:newPassword,expectedUpdatedAt:null};
  try{
    assert.equal((await invoke('upload-password')).statusCode,401);
    assert.equal((await invoke('upload-password',{method:'POST',token:legacyToken,body})).statusCode,403);
    assert.equal((await invoke('upload-password',{method:'POST',token:adminToken,body,origin:'https://other.test'})).statusCode,403);
    assert.equal((await invoke('upload-password',{method:'POST',token:adminToken,body:{...body,adminPassword:'wrong'}})).statusCode,403);
    assert.equal((await invoke('upload-password',{method:'POST',token:adminToken,body:{...body,confirmPassword:'mismatch'}})).statusCode,400);
    assert.equal((await invoke('queue',{token:legacyToken})).statusCode,200);
    const oldLogin=await invoke('login',{method:'POST',body:{kind:'uploader',password:oldPassword}});
    const oldToken=oldLogin.headers['Set-Cookie'].split(';')[0].split('=')[1];
    const changed=await invoke('upload-password',{method:'POST',token:adminToken,body});
    assert.equal(changed.statusCode,200);
    assert.equal(verifyPassword(newPassword,{salt:admin.upload_password_salt,password_hash:admin.upload_password_hash}),true);
    assert.notEqual(admin.upload_password_hash,newPassword);
    assert.equal(JSON.stringify(changed.data).includes(newPassword),false);
    assert.equal((await invoke('queue',{token:oldToken})).statusCode,401);
    assert.equal((await invoke('queue',{token:legacyToken})).statusCode,401);
    assert.equal((await invoke('session',{token:oldToken})).data.role,null);
    assert.equal((await invoke('login',{method:'POST',body:{kind:'uploader',password:oldPassword}})).statusCode,401);
    delete process.env.UPLOAD_PASSWORD;
    const fresh=await invoke('login',{method:'POST',body:{kind:'uploader',password:newPassword}});
    assert.equal(fresh.statusCode,200);
    const freshToken=fresh.headers['Set-Cookie'].split(';')[0].split('=')[1];
    assert.equal((await invoke('queue',{token:freshToken})).statusCode,200);
    const readsBeforeSettings=adminReads;
    const settings=await invoke('upload-password',{token:adminToken});
    assert.equal(adminReads-readsBeforeSettings,1,'authorization and settings share a single database read');
    assert.deepEqual(Object.keys(settings.data).sort(),['customPassword','updatedAt']);
    assert.equal((await invoke('upload-password',{method:'POST',token:adminToken,body:{...body,newPassword:'second-upload-password',confirmPassword:'second-upload-password'}})).statusCode,409);
    assert.equal((await invoke('session',{token:adminToken})).data.role,'admin');
    admin={...admin,salt:'rotated-admin-salt'};
    assert.equal((await invoke('upload-password',{token:adminToken})).statusCode,401,'a new request must recheck current administrator credentials');
  }finally{global.fetch=original;}
});
