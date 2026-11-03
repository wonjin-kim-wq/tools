const test=require('node:test');
const assert=require('node:assert/strict');
const handler=require('../api/tools');

test('visit endpoint counts repeat page loads, reads without incrementing, and rejects cross-origin writes',async()=>{
  const previous=global.fetch;
  Object.assign(process.env,{SUPABASE_URL:'https://visits.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',SESSION_SECRET:'fixture-session-secret'});
  let total=0;
  global.fetch=async(input,options)=>{
    assert.equal(new URL(input).pathname,'/rest/v1/rpc/tools_visit_counts');
    assert.equal(options.method,'POST');
    if(JSON.parse(options.body).p_increment)total++;
    return new Response(JSON.stringify({total,today:total,day:'2026-11-03'}));
  };
  async function invoke(method,origin='https://tools.test'){
    const req={method,url:'/api/tools?action=visits',body:{},headers:{host:'tools.test',origin,'content-type':'application/json'}};
    const res={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(data){this.data=data;}};
    await handler(req,res);return res;
  }
  try{
    assert.equal((await invoke('GET')).data.total,0);
    assert.equal((await invoke('POST')).data.total,1);
    assert.equal((await invoke('POST')).data.total,2);
    assert.equal((await invoke('GET')).data.total,2);
    assert.equal((await invoke('POST','https://other.test')).statusCode,403);
    assert.equal(total,2);
  }finally{global.fetch=previous;}
});
