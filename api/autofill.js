/* AI 자동 채우기(베타). 헤드리스 Chromium이 커서 목록·로그인 API(api/tools.js)와 함수를 나눈다. */
const { AppError, webUrl } = require('../lib/tools-core');
const { assertMutation, isConfigured, requireRole, rate, session } = require('./tools').internals;

async function handler(req, res, { autofill = require('../lib/autofill').autofill } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (data, status = 200) => res.status(status).json(data);
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new AppError('지원하지 않는 요청이에요.', 405); }
    assertMutation(req);
    if (!isConfigured()) throw new AppError('저장소 연결을 준비하고 있어요. 연결을 마치면 사용할 수 있어요.', 503);
    // 업로드 요청과 같은 권한(업로더·관리자)만 쓸 수 있다.
    await requireRole(req, session(req)?.role === 'admin');
    if (!process.env.ANTHROPIC_API_KEY) throw new AppError('AI 자동 채우기를 준비하고 있어요. 지금은 직접 입력해 주세요.', 503);
    await rate(req, 'autofill', 10, 3600);
    const url = webUrl((req.body || {}).url, true);
    return send(await autofill(url));
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    if (status === 500) console.error('Autofill API failed', error.name);
    return send({ error: error instanceof AppError ? error.message : 'AI 자동 채우기에 실패했어요. 잠시 후 다시 시도해 주세요.' }, status);
  }
}
module.exports = (req, res) => handler(req, res);
module.exports.handler = handler;
