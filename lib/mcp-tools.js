const { createHmac } = require('node:crypto');
const { AppError, CATEGORIES, SUBJECTS, equal, text, validateApp, webUrl } = require('./tools-core');

const string = (maxLength, options = {}) => ({ type: 'string', maxLength, ...options });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
function object(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}
const appFields = {
  name: string(60),
  web_url: string(2000, { description: '공개된 HTTPS 웹앱 주소' }),
  short: string(160),
  description: string(6000),
  cat: string(30, { enum: CATEGORIES }),
  subjects: { ...array(string(30, { enum: SUBJECTS }), SUBJECTS.length), minItems: 1 },
  grade: string(80, { description: '예: 초등학교 3-4학년, 전학년' }),
  screenshots: {
    ...array(object({ path: string(200), caption: string(250) }, ['path', 'caption']), 6),
    minItems: 1, description: 'upload_screenshot에서 받은 경로와 설명. 첫 이미지가 대표 이미지.'
  },
  video_url: string(2000),
  demo_url: string(2000),
  notes: array(string(250), 12),
  author_name: string(60, { description: '생략하면 참코딩 회원 이름' })
};
const pageFields = { limit: { type: 'integer', minimum: 1, maximum: 25 }, offset: { type: 'integer', minimum: 0, maximum: 100000 } };
const idField = string(36, { format: 'uuid' });
const tool = (name, description, inputSchema, annotations) => ({ name, description, inputSchema, annotations });
const readOnly = { readOnlyHint: true };
const tools = [
  tool('list_options', '참코딩 앱 등록에 쓰는 카테고리, 교과, 글과 스크린샷 제한을 확인합니다.', object(), readOnly),
  tool('search_apps', '승인된 공개 앱을 키워드, 카테고리, 교과로 검색합니다.', object({
    q: string(100), category: appFields.cat, subject: string(30, { enum: SUBJECTS }), ...pageFields
  }), readOnly),
  tool('get_app', '승인된 공개 앱의 소개와 스크린샷을 가져옵니다.', object({ id: idField }, ['id']), readOnly),
  tool('upload_screenshot', '로컬에서 준비한 이미지 한 장을 표준 base64로 업로드합니다. 반환된 path와 caption을 등록에 사용하세요.',
    object({ data_base64: string(2800000), caption: string(250) }, ['data_base64', 'caption']),
    { destructiveHint: false, idempotentHint: false }),
  tool('register_app', '먼저 dry_run: true로 검증하고 앱 요약과 본인 제작 확인 질문을 사용자에게 보여 주세요. 사용자가 직접 네라고 답한 뒤에만 동일한 앱 정보, confirmation_id, confirm_own_work: true로 호출하세요. 저장된 요청은 관리자 검토 대기 상태가 됩니다.',
    object({ ...appFields, dry_run: { type: 'boolean' }, confirm_own_work: { type: 'boolean' }, confirmation_id: string(100) },
      ['name', 'web_url', 'short', 'description', 'cat', 'subjects', 'grade', 'screenshots']),
    { destructiveHint: false, idempotentHint: true }),
  tool('list_my_apps', '내 참코딩 계정으로 접수한 앱의 처리 상태와 관리자 검토 메모, 수정용 version을 확인합니다.',
    object(pageFields), readOnly),
  tool('update_app', '내 승인 대기·수정 요청 앱에서 전달한 항목만 수정하고 다시 검토를 요청합니다. list_my_apps가 돌려준 최신 version을 넣으세요.',
    object({ id: idField, version: { type: 'integer', minimum: 1 }, ...appFields }, ['id', 'version']),
    { destructiveHint: true, idempotentHint: false })
];
const ownFields = 'id,name,web_url,category,subjects,grade,status,review_note,version,created_at,updated_at';
const summaryFields = 'id,name,web_url,short,category,subjects,grade,author_name';
const publicApps = 'status=eq.approved&is_example=eq.false';
const confirmationQuestion = '이 앱을 직접 제작했으며, 앱 정보와 스크린샷을 참코딩 관리자에게 검토 요청하는 데 동의하시나요?';

function fieldError(message, field, allowed) {
  return Object.assign(new AppError(message), { field, allowed });
}

function filterChoice(value, field, choices) {
  if (!choices.includes(value)) throw fieldError('목록에 있는 값을 선택해 주세요.', field, choices);
}

function pageArgs({ limit = 15, offset = 0 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw fieldError('조회 개수는 1~25 사이의 정수여야 해요.', 'limit');
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw fieldError('조회 시작 위치를 확인해 주세요.', 'offset');
  return { limit, offset };
}

async function page(db, filters, args) {
  const { limit, offset } = pageArgs(args);
  const rows = await db(`/rest/v1/tools_apps?${filters}&order=created_at.desc,id.desc&limit=${limit + 1}&offset=${offset}`);
  return { apps: rows.slice(0, limit), next_offset: rows.length > limit ? offset + limit : null };
}

function listOptions() {
  return {
    categories: CATEGORIES, subjects: SUBJECTS,
    limits: Object.fromEntries(Object.entries(appFields).filter(([, schema]) => schema.maxLength).map(([field, schema]) => [field, schema.maxLength])),
    notes: { max: 12, max_length: 250 },
    screenshots: { min: 1, max: 6, max_bytes: 2 * 1024 * 1024, max_caption_length: 250, formats: ['PNG', 'JPG', 'WebP'] },
    confirmation_question: confirmationQuestion
  };
}

async function searchApps(db, { q, category, subject, ...args }) {
  const query = text(q, '검색어', 100);
  const filters = new URLSearchParams(publicApps);
  filters.set('select', summaryFields);
  if (category !== undefined) {
    filterChoice(category, 'category', CATEGORIES);
    filters.set('category', `eq.${category}`);
  }
  if (subject !== undefined) {
    filterChoice(subject, 'subject', SUBJECTS);
    filters.set('subjects', `cs.${JSON.stringify([subject])}`);
  }
  if (query) {
    // Quote the PostgREST operand and escape the PostgreSQL LIKE wildcard characters.
    const literal = query.replace(/[\\%_*]/g, '\\$&').replace(/[\\"]/g, '\\$&');
    filters.set('or', `(name.ilike."%${literal}%",short.ilike."%${literal}%",author_name.ilike."%${literal}%")`);
  }
  return page(db, filters, args);
}

function registrationValue(args, actor, existing) {
  const input = { ...existing, cat: existing?.category, ...args };
  filterChoice(input.cat, 'cat', CATEGORIES);
  if (!Array.isArray(input.subjects) || !input.subjects.length || input.subjects.some(subject => !SUBJECTS.includes(subject))) {
    throw fieldError('교과를 하나 이상 골라 주세요.', 'subjects', SUBJECTS);
  }
  const memberName = String(actor.member.name || '회원').trim().slice(0, 60) || '회원';
  return validateApp({ ...input, author_name: input.author_name ?? memberName, contact_email: actor.member.email },
    { sessionId: actor.sid, existing });
}

function confirmationSignature(expires, actor, value) {
  return createHmac('sha256', process.env.SESSION_SECRET)
    .update(JSON.stringify(['mcp-app-confirmation', expires, actor.sid, value])).digest('base64url');
}

async function registerApp(req, args, actor, { db, rate, verifyUploads }) {
  const dryRun = args.dry_run === true;
  await rate(req, dryRun ? 'mcp-preview' : 'mcp-register', dryRun ? 24 : 12, 3600, actor.sid);
  if (!dryRun && args.confirm_own_work !== true) {
    throw fieldError('사용자에게 본인 제작과 검토 요청 동의를 확인해 주세요.', 'confirm_own_work', [true]);
  }
  const value = registrationValue(args, actor);
  if (dryRun) {
    await verifyUploads(value.screenshots, actor);
    const expires = Date.now() + 30 * 60 * 1000;
    return {
      dry_run: true, requires_confirmation: true, confirmation_question: confirmationQuestion,
      confirmation_id: `${expires}.${confirmationSignature(expires, actor, value)}`,
      app: { name: value.name, web_url: value.web_url, category: value.category, subjects: value.subjects,
        grade: value.grade, screenshot_count: value.screenshots.length }
    };
  }
  const [timestamp, signature, extra] = (typeof args.confirmation_id === 'string' ? args.confirmation_id : '').split('.');
  const expires = Number(timestamp);
  if (!Number.isSafeInteger(expires) || expires < Date.now() || !signature || extra !== undefined ||
      !equal(signature, confirmationSignature(expires, actor, value))) {
    throw fieldError('미리 확인한 내용이 바뀌었거나 확인 시간이 만료됐어요. dry_run부터 다시 진행해 주세요.', 'confirmation_id');
  }
  const own = `member_id=eq.${actor.member.id}&web_url=eq.${encodeURIComponent(value.web_url)}&select=${ownFields}&limit=1`;
  const [existing] = await db(`/rest/v1/tools_apps?${own}`);
  if (existing) return { created: false, app: existing };

  await verifyUploads(value.screenshots, actor);
  const [app] = await db(`/rest/v1/tools_apps?on_conflict=member_id,web_url&select=${ownFields}`, {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: { ...value, member_id: actor.member.id, mcp_member_name: String(actor.member.name).slice(0, 60),
      source: 'mcp', status: 'pending', submitted_session: actor.sid, own_work_confirmed_at: new Date().toISOString() }
  });
  if (app) return { created: true, app };
  const [duplicate] = await db(`/rest/v1/tools_apps?${own}`);
  if (!duplicate) throw new AppError('등록 결과를 확인하지 못했어요. 다시 시도해 주세요.', 503);
  return { created: false, app: duplicate };
}

async function updateApp(req, args, actor, { db, rate, uuid, verifyUploads }) {
  await rate(req, 'mcp-update', 12, 3600, actor.sid);
  const id = uuid(args.id, '앱 번호');
  const own = `id=eq.${id}&member_id=eq.${actor.member.id}&source=eq.mcp`;
  const [existing] = await db(`/rest/v1/tools_apps?${own}&select=*&limit=1`);
  if (!existing) throw new AppError('내 등록 요청을 찾을 수 없어요.', 404);
  if (!['pending', 'changes_requested'].includes(existing.status)) throw new AppError('승인 대기 또는 수정 요청 상태인 앱만 고칠 수 있어요.', 409);
  if (!Number.isInteger(args.version) || args.version !== existing.version) throw new AppError('앱이 변경됐어요. list_my_apps로 목록을 다시 확인해 주세요.', 409);
  // Only tool fields can override stored values. Preserve trusted prior screenshots after token rotation.
  const changes = Object.fromEntries(Object.keys(appFields).filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]]));
  const value = registrationValue(changes, actor, existing);
  await verifyUploads(value.screenshots, actor, existing);
  const [app] = await db(`/rest/v1/tools_apps?${own}&status=in.(pending,changes_requested)&version=eq.${args.version}&select=${ownFields}`, {
    method: 'PATCH', body: { ...value, status: 'pending' }, headers: { Prefer: 'return=representation' },
    conflictMessage: '같은 웹앱 주소로 이미 등록한 요청이 있어요.'
  });
  if (!app) throw new AppError('앱이 변경됐어요. list_my_apps로 목록을 다시 확인해 주세요.', 409);
  return { app };
}

async function callTool(name, args, req, actor, services) {
  const { db, rate, uuid, withImages, storeUpload } = services;
  switch (name) {
    case 'list_options': return listOptions();
    case 'search_apps': return searchApps(db, args);
    case 'get_app': {
      const id = uuid(args.id, '앱 번호');
      const rows = await db(`/rest/v1/tools_apps?${publicApps}&id=eq.${id}&select=${summaryFields},description,demo_url,video_url,notes,screenshots&limit=1`);
      if (!rows.length) throw new AppError('공개 앱을 찾을 수 없어요.', 404);
      const [app] = await withImages(rows);
      return { app: { ...app, screenshots: app.screenshots.map(({ url, caption }) => ({ url, caption })) } };
    }
    case 'upload_screenshot': {
      await rate(req, 'mcp-upload', 36, 3600, actor.sid);
      const caption = text(args.caption, '스크린샷 설명', 250, true);
      return { path: await storeUpload(args.data_base64, actor.sid), caption };
    }
    case 'register_app': return registerApp(req, args, actor, services);
    case 'list_my_apps': return page(db, `member_id=eq.${actor.member.id}&source=eq.mcp&select=${ownFields}`, args);
    case 'update_app': return updateApp(req, args, actor, services);
  }
}

module.exports = { tools, callTool };
