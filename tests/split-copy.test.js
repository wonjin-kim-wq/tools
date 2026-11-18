const test = require('node:test');
const assert = require('node:assert/strict');
const { project, copy, check, TABLES } = require('../scripts/split-copy');

// 두 Supabase 프로젝트(REST·Storage)를 메모리로 흉내 낸다.
function fakeProject(host, seed = {}) {
  const tables = Object.fromEntries(TABLES.map(([t]) => [t, structuredClone(seed[t] || [])]));
  const files = new Map(Object.entries(seed.files || {}));
  return { host, tables, files, async handle(url, options) {
    const u = new URL(url), method = options.method || 'GET';
    let m = u.pathname.match(/^\/rest\/v1\/(\w+)$/);
    if (m) {
      const rows = tables[m[1]];
      if (method === 'GET') { const [from, to] = options.headers.Range.split('-').map(Number); return Response.json(rows.slice(from, to + 1)); }
      if (method === 'DELETE') { rows.length = 0; return new Response(null, { status: 204 }); }
      if (method === 'POST') { rows.push(...JSON.parse(options.body)); return new Response(null, { status: 201 }); }
    }
    if (u.pathname === '/storage/v1/object/list/chamcoding-screenshots') {
      const prefix = JSON.parse(options.body).prefix, seen = new Map();
      for (const [path, body] of files) {
        if (prefix && !path.startsWith(prefix + '/')) continue;
        const rest = prefix ? path.slice(prefix.length + 1) : path, [name, ...more] = rest.split('/');
        seen.set(name, more.length ? { name, id: null } : { name, id: name, metadata: { size: body.length, mimetype: 'image/png' } });
      }
      return Response.json([...seen.values()]);
    }
    m = u.pathname.match(/^\/storage\/v1\/object\/chamcoding-screenshots\/(.+)$/);
    if (m && method === 'GET') return new Response(files.get(m[1]));
    if (m && method === 'POST') { files.set(m[1], Buffer.from(options.body)); return new Response('{}'); }
    return new Response('not mocked', { status: 500 });
  } };
}

test('split copy reproduces every tools_ table and screenshot in the new project, and check detects drift', async () => {
  const original = global.fetch, env = { ...process.env }, log = console.log;
  const app = { id: 'a1', name: '모둠 뽑기', screenshots: [{ path: 'uploads/s1/f1.png' }] };
  const oldP = fakeProject('old.supabase.co', { tools_apps: [app], tools_reviews: [{ id: 'r1', app_id: 'a1' }], tools_admins: [{ id: 1 }], files: { 'uploads/s1/f1.png': Buffer.from('png-1'), 'uploads/s2/f2.png': Buffer.from('png-2') } });
  const newP = fakeProject('new.supabase.co', { tools_apps: [{ id: 'stale' }] });
  global.fetch = (url, options = {}) => (new URL(url).host === oldP.host ? oldP : newP).handle(url, options);
  Object.assign(process.env, { OLD_SUPABASE_URL: 'https://old.supabase.co', OLD_SERVICE_ROLE_KEY: 'k1', NEW_SUPABASE_URL: 'https://new.supabase.co', NEW_SERVICE_ROLE_KEY: 'k2' });
  console.log = () => {};
  try {
    const [a, b] = [project('OLD'), project('NEW')];
    assert.equal(await check(a, b), false);
    await copy(a, b);
    assert.deepEqual(newP.tables.tools_apps, [app]);
    assert.equal(newP.files.get('uploads/s2/f2.png').toString(), 'png-2');
    assert.equal(await check(a, b), true);
    newP.files.set('uploads/s1/f1.png', Buffer.from('png-x'));
    assert.equal(await check(a, b), false, 'file content drift is reported');
  } finally { global.fetch = original; process.env = env; console.log = log; }
});
