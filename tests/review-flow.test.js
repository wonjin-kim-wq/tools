const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {hashPassword,signSession}=require('../lib/tools-core');
const handler=require('../api/tools');

// Test the real API handler against a Supabase transport stub. No production administrator is created.
test('review flow: pending is private, uploader cannot approve, admin publishes edits, stale edits fail', async()=>{
  const originalFetch=global.fetch;
  const secret='review-flow-test-secret';
  Object.assign(process.env,{SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-key',SESSION_SECRET:secret,UPLOAD_PASSWORD:'test-upload'});
  const credential=hashPassword('local-test-only-password');
  const admin={id:1,username:'local-test-admin',salt:credential.salt,password_hash:credential.hash};
  const id=randomUUID(),sid=randomUUID(),path=`uploads/${sid}/${randomUUID()}.jpg`;
  const pending={id,name:'요청 앱',web_url:'https://example.com/',demo_url:'',short:'소개',description:'기존 설명',category:'교과 교육',grade:'전학년',icon:'🧩',color:'#ffd23f',notes:[],screenshots:[{path,caption:'기존 설명'}],author_name:'제작자',contact_email:'private@example.com',review_note:'',status:'pending',version:1,is_example:false,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  let stored={...pending};
  global.fetch=async(input,options={})=>{
    const url=new URL(input);
    let data;
    if(url.pathname==='/rest/v1/tools_admins')data=[admin];
    else if(url.pathname==='/storage/v1/object/sign/chamcoding-screenshots')data=[{path,signedURL:`/object/sign/chamcoding-screenshots/${path}?token=test`}];
    else if(url.pathname==='/rest/v1/tools_apps'){
      if(options.method==='PATCH'){
        if(Number(url.searchParams.get('version').slice(3))!==stored.version)data=[];
        else {stored={...stored,...JSON.parse(options.body),version:stored.version+1};data=[stored];}
      } else data=url.searchParams.get('status')==='eq.approved'&&stored.status!=='approved'?[]:[stored];
    } else throw new Error(`Unexpected database route ${url.pathname}`);
    return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  };
  const invoke=async(action,{method='GET',role=null,body={}}={})=>{
    const token=role?signSession({sid,role,exp:Date.now()+100000,...(role==='admin'?{av:admin.salt}:{})},secret):'';
    const req={url:`/api/tools?action=${action}`,method,body,headers:{host:'tools.test',origin:'https://tools.test','content-type':'application/json',cookie:`chamcoding_session=${token}`}};
    const res={headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},status(code){this.statusCode=code;return this;},json(data){this.data=data;}};
    await handler(req,res);return res;
  };
  try{
    assert.deepEqual((await invoke('apps')).data.apps,[]);
    const edit={...stored,cat:stored.category,description:'관리자가 수정한 설명',screenshots:[{path,caption:'관리자가 수정한 화면 설명'}],status:'approved'};
    assert.equal((await invoke('review',{method:'PATCH',role:'uploader',body:edit})).statusCode,403);
    const saved=await invoke('review',{method:'PATCH',role:'admin',body:edit});
    assert.equal(saved.statusCode,200);assert.equal(saved.data.app.status,'approved');assert.equal(saved.data.app.version,2);
    const published=(await invoke('apps')).data.apps[0];
    assert.equal(published.description,'관리자가 수정한 설명');assert.equal(published.screenshots[0].caption,'관리자가 수정한 화면 설명');
    assert.equal(published.contact_email,undefined);assert.equal(published.review_note,undefined);
    assert.equal((await invoke('review',{method:'PATCH',role:'admin',body:edit})).statusCode,409);
  }finally{global.fetch=originalFetch;}
});
