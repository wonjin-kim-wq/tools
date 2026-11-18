const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { signSession } = require('../lib/tools-core');
const handler = require('../api/tools');

test('verified members submit with their own images and see only their own web and MCP requests', async () => {
  const secret = 'member-upload-test-only';
  Object.assign(process.env, {
    SUPABASE_URL: 'https://upload.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-key', SESSION_SECRET: secret
  });
  const originalFetch = global.fetch;
  const user = () => ({
    id: randomUUID(), email_confirmed_at: '2026-11-18T00:00:00Z', app_metadata: { chamcoding_member: true }
  });
  const a = user(), b = user();
  a.app_metadata.chamcoding_content_access = false;
  const users = new Map([['member-a', a], ['member-b', b], ['unverified', { ...user(), email_confirmed_at: null }],
    ['blocked', { ...user(), app_metadata: { chamcoding_member: false } }]]);
  const apps = [
    { id: randomUUID(), member_id: a.id, status: 'pending', name: 'MCP 요청', source: 'mcp', is_example: false },
    { id: randomUUID(), member_id: b.id, status: 'pending', name: '다른 회원 요청', contact_email: 'private@example.com', is_example: false },
    { id: randomUUID(), status: 'pending', name: '기존 요청', is_example: false }
  ];
  const uploads = [];
  const adminSid = randomUUID();
  global.fetch = async (input, options = {}) => {
    const url = new URL(input), params = url.searchParams;
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    const body = options.body && !Buffer.isBuffer(options.body) ? JSON.parse(options.body) : {};
    if (url.pathname === '/auth/v1/user') {
      const account = users.get(options.headers.Authorization.split(' ')[1]);
      return account ? json(account) : json({}, 401);
    }
    if (url.pathname === '/auth/v1/token' && params.get('grant_type') === 'refresh_token') {
      assert.equal(body.refresh_token, 'refresh-a');
      return json({ user: a, access_token: 'member-a', refresh_token: 'refresh-a' });
    }
    if (url.pathname === '/rest/v1/tools_admins') return json([{ id: 1, salt: 'admin-version' }]);
    if (url.pathname === '/rest/v1/rpc/tools_check_rate') return json(true);
    if (url.pathname.startsWith('/storage/v1/object/')) {
      if (url.pathname.includes('/sign/')) return json([]);
      return json({});
    }
    if (url.pathname === '/rest/v1/tools_uploads') {
      if (options.method === 'POST') { uploads.push(body); return json({}); }
      return json(uploads.filter(image => params.get('path') === 'eq.' + image.path && params.get('session_id') === 'eq.' + image.session_id));
    }
    if (url.pathname === '/rest/v1/tools_apps') {
      if (options.method === 'POST') {
        if (apps.some(app => app.member_id === body.member_id && app.web_url === body.web_url)) return json({}, 409);
        const app = { ...body, id: randomUUID(), is_example: false };
        apps.push(app);
        return json([app]);
      }
      const rows = apps.filter(app => !params.has('member_id') ||
        (params.get('member_id') === 'eq.' + app.member_id && params.get('is_example') === 'eq.' + app.is_example));
      const fields = params.get('select');
      return json(fields === '*' ? rows : rows.map(app => Object.fromEntries(fields.split(',').map(field => [field, app[field]]))));
    }
    throw new Error(`Unexpected fetch ${url.pathname}`);
  };
  const sign = role => 'chamcoding_session=' + signSession({ role, sid: adminSid, exp: Date.now() + 60000,
    ...(role === 'admin' ? { av: 'admin-version' } : {}) }, secret);
  const memberCookie = name => 'chamcoding_member=' + name;
  const aCookie = memberCookie('member-a'), bCookie = memberCookie('member-b');
  const adminCookie = sign('admin'), legacy = sign('uploader');
  const invoke = async (action, cookie = '', method = 'GET', body = {}) => {
    const req = { url: `/api/tools?action=${action}`, method, body, headers: {
      host: 'tools.test', origin: 'https://tools.test', 'content-type': 'application/json', cookie
    }};
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; },
      json(data) { this.data = data; } };
    await handler(req, res);
    return res;
  };
  const image = { data: Buffer.from([255,216,255,224,0,0,0,0,0,0,0,0]).toString('base64') };
  try {
    for (const cookie of ['', legacy, adminCookie]) {
      assert.equal((await invoke('upload', cookie, 'POST', image)).code, 401);
      assert.equal((await invoke('submit', cookie, 'POST')).code, 401);
      assert.equal((await invoke('queue', cookie)).code, 401);
    }
    for (const name of ['unverified', 'blocked']) {
      assert.equal((await invoke('upload', memberCookie(name), 'POST', image)).code, 403);
    }
    assert.equal((await invoke('login', '', 'POST', { kind: 'uploader' })).code, 400);
    assert.equal((await invoke('upload-password', adminCookie)).code, 404);
    assert.equal((await invoke('queue&scope=admin', aCookie)).code, 401);
    assert.equal((await invoke('upload&scope=admin', aCookie, 'POST', image)).code, 401);
    const adminImage = await invoke('upload&scope=admin', aCookie + '; ' + adminCookie, 'POST', image);
    assert.equal(adminImage.code, 201);
    assert.match(adminImage.data.path, new RegExp('^uploads/' + adminSid + '/'));

    const uploaded = await invoke('upload', aCookie + '; ' + adminCookie, 'POST', image);
    assert.equal(uploaded.code, 201);
    assert.ok(!uploaded.data.path.includes(a.id));
    const body = { name: '직접 요청', web_url: 'https://example.com/app', short: '소개', description: '설명',
      cat: '교과 교육', subjects: ['수학'], grade: '초등학교 3-3학년', author_name: '제작자',
      contact_email: 'private@example.com', screenshots: [{ path: uploaded.data.path, caption: '첫 화면' }],
      consent: true, status: 'approved', member_id: b.id, source: 'mcp' };
    assert.equal((await invoke('submit', bCookie, 'POST', body)).code, 403);
    assert.equal((await invoke('submit', aCookie, 'POST', { ...body, consent: false })).code, 400);
    assert.equal((await invoke('submit', aCookie, 'POST', { ...body, screenshots: [{ path: uploaded.data.path.replace(/[^/]+$/, randomUUID() + '.jpg'), caption: '없음' }] })).code, 400);
    const submitted = await invoke('submit', 'chamcoding_member_refresh=refresh-a', 'POST', body);
    assert.equal(submitted.code, 201);
    assert.equal(apps.at(-1).member_id, a.id);
    assert.equal(apps.at(-1).status, 'pending');
    assert.equal(apps.at(-1).source, 'web');
    assert.equal((await invoke('submit', aCookie, 'POST', body)).code, 409);

    const own = await invoke('queue', aCookie + '; ' + adminCookie);
    assert.equal(own.code, 200);
    assert.deepEqual(own.data.apps.map(app => app.name), ['MCP 요청', '직접 요청']);
    assert.ok(own.data.apps.every(app => !app.member_id && !app.contact_email));
    assert.deepEqual((await invoke('queue', bCookie)).data.apps.map(app => app.name), ['다른 회원 요청']);
    assert.equal((await invoke('queue&scope=admin', adminCookie)).data.apps.length, 4);
  } finally {
    global.fetch = originalFetch;
  }
});
