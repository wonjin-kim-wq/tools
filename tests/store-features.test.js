const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateApp, validateDevRequest, signSession, hashPassword } = require('../lib/tools-core');
const handler = require('../api/tools');

const sid = randomUUID();
const shot = `uploads/${sid}/${randomUUID()}.jpg`;
const app = () => ({name:'모둠 뽑기',web_url:'https://example.com/',demo_url:'',video_url:'',short:'모둠을 만들어요',description:'사용 방법',cat:'교실놀이',subjects:['수학'],grade:'전학년',icon:'🎲',color:'#ffd23f',notes:[],screenshots:[{path:shot,caption:'시작 화면'}],author_name:'제작자',contact_email:''});
const devRequest = () => ({title:'받아쓰기 채점기',requester_name:'김선생',contact_email:'teacher@example.com',cat:'교과 교육',grade:'2학년',purpose:'받아쓰기 시험을 빠르게 채점하고 싶어요.',features:'문항 입력\n자동 채점',reference_url:'',wanted_by:'12월',consent:true});

test('intro video URL must be a public https address and featured is admin-only', () => {
  assert.equal(validateApp({...app(),video_url:'https://youtu.be/abcdefghijk'},{sessionId:sid}).video_url,'https://youtu.be/abcdefghijk');
  for (const value of ['javascript:alert(1)','http://youtube.com/watch?v=1','https://127.0.0.1/v']) assert.throws(()=>validateApp({...app(),video_url:value},{sessionId:sid}));
  assert.equal(validateApp({...app(),featured:true},{sessionId:sid}).featured,undefined);
  assert.equal(validateApp({...app(),featured:true,status:'approved'},{admin:true,sessionId:sid}).featured,true);
  assert.equal(validateApp({...app(),featured:'yes',status:'approved'},{admin:true,sessionId:sid}).featured,false);
});

test('subjects: several allowed values, required for new uploads, unknown values refused', () => {
  assert.deepEqual(validateApp({...app(),subjects:['수학','실과(정보)','수학']},{sessionId:sid}).subjects,['수학','실과(정보)']);
  assert.throws(()=>validateApp({...app(),subjects:[]},{sessionId:sid}));
  assert.throws(()=>validateApp({...app(),subjects:['코딩']},{sessionId:sid}));
  assert.throws(()=>validateApp({...app(),subjects:'수학'},{sessionId:sid}));
  assert.deepEqual(validateApp({...app(),subjects:[],status:'approved'},{admin:true,sessionId:sid}).subjects,[]);
});

test('development requests need contact email, consent and a known category; status cannot be injected', () => {
  const row = validateDevRequest({...devRequest(),status:'done',admin_note:'injected',id:'x'});
  for (const key of ['status','admin_note','id']) assert.equal(row[key],undefined);
  for (const patch of [{contact_email:''},{contact_email:'not-email'},{consent:false},{cat:'다른 분류'},{title:''},{features:''},{reference_url:'http://example.com'}]) {
    assert.throws(()=>validateDevRequest({...devRequest(),...patch}));
  }
});

function stub(store) {
  return async (input, options = {}) => {
    const url = new URL(input), body = options.body ? JSON.parse(options.body) : null;
    let data;
    if (url.pathname === '/rest/v1/tools_admins') data = [store.admin];
    else if (url.pathname === '/rest/v1/rpc/tools_check_rate') data = true;
    else if (url.pathname === '/rest/v1/tools_dev_requests') {
      if (options.method === 'POST') { const row = {...body,id:randomUUID(),status:'pending',admin_note:''}; store.devRequests.push(row); data = [row]; }
      else if (options.method === 'PATCH') { const row = store.devRequests.find(r=>r.id===url.searchParams.get('id').slice(3)); if (row) Object.assign(row, body); data = row ? [row] : []; }
      else data = store.devRequests;
    } else if (url.pathname === '/rest/v1/tools_reviews') {
      if (options.method === 'PATCH') { const row = store.reviews.find(r=>r.id===url.searchParams.get('id').slice(3)); if (row) Object.assign(row, body); data = row ? [row] : []; }
      else if (options.method === 'POST') { store.reviews.unshift({...body,id:randomUUID(),hidden:false,created_at:'2026-11-04T01:00:00Z',updated_at:'2026-11-04T01:00:00Z'}); data = null; }
      else data = store.reviews.filter(r=>!r.hidden).map(({hidden,app_id,...r})=>r);
    } else if (url.pathname === '/rest/v1/tools_apps') data = [{id:url.searchParams.get('id').slice(3)}];
    else if (url.pathname === '/rest/v1/rpc/tools_use_app') { store.uses = (store.uses||0) + 1; data = null; }
    else throw new Error(`Unexpected route ${url.pathname}`);
    return new Response(JSON.stringify(data), {status:200,headers:{'content-type':'application/json'}});
  };
}
function request({method='GET',action,query='',body={},cookie}={}) {
  return {method,url:`/api/tools?action=${action}${query}`,body,headers:{host:'tools.example.com',origin:'https://tools.example.com','content-type':'application/json',...(cookie?{cookie}:{})},socket:{remoteAddress:'127.0.0.1'}};
}
function response() { return {headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}}; }

test('development requests: anyone can send, only admins can read and update', async () => {
  const originalFetch = global.fetch, secret = 'store-test-secret';
  Object.assign(process.env,{SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-key',SESSION_SECRET:secret,UPLOAD_PASSWORD:'test-upload'});
  const credential = hashPassword('local-test-only-password');
  const store = {admin:{id:1,username:'local-test-admin',salt:credential.salt,password_hash:credential.hash},devRequests:[],reviews:[]};
  global.fetch = stub(store);
  const call = async options => { const res = response(); await handler(request(options), res); return res; };
  const admin = `chamcoding_session=${signSession({sid,role:'admin',exp:Date.now()+100000,av:credential.salt},secret)}`;
  const uploader = `chamcoding_session=${signSession({sid,role:'uploader',exp:Date.now()+100000},secret)}`;
  try {
    const sent = await call({method:'POST',action:'dev-request',body:devRequest()});
    assert.equal(sent.statusCode,201); assert.equal(store.devRequests[0].status,'pending');
    assert.equal((await call({action:'dev-requests'})).statusCode,401);
    assert.equal((await call({action:'dev-requests',cookie:uploader})).statusCode,403);
    const list = await call({action:'dev-requests',cookie:admin});
    assert.equal(list.statusCode,200); assert.equal(list.data.requests[0].contact_email,'teacher@example.com');
    assert.equal((await call({method:'PATCH',action:'dev-request',cookie:uploader,body:{id:sent.data.id,status:'done'}})).statusCode,403);
    const updated = await call({method:'PATCH',action:'dev-request',cookie:admin,body:{id:sent.data.id,status:'in_progress',admin_note:'개발 시작'}});
    assert.equal(updated.statusCode,200); assert.equal(store.devRequests[0].status,'in_progress');
    assert.equal((await call({method:'PATCH',action:'dev-request',cookie:admin,body:{id:sent.data.id,status:'approved'}})).statusCode,400);
  } finally { global.fetch = originalFetch; }
});

test('reviews: anyone can post an anonymous star review, ids stay private, hiding needs an admin', async () => {
  const originalFetch = global.fetch, secret = 'store-test-secret';
  Object.assign(process.env,{SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-key',SESSION_SECRET:secret,UPLOAD_PASSWORD:'test-upload'});
  const credential = hashPassword('local-test-only-password');
  const appId = randomUUID(), reviewId = randomUUID();
  const store = {admin:{id:1,username:'local-test-admin',salt:credential.salt,password_hash:credential.hash},devRequests:[],
    reviews:[{id:reviewId,app_id:appId,member_id:randomUUID(),member_name:'익명',rating:4,body:'좋아요',hidden:false,created_at:'2026-11-04T00:00:00Z',updated_at:'2026-11-04T00:00:00Z'}]};
  global.fetch = stub(store);
  const call = async options => { const res = response(); await handler(request(options), res); return res; };
  const admin = `chamcoding_session=${signSession({sid,role:'admin',exp:Date.now()+100000,av:credential.salt},secret)}`;
  try {
    const list = await call({action:'reviews',query:`&app=${appId}`});
    assert.equal(list.statusCode,200); assert.equal(list.data.reviews[0].body,'좋아요');
    assert.equal(list.data.reviews[0].member_id,undefined); assert.equal(list.data.reviews[0].name,'익명');
    assert.equal(list.data.member,false); assert.equal(list.data.admin,false); assert.deepEqual(list.data.summary,{count:1,average:4,dist:[0,0,0,1,0]});
    assert.equal((await call({action:'reviews',query:'&app=1'})).statusCode,400);
    for (const rating of [0,6,3.5,'다섯',undefined]) assert.equal((await call({method:'POST',action:'app-review',body:{appId,rating,body:'최고예요'}})).statusCode,400);
    assert.equal((await call({method:'POST',action:'app-review',body:{appId,rating:5,body:''}})).statusCode,400);
    assert.equal((await call({method:'POST',action:'app-review',body:{appId,rating:5,body:'최고예요'}})).statusCode,201);
    assert.equal(store.reviews[0].member_id,undefined); assert.equal(store.reviews[0].member_name,'익명'); assert.equal(store.reviews[0].rating,5);
    const summary = (await call({action:'reviews',query:`&app=${appId}`})).data.summary;
    assert.equal(summary.count,2); assert.equal(summary.average,4.5);
    assert.equal((await call({method:'PATCH',action:'app-review',body:{id:reviewId,hidden:true}})).statusCode,401);
    assert.equal((await call({method:'PATCH',action:'app-review',cookie:admin,body:{id:reviewId,hidden:true}})).statusCode,200);
    assert.equal((await call({action:'reviews',query:`&app=${appId}`})).data.reviews.length,1);
    const used = await call({method:'POST',action:'use',body:{appId}});
    assert.equal(used.statusCode,200); assert.equal(store.uses,1);
    assert.equal((await call({method:'POST',action:'use',body:{appId:'not-an-id'}})).statusCode,400);
  } finally { global.fetch = originalFetch; }
});
