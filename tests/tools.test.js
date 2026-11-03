const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { webUrl, validateApp, signSession, readSession, hashPassword, verifyPassword, imageType } = require('../lib/tools-core');
const handler = require('../api/tools');
const sid = randomUUID();
const shot = `uploads/${sid}/${randomUUID()}.jpg`;
const app = () => ({name:'모둠 뽑기',web_url:'https://example.com/',demo_url:'',short:'모둠을 만들어요',description:'사용 방법',cat:'교실놀이',subjects:['수학'],grade:'전학년',icon:'🎲',color:'#ffd23f',notes:['설명'],screenshots:[{path:shot,caption:'시작 화면'}],author_name:'제작자',contact_email:''});

test('unsafe, credential-bearing and private app URLs are refused',()=>{
  for(const value of ['javascript:alert(1)','data:text/html,test','http://example.com','https://user:secret@example.com','https://127.0.0.1','https://10.0.0.1','https://192.168.0.1']) assert.throws(()=>webUrl(value,true));
  assert.equal(webUrl('https://example.com/app'), 'https://example.com/app');
});
test('uploader cannot set approval status, counts, IDs or private session ownership',()=>{
  const row=validateApp({...app(),status:'approved',uses:500,id:'injected',submitted_session:randomUUID()},{sessionId:sid});
  for(const key of ['status','uses','id','submitted_session'])assert.equal(row[key],undefined);
});
test('screenshots must belong to current session; admins can retain existing attachments',()=>{
  assert.throws(()=>validateApp(app(),{sessionId:randomUUID()}));
  const value={...app(),status:'approved'};
  assert.doesNotThrow(()=>validateApp(value,{admin:true,sessionId:randomUUID(),existing:{screenshots:[{path:shot}]}}));
  assert.throws(()=>validateApp({...value,screenshots:[{path:`uploads/${randomUUID()}/${randomUUID()}.jpg`,caption:'다른 파일'}]},{admin:true,sessionId:randomUUID(),existing:{screenshots:[{path:shot}]}}));
});
test('required screenshots, descriptions and category are validated',()=>{
  for(const patch of [{screenshots:[]},{screenshots:[{path:shot,caption:''}]},{cat:'다른 분류'},{name:''},{notes:Array(13).fill('변경')}])assert.throws(()=>validateApp({...app(),...patch},{sessionId:sid}));
});
test('signed sessions reject privilege escalation, expiry and invalid signatures',()=>{
  const secret='test-secret', now=Date.now();
  const token=signSession({sid,role:'uploader',exp:now+10000},secret);
  assert.equal(readSession(token,secret,now).role,'uploader');
  const tampered=Buffer.from(JSON.stringify({sid,role:'admin',exp:now+10000})).toString('base64url')+'.'+token.split('.')[1];
  assert.equal(readSession(tampered,secret,now),null);
  assert.equal(readSession(token,'wrong',now),null);
  assert.equal(readSession(token,secret,now+10001),null);
});
test('admin passwords are salted hashes; incorrect password is refused',()=>{
  const first=hashPassword('test-password-only'),second=hashPassword('test-password-only');
  assert.notEqual(first.hash,second.hash);
  assert.equal(verifyPassword('test-password-only',{salt:first.salt,password_hash:first.hash}),true);
  assert.equal(verifyPassword('wrong',{salt:first.salt,password_hash:first.hash}),false);
});
test('SVG, HTML and fake image payloads are refused',()=>{
  assert.throws(()=>imageType(Buffer.from('<svg onload="alert(1)"></svg>')));
  assert.throws(()=>imageType(Buffer.from('<!doctype html>')));
  assert.equal(imageType(Buffer.from([255,216,255,224,0,0,0,0,0,0,0,0])).mime,'image/jpeg');
});
function request({method='GET',action='queue',body={},cookie,origin='https://tools.example.com'}={}) {
  return {method,url:`/api/tools?action=${action}`,body,headers:{host:'tools.example.com',origin,'content-type':'application/json',...(cookie?{cookie:`chamcoding_session=${cookie}`}:{})},socket:{remoteAddress:'127.0.0.1'}};
}
function response() { return {headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}}; }
test('API enforces login and admin role before reading or mutating requests',async()=>{
  process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test-key';process.env.SESSION_SECRET='test-secret';process.env.UPLOAD_PASSWORD='test-upload';
  const res=response();await handler(request(),res);assert.equal(res.statusCode,401);
  const uploader=signSession({sid,role:'uploader',exp:Date.now()+10000},'test-secret');
  const review=response();await handler(request({method:'PATCH',action:'review',cookie:uploader,body:{...app(),status:'approved'}}),review);assert.equal(review.statusCode,403);
  const crossOrigin=response();await handler(request({method:'POST',action:'submit',cookie:uploader,origin:'https://attacker.example'}),crossOrigin);assert.equal(crossOrigin.statusCode,403);
});
