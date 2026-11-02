const test=require('node:test');
const assert=require('node:assert/strict');
const handler=require('../api/tools');
test('owner setup requires one-time token, stores a hash, and refuses a second administrator',async()=>{
  Object.assign(process.env,{SUPABASE_URL:'https://setup.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',SESSION_SECRET:'fixture-session-key',UPLOAD_PASSWORD:'fixture-upload',ADMIN_SETUP_TOKEN:'fixture-setup-token'});
  let account=null;
  const originalFetch=global.fetch;
  global.fetch=async(input,options={})=>{
    const url=new URL(input);
    if(url.pathname==='/rest/v1/rpc/tools_check_rate')return new Response('true');
    assert.equal(url.pathname,'/rest/v1/tools_admins');
    if(options.method==='POST'){
      if(account)return new Response('{}',{status:409});
      account=JSON.parse(options.body);return new Response(null,{status:201});
    }
    return new Response(JSON.stringify(account?[account]:[]));
  };
  async function invoke(action,body){
    const req={method:'POST',url:`/api/tools?action=${action}`,body,headers:{host:'tools.test',origin:'https://tools.test','content-type':'application/json'},socket:{remoteAddress:'fixture'}};
    const res={headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},status(code){this.statusCode=code;return this;},json(data){this.data=data;}};
    await handler(req,res);return res;
  }
  const credentials={username:'fixture-owner',password:'fixture-password-only'};
  try{
    assert.equal((await invoke('setup',{...credentials,setupToken:'wrong'})).statusCode,403);
    assert.equal(account,null);
    const saved=await invoke('setup',{...credentials,setupToken:'fixture-setup-token'});
    assert.equal(saved.statusCode,201);assert.equal(saved.data.role,'admin');
    assert.notEqual(account.password_hash,credentials.password);assert.equal(account.password,undefined);
    assert.match(saved.headers['Set-Cookie'],/HttpOnly/);assert.match(saved.headers['Set-Cookie'],/SameSite=Strict/);assert.match(saved.headers['Set-Cookie'],/Secure/);
    assert.equal((await invoke('setup',{...credentials,setupToken:'fixture-setup-token'})).statusCode,409);
    const login=await invoke('login',{kind:'admin',...credentials});assert.equal(login.statusCode,200);assert.equal(login.data.role,'admin');
  }finally{global.fetch=originalFetch;}
});
