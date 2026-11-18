#!/usr/bin/env node
// 참코딩 DB 분리: 기존 quiz-games 프로젝트의 tools_ 테이블과 스크린샷 파일을 새 참코딩 전용 프로젝트로 복사한다.
//   node --env-file=.env.migration scripts/split-copy.js check   # 두 프로젝트의 행·파일을 비교만 한다
//   node --env-file=.env.migration scripts/split-copy.js copy    # 새 프로젝트의 tools_ 데이터를 비우고 기존 값으로 다시 채운다
// 필요한 값(.env.migration, Git 제외): OLD_SUPABASE_URL, OLD_SERVICE_ROLE_KEY, NEW_SUPABASE_URL, NEW_SERVICE_ROLE_KEY
// 키와 행 내용은 출력하지 않는다. 회원 계정은 supabase/split/*-members.sql로 먼저 옮긴다(tools_api_tokens가 회원을 참조).
const { createHash } = require('node:crypto');

const BUCKET = 'chamcoding-screenshots';
// 부모 → 자식 순서. tools_rate_limits는 잠깐 쓰는 요청 제한 기록이라 옮기지 않는다.
const TABLES = [
  ['tools_admins', 'id'], ['tools_visit_total', 'id'], ['tools_visit_daily', 'day'], ['tools_uploads', 'path'],
  ['tools_apps', 'id'], ['tools_reviews', 'id'], ['tools_rank_daily', 'day,app_id'], ['tools_use_daily', 'day,app_id'],
  ['tools_dev_requests', 'id'], ['tools_inquiries', 'id'], ['tools_api_tokens', 'id']
];

function project(prefix) {
  const url = process.env[`${prefix}_SUPABASE_URL`]?.replace(/\/$/, ''), key = process.env[`${prefix}_SERVICE_ROLE_KEY`];
  if (!url || !key) throw new Error(`${prefix}_SUPABASE_URL / ${prefix}_SERVICE_ROLE_KEY 가 .env.migration에 필요해요.`);
  const call = async (path, { method = 'GET', headers = {}, body, raw = false } = {}) => {
    const response = await fetch(`${url}${path}`, {
      method, body, signal: AbortSignal.timeout(60000),
      headers: { apikey: key, Authorization: `Bearer ${key}`, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers }
    });
    if (!response.ok) throw new Error(`${prefix} ${method} ${path.split('?')[0]} → ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response;
  };
  return { name: prefix, host: new URL(url).host, call };
}

async function rows(p, table, order) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const page = await (await p.call(`/rest/v1/${table}?select=*&order=${order}`, { headers: { Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } })).json();
    all.push(...page);
    if (page.length < 1000) return all;
  }
}
// 두 프로젝트의 칸 순서가 달라도(나중에 ALTER로 추가한 칸) 같은 값이면 같게 보도록 키를 정렬해 비교한다.
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex').slice(0, 12);

async function files(p) {
  // uploads/<세션>/<파일> 두 단계 폴더를 모두 훑는다.
  const list = async prefix => (await p.call(`/storage/v1/object/list/${BUCKET}`, { method: 'POST', body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }) })).json();
  const out = [];
  const walk = async prefix => {
    for (const item of await list(prefix)) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id) out.push({ path, size: item.metadata?.size ?? null, type: item.metadata?.mimetype || 'application/octet-stream' });
      else await walk(path);
    }
  };
  await walk('');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
const download = async (p, path) => Buffer.from(await (await p.call(`/storage/v1/object/${BUCKET}/${path}`)).arrayBuffer());

async function check(oldP, newP, { deep = true } = {}) {
  let same = true;
  console.log(`비교: ${oldP.host} → ${newP.host}`);
  for (const [table, order] of TABLES) {
    const [a, b] = await Promise.all([rows(oldP, table, order), rows(newP, table, order)]);
    const ok = a.length === b.length && digest(a) === digest(b);
    same &&= ok;
    console.log(`${ok ? '✓' : '✗'} ${table.padEnd(20)} 기존 ${String(a.length).padStart(4)} · 새 ${String(b.length).padStart(4)}${ok ? '' : ` (내용 ${digest(a)} ≠ ${digest(b)})`}`);
  }
  const [fa, fb] = await Promise.all([files(oldP), files(newP)]);
  const missing = fa.filter(f => !fb.some(g => g.path === f.path));
  let changed = 0;
  if (deep) for (const f of fa.filter(f => !missing.includes(f))) if (digest(await download(oldP, f.path)) !== digest(await download(newP, f.path))) changed++;
  const filesOk = !missing.length && !changed && fa.length === fb.length;
  same &&= filesOk;
  console.log(`${filesOk ? '✓' : '✗'} ${'스크린샷 파일'.padEnd(17)} 기존 ${String(fa.length).padStart(4)} · 새 ${String(fb.length).padStart(4)}${missing.length ? ` · 없음 ${missing.length}` : ''}${changed ? ` · 내용 다름 ${changed}` : ''}${deep ? ' (파일 내용까지 비교)' : ''}`);
  return same;
}

async function copy(oldP, newP) {
  // 자식부터 비운다. tools_apps를 지우면 리뷰·순위·사용 기록도 함께 지워진다.
  for (const [table, order] of [...TABLES].reverse()) {
    try {
      await newP.call(`/rest/v1/${table}?${order.split(',')[0]}=not.is.null`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    } catch (error) {
      // tools_api_tokens는 서버도 지우지 못하게 DELETE 권한을 주지 않았다(폐기는 revoked_at). 비어 있을 때만 그대로 진행한다.
      if ((await rows(newP, table, order)).length) throw error;
    }
  }
  for (const [table, order] of TABLES) {
    const data = await rows(oldP, table, order);
    for (let i = 0; i < data.length; i += 200) {
      await newP.call(`/rest/v1/${table}`, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(data.slice(i, i + 200)) });
    }
    console.log(`복사 ${table}: ${data.length}행`);
  }
  const [fa, fb] = await Promise.all([files(oldP), files(newP)]);
  let copied = 0;
  for (const f of fa) {
    const existing = fb.find(g => g.path === f.path);
    if (existing && existing.size === f.size) continue;
    await newP.call(`/storage/v1/object/${BUCKET}/${f.path}`, { method: 'POST', raw: true, body: await download(oldP, f.path), headers: { 'Content-Type': f.type, 'x-upsert': 'true' } });
    copied++;
  }
  console.log(`복사 스크린샷: 새로 올린 파일 ${copied}개 / 전체 ${fa.length}개`);
}

async function main() {
  const mode = process.argv[2];
  if (!['check', 'copy'].includes(mode)) throw new Error('사용법: node --env-file=.env.migration scripts/split-copy.js check|copy');
  const oldP = project('OLD'), newP = project('NEW');
  if (oldP.host === newP.host) throw new Error('기존과 새 프로젝트 주소가 같아요. .env.migration을 확인해 주세요.');
  if (mode === 'copy') await copy(oldP, newP);
  const ok = await check(oldP, newP);
  console.log(ok ? '결과: 두 프로젝트의 참코딩 데이터가 같아요.' : '결과: 다른 항목이 있어요.');
  process.exitCode = ok ? 0 : 1;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { project, copy, check, TABLES };
