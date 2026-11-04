const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { signSession, hashPassword } = require('../lib/tools-core');
const { capture, clean, describe, findVideo, hostGuard, privateAddress, SCHEMA } = require('../lib/autofill');
const { handler } = require('../api/autofill');

test('private, loopback and reserved addresses are blocked', () => {
  for (const ip of ['127.0.0.1','10.1.2.3','172.20.0.1','192.168.0.10','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','fd00::1','fe80::1','::ffff:127.0.0.1','::ffff:10.0.0.1','64:ff9b::a00:1','64:ff9b::7f00:1','64:ff9b::127.0.0.1','64:ff9b::1:2:3','not-an-ip']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8','76.76.21.21','2606:4700::1111','64:ff9b::401d:1103','64:ff9b::8.8.8.8']) assert.equal(privateAddress(ip), false, ip);
});

test('host guard resolves names and refuses any internal answer', async () => {
  const answers = { 'app.example.com':[{address:'76.76.21.21'}], 'inside.example.com':[{address:'10.0.0.5'}], 'mixed.example.com':[{address:'76.76.21.21'},{address:'127.0.0.1'}] };
  let lookups = 0;
  const guard = hostGuard(async host => { lookups++; if (!answers[host]) throw new Error('ENOTFOUND'); return answers[host]; });
  assert.equal(await guard('app.example.com'), true);
  assert.equal(await guard('APP.example.com'), true);
  assert.equal(lookups, 1, 'same host is looked up once per request');
  for (const host of ['inside.example.com','mixed.example.com','missing.example.com','localhost','printer.local','[::1]','127.0.0.1']) assert.equal(await guard(host), false, host);
  await assert.rejects(capture('https://inside.example.com/', { guard }), { status: 400 });
});

test('intro video comes only from links on the page', () => {
  assert.equal(findVideo(['https://example.com/','https://www.youtube.com/watch?v=abcdefghijk&t=3']), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(findVideo(['https://www.youtube.com/embed/abcdefghijk?rel=0']), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(findVideo(['https://youtu.be/abcdefghijk']), 'https://youtu.be/abcdefghijk');
  assert.equal(findVideo(['https://player.vimeo.com/video/123456789']), 'https://vimeo.com/123456789');
  assert.equal(findVideo(['http://youtu.be/abcdefghijk','javascript:alert(1)','https://youtube.com/']), '');
});

test('AI draft is cleaned to the upload form rules', () => {
  const fields = clean({ name:'가'.repeat(80), short:'짧은 소개', description:'설명', category:'없는 분류', subjects:['수학','코딩','수학','과학','국어','영어'], school_level:'중학교', grade_from:2, grade_to:9, notes:['  ','v2 추가'] }, { links:[] });
  assert.equal(fields.name.length, 60);
  assert.equal(fields.cat, '기타');
  assert.deepEqual(fields.subjects, ['수학','과학','국어']);
  assert.equal(fields.grade, '중학교 2-3학년');
  assert.deepEqual(fields.notes, ['v2 추가']);
  assert.equal(clean({ school_level:'대학교', grade_from:5, grade_to:2, subjects:[] }, {}).grade, '초등학교 5-5학년');
  assert.deepEqual(clean({ subjects:[] }, {}).subjects, ['교과 무관']);
});

test('Claude request uses structured output, the screenshot, and fallbacks; refusals become a friendly error', async () => {
  const page = { screenshot:'aGVsbG8=', finalUrl:'https://app.example.com/', title:'분수 놀이', text:'분수를 비교해요', links:[] };
  let sent;
  const draft = { name:'분수 놀이', short:'분수 비교', description:'설명', category:'교과 교육', subjects:['수학'], school_level:'초등학교', grade_from:3, grade_to:4, notes:[], screenshot_caption:'첫 화면' };
  const result = await describe(page, { call: async request => { sent = request; return { stop_reason:'end_turn', content:[{ type:'text', text:JSON.stringify(draft) }] }; } });
  assert.deepEqual(result, draft);
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.fallbacks, 'default');
  assert.deepEqual(sent.output_config.format, { type:'json_schema', schema:SCHEMA });
  assert.equal(sent.messages[0].content[0].source.data, 'aGVsbG8=');
  assert.match(sent.messages[0].content[1].text, /분수를 비교해요/);
  await assert.rejects(describe(page, { call: async () => ({ stop_reason:'refusal', content:[] }) }), { status: 422 });
  await assert.rejects(describe(page, { call: async () => { throw new Error('network'); } }), { status: 502 });
});

test('autofill API: uploaders and admins only, needs the AI key, validates the address', async () => {
  const originalFetch = global.fetch, originalKey = process.env.ANTHROPIC_API_KEY, secret = 'autofill-test-secret', sid = randomUUID();
  Object.assign(process.env,{SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-key',SESSION_SECRET:secret,UPLOAD_PASSWORD:'test-upload'});
  const credential = hashPassword('local-test-only-password');
  const admin = {id:1,username:'local-test-admin',salt:credential.salt,password_hash:credential.hash};
  global.fetch = async input => {
    const path = new URL(input).pathname;
    const data = path === '/rest/v1/tools_admins' ? [admin] : path === '/rest/v1/rpc/tools_check_rate' ? true : null;
    if (data === null) throw new Error(`Unexpected route ${path}`);
    return new Response(JSON.stringify(data), {status:200,headers:{'content-type':'application/json'}});
  };
  const uploader = `chamcoding_session=${signSession({sid,role:'uploader',exp:Date.now()+100000},secret)}`;
  const calls = [];
  const fake = async url => { calls.push(url); return { fields:{ name:'앱' }, screenshot:{ data:'x', caption:'첫 화면' } }; };
  const call = async ({ method='POST', body={ url:'https://app.example.com' }, cookie, origin='https://tools.example.com' } = {}) => {
    const res = {headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}};
    await handler({method,url:'/api/autofill',body,headers:{host:'tools.example.com',origin,'content-type':'application/json',...(cookie?{cookie}:{})},socket:{remoteAddress:'127.0.0.1'}}, res, { autofill: fake });
    return res;
  };
  try {
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal((await call({ method:'GET' })).statusCode, 405);
    assert.equal((await call({ origin:'https://evil.example.com', cookie:uploader })).statusCode, 403);
    assert.equal((await call()).statusCode, 401);
    assert.equal((await call({ cookie:uploader })).statusCode, 503, 'no AI key yet');
    process.env.ANTHROPIC_API_KEY = 'test-only-key';
    for (const url of ['http://app.example.com','https://127.0.0.1/','javascript:alert(1)','']) assert.equal((await call({ cookie:uploader, body:{ url } })).statusCode, 400, url);
    const ok = await call({ cookie:uploader });
    assert.equal(ok.statusCode, 200); assert.equal(ok.data.fields.name, '앱');
    assert.deepEqual(calls, ['https://app.example.com/']);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = originalKey;
  }
});
