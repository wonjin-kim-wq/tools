const { createHash, randomBytes } = require('node:crypto');
const { AppError, text } = require('./tools-core');
const members = require('./member-auth');

const table = '/rest/v1/tools_api_tokens';
const tokenFields = 'id,name,prefix,created_at,last_used_at,revoked_at';
const digest = token => createHash('sha256').update(token).digest('hex');

async function manageToken(req, body, { db, rate, uuid, res }) {
  const member = await members.member(req, true, { requireContentAccess: false, res });
  const own = `member_id=eq.${member.id}&revoked_at=is.null`;
  if (req.method === 'GET') {
    return { tokens: await db(`${table}?${own}&select=${tokenFields}&order=created_at.desc`) };
  }
  if (req.method === 'PATCH') {
    const id = uuid(body.id, '토큰 번호');
    const rows = await db(`${table}?${own}&id=eq.${id}&select=id`, {
      method: 'PATCH', body: { revoked_at: new Date().toISOString() }, headers: { Prefer: 'return=representation' }
    });
    if (!rows.length) throw new AppError('사용 중인 토큰을 찾을 수 없어요.', 404);
    return { ok: true };
  }
  const name = text(body.name, '토큰 이름', 60, true);
  await rate(req, 'mcp-token-issue', 5, 3600, member.id);
  const token = `chm_live_${randomBytes(32).toString('base64url')}`;
  const record = await db('/rest/v1/rpc/tools_issue_api_token', {
    method: 'POST',
    body: { p_member_id: member.id, p_name: name, p_token_hash: digest(token), p_prefix: token.slice(0, 17) }
  });
  if (!record) throw new AppError('계정당 활성 토큰은 1개예요. 기존 토큰을 사용하거나 폐기한 뒤 다시 만들어 주세요.', 409);
  return { token, record };
}

function invalidToken() {
  return new AppError('참코딩 토큰이 유효하지 않아요. 사이트에서 토큰을 확인해 주세요.', 401);
}

async function authenticateToken(header, db) {
  if (header === undefined) return null;
  const match = /^Bearer (chm_live_[A-Za-z0-9_-]{43})$/i.exec(header);
  if (!match) throw invalidToken();
  const [record] = await db(`${table}?token_hash=eq.${digest(match[1])}&revoked_at=is.null&select=id,member_id&limit=1`);
  if (!record) throw invalidToken();
  const member = await members.memberById(record.member_id);
  if (!member) throw invalidToken();
  const [active] = await db(`${table}?id=eq.${record.id}&revoked_at=is.null&select=id`, {
    method: 'PATCH', body: { last_used_at: new Date().toISOString() }, headers: { Prefer: 'return=representation' }
  });
  if (!active) throw invalidToken();
  return { sid: record.id, member };
}

module.exports = { manageToken, authenticateToken };
