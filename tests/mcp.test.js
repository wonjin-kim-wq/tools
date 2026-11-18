const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const mcp = require('../api/mcp');
const web = require('../api/tools');

Object.assign(process.env, {
  SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture', SESSION_SECRET: 'fixture'
});

async function request(handler, { body, method = 'POST', url = '/mcp', headers = {} } = {}) {
  const response = { headers: {} };
  const res = {
    setHeader(key, value) { response.headers[key] = value; },
    status(status) { response.status = status; return this; },
    json(value) { response.body = JSON.parse(JSON.stringify(value)); },
    end() {}
  };
  await handler({ url, method, body, headers: { 'content-type': 'application/json', ...headers } }, res);
  return response;
}

const rpc = (method, params, token, overrides = {}) => request(mcp, {
  body: { jsonrpc: '2.0', id: 7, method, params },
  headers: token ? { authorization: `Bearer ${token}` } : {},
  ...overrides
});
const tool = (name, args, token, overrides) => rpc('tools/call', { name, arguments: args }, token, overrides);
const result = response => response.body.result.structuredContent;

test('MCP initializes, negotiates a supported version and exposes public tools without a cookie', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.body.id, 7);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal(init.body.result.serverInfo.name, 'chamcoding');
  assert.equal(init.headers['Mcp-Session-Id'], undefined);
  assert.deepEqual((await rpc('ping')).body.result, {});
  assert.deepEqual((await rpc('tools/list')).body.result.tools.map(t => t.name), ['list_options', 'search_apps', 'get_app']);
  assert.equal(result(await tool('list_options')).screenshots.max, 6);
  assert.equal((await request(mcp, { body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
  assert.equal((await request(mcp, { method: 'GET' })).status, 405);
  assert.equal((await request(mcp, { body: '{' })).body.error.code, -32700);
  assert.equal((await rpc('ping', {}, null, { headers: { 'mcp-protocol-version': 'unknown' } })).status, 400);
  assert.equal((await rpc('ping', {}, null, { headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal(result(await tool('register_app', {}, null, { headers: { cookie: 'chamcoding_member=present' } })).code, 'AUTH_REQUIRED');
});

test('MCP member API and tools enforce token, upload, ownership and submission constraints', async t => {
  const account = { id: randomUUID(), email: 'teacher@example.com', email_confirmed_at: '2026-11-18',
    app_metadata: { chamcoding_member: true, chamcoding_content_access: false }, user_metadata: { display_name: '참코딩 회원' } };
  const other = { ...account, id: randomUUID(), email: 'other@example.com' };
  const users = [account, other];
  const tokens = [], uploads = [], apps = [];
  const rates = new Map();
  const response = data => new Response(data == null ? null : JSON.stringify(data), { status: data == null ? 204 : 200 });
  let memberCookie = account;
  let raceDuplicate = false, raceUpdate = false, blockRate = false;

  t.mock.method(global, 'fetch', async (target, options) => {
    const url = new URL(target);
    const body = options.body && !options.raw && !Buffer.isBuffer(options.body) ? JSON.parse(options.body) : options.body;
    const eq = key => url.searchParams.get(key)?.slice(3);
    const filter = (row, key) => !url.searchParams.has(key) || String(row[key]) === eq(key);
    const project = rows => {
      const fields = url.searchParams.get('select');
      return fields && fields !== '*' ? rows.map(row => Object.fromEntries(fields.split(',').map(key => [key, row[key]]))) : rows;
    };
    if (url.pathname === '/auth/v1/user') return response(memberCookie);
    if (url.pathname.startsWith('/auth/v1/admin/users/')) return response(users.find(u => u.id === url.pathname.split('/').at(-1)));
    if (url.pathname === '/rest/v1/rpc/tools_check_rate') {
      const count = (rates.get(body.p_key) || 0) + 1;
      rates.set(body.p_key, count);
      return response(!blockRate && count <= body.p_limit);
    }
    if (url.pathname === '/rest/v1/rpc/tools_issue_api_token') {
      if (tokens.some(r => r.member_id === body.p_member_id && !r.revoked_at)) return response(null);
      const row = { id: randomUUID(), member_id: body.p_member_id, name: body.p_name, token_hash: body.p_token_hash,
        prefix: body.p_prefix, revoked_at: null, created_at: new Date().toISOString(), last_used_at: null };
      tokens.push(row);
      const { token_hash, member_id, ...safe } = row;
      return response(safe);
    }
    if (url.pathname === '/rest/v1/tools_api_tokens') {
      const rows = tokens.filter(r => !r.revoked_at && ['member_id', 'id', 'token_hash'].every(key => filter(r, key)));
      if (options.method === 'PATCH') rows.forEach(r => Object.assign(r, body));
      return response(project(rows));
    }
    if (url.pathname === '/rest/v1/tools_uploads') {
      if (options.method === 'POST') { uploads.push(body); return response(null); }
      return response(project(uploads.filter(r => filter(r, 'session_id') && filter(r, 'path'))));
    }
    if (url.pathname.startsWith('/storage/v1/object/sign/')) {
      return response(body.paths.map(path => ({ path, signedURL: `/object/sign/chamcoding-screenshots/${path}?token=fixture` })));
    }
    if (url.pathname.startsWith('/storage/v1/object/')) {
      assert.equal(options.headers['Content-Type'], 'image/png');
      return response({});
    }
    if (url.pathname === '/rest/v1/tools_apps') {
      if (options.method === 'POST') {
        assert.equal(url.searchParams.get('on_conflict'), 'member_id,web_url');
        assert.match(options.headers.Prefer, /ignore-duplicates/);
        assert.equal(body.source, 'mcp');
        assert.equal(body.status, 'pending');
        assert.equal(body.member_id, account.id);
        assert.equal(body.mcp_member_name, account.user_metadata.display_name);
        assert.ok(Date.parse(body.own_work_confirmed_at));
        const row = { ...body, id: randomUUID(), version: 1, is_example: false, review_note: '' };
        apps.push(row);
        return response(project(raceDuplicate ? [] : [row]));
      }
      const rows = apps.filter(r => ['member_id', 'id', 'web_url', 'source', 'is_example', 'version', 'category'].every(key => filter(r, key)) &&
        (url.searchParams.get('status')?.startsWith('in.') ? ['pending', 'changes_requested'].includes(r.status) : filter(r, 'status')));
      if (options.method === 'PATCH') {
        assert.equal(url.searchParams.get('status'), 'in.(pending,changes_requested)');
        assert.ok(url.searchParams.has('version'));
        if (raceUpdate) return response([]);
        rows.forEach(row => Object.assign(row, body, { version: row.version + 1 }));
      }
      return response(project(rows));
    }
    throw new Error('Unexpected test request');
  });

  const memberApi = (action, method = 'GET', body, extraHeaders = {}) => request(web, {
    method, url: `/api/tools?action=${action}`, body,
    headers: { host: 'www.chamssaem.kr', origin: 'https://www.chamssaem.kr', cookie: 'chamcoding_member=fixture', ...extraHeaders }
  });
  const create = name => memberApi('mcp-token', 'POST', { name });
  assert.equal((await memberApi('mcp-token', 'POST', { name: 'CSRF' }, { origin: 'https://other.example' })).status, 403);
  assert.equal((await memberApi('mcp-tokens', 'GET', null, { cookie: '' })).status, 401);
  memberCookie = { ...account, email_confirmed_at: null };
  assert.equal((await create('미인증')).status, 403);
  memberCookie = account;
  const first = await create('Codex');
  assert.equal(first.status, 201);
  const { token, record } = first.body;
  assert.match(token, /^chm_live_[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens[0].token_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(record.token_hash, undefined);
  assert.equal((await create('두 번째 연결')).status, 409);
  const listed = (await memberApi('mcp-tokens')).body.tokens;
  assert.equal(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(token));
  assert.equal(listed[0].token_hash, undefined);

  assert.equal((await rpc('tools/list', {}, `chm_live_${randomBytes(32).toString('base64url')}`)).status, 401);
  assert.equal((await rpc('tools/list', {}, 'invalid')).status, 401);
  assert.equal((await rpc('tools/list', {}, token)).body.result.tools.length, 7);
  assert.ok(tokens[0].last_used_at);

  const img = { data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2T8AAAAASUVORK5CYII=', caption: '시작 화면' };
  const shot = result(await tool('upload_screenshot', img, token));
  assert.ok(shot.path.startsWith(`uploads/${record.id}/`));
  const app = { name: '모둠 활동', web_url: 'https://class.example/?a=1&b=2', short: '수업에 써요', description: '수업 안내',
    cat: '교과 교육', grade: '전학년', subjects: ['수학'], screenshots: [shot] };
  const invalid = await tool('register_app', { ...app, cat: '잘못된 분류', dry_run: true }, token);
  assert.equal(invalid.body.result.isError, true);
  assert.equal(result(invalid).field, 'cat');
  assert.ok(result(invalid).allowed.includes('교과 교육'));
  memberCookie = other;
  const stranger = (await create('다른 회원')).body.token;
  memberCookie = account;
  assert.equal(result(await tool('register_app', { ...app, dry_run: true }, stranger)).status, 403);
  assert.equal(result(await tool('register_app', app, token)).field, 'confirm_own_work');
  assert.equal(result(await tool('register_app', { ...app, confirm_own_work: true }, token)).field, 'confirmation_id');
  const preview = result(await tool('register_app', { ...app, dry_run: true }, token));
  assert.ok(preview.requires_confirmation && preview.confirmation_question);
  assert.equal(apps.length, 0);
  const submission = { ...app, confirm_own_work: true, confirmation_id: preview.confirmation_id };
  assert.equal(result(await tool('register_app', { ...submission, description: '바뀐 설명' }, token)).field, 'confirmation_id');
  const created = result(await tool('register_app', submission, token));
  assert.equal(created.created, true);
  assert.equal(created.app.status, 'pending');
  assert.equal((await tool('register_app', submission, token)).body.result.structuredContent.created, false);
  const next = { ...app, web_url: 'https://race.example/' };
  const racePreview = result(await tool('register_app', { ...next, dry_run: true }, token));
  raceDuplicate = true;
  assert.equal(result(await tool('register_app', { ...next, confirm_own_work: true, confirmation_id: racePreview.confirmation_id }, token)).created, false);
  raceDuplicate = false;
  assert.equal(result(await tool('get_app', { id: created.app.id })).status, 404);
  assert.deepEqual(result(await tool('search_apps', { category: '교과 교육', q: '모둠' })).apps, []);

  memberCookie = other;
  assert.deepEqual(result(await tool('list_my_apps', {}, stranger)).apps, []);
  assert.equal(result(await tool('update_app', { id: created.app.id, version: 1, name: '타인 수정' }, stranger)).status, 404);
  assert.equal((await memberApi('mcp-token', 'PATCH', { id: record.id })).status, 404);

  memberCookie = account;
  assert.equal((await memberApi('mcp-token', 'PATCH', { id: record.id })).status, 200);
  assert.equal((await rpc('tools/list', {}, token)).status, 401);
  const replacement = await create('폐기 후 다시 발급');
  assert.equal(replacement.status, 201);
  const nextToken = replacement.body.token;

  const row = apps.find(r => r.id === created.app.id);
  row.status = 'changes_requested';
  row.review_note = '설명을 보완해 주세요.';
  const own = result(await tool('list_my_apps', {}, nextToken)).apps.find(r => r.id === row.id);
  assert.equal(own.review_note, row.review_note);
  raceUpdate = true;
  assert.equal(result(await tool('update_app', { id: row.id, version: 1, name: '다른 창에서 저장' }, nextToken)).status, 409);
  raceUpdate = false;
  const updated = result(await tool('update_app', { id: row.id, version: 1, name: '수정 앱' }, nextToken));
  assert.equal(updated.app.version, 2);
  assert.equal(updated.app.status, 'pending');
  assert.equal(updated.app.name, '수정 앱');
  assert.equal(row.screenshots[0].path, shot.path);
  assert.equal(result(await tool('update_app', { id: row.id, version: 1, name: '이전 버전' }, nextToken)).status, 409);
  row.status = 'approved';
  assert.equal(result(await tool('update_app', { id: row.id, version: 2, name: '승인 후 수정' }, nextToken)).status, 409);
  const publicApp = result(await tool('get_app', { id: row.id })).app;
  for (const key of ['contact_email', 'review_note', 'member_id', 'mcp_member_name', 'own_work_confirmed_at', 'submitted_session']) {
    assert.equal(publicApp[key], undefined);
  }
  assert.ok(publicApp.screenshots[0].url.startsWith('https:'));
  assert.equal(publicApp.screenshots[0].path, undefined);

  blockRate = true;
  const capped = await tool('upload_screenshot', img, nextToken);
  assert.equal(capped.body.result.isError, true);
  assert.equal(result(capped).status, 429);
  blockRate = false;
  account.app_metadata.chamcoding_member = false;
  assert.equal((await rpc('tools/list', {}, nextToken)).status, 401);
  account.app_metadata.chamcoding_member = true;
  assert.equal((await create('중복 1')).status, 409);
  assert.equal((await create('중복 2')).status, 409);
  assert.equal((await create('시간당 6번째')).status, 429);
});
