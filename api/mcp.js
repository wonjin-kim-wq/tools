const { internals } = require('./tools');
const { AppError } = require('../lib/tools-core');
const { authenticateToken } = require('../lib/mcp-tokens');
const { tools, callTool } = require('../lib/mcp-tools');

const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const publicTools = new Set(['list_options', 'search_apps', 'get_app']);
const allowedOrigins = new Set(['https://www.chamssaem.kr', 'https://chamssaem.kr', 'https://tools-one-nu.vercel.app']);
const instructions = '등록할 앱을 살펴보고 list_options에 맞춰 소개와 스크린샷을 준비하세요. upload_screenshot으로 사진을 올리고 register_app의 dry_run으로 검증하세요. 사용자에게 등록할 내용과 본인 제작 확인 질문을 보여 주세요. 사용자가 네라고 답하면 동일한 내용과 confirmation_id, confirm_own_work: true를 보내세요. 접수 후 관리자 검토 상태를 알려 주세요.';
const errorCodes = { 400: 'INVALID_ARGUMENT', 401: 'AUTH_REQUIRED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 429: 'RATE_LIMITED', 503: 'UNAVAILABLE' };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function toolResult(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(isError ? { isError: true } : {}) };
}

function describeError(error) {
  if (!(error instanceof AppError)) return { code: 'INTERNAL_ERROR', message: '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', status: 500 };
  return { code: errorCodes[error.status] || 'REQUEST_FAILED', message: error.message, status: error.status,
    field: error.field, allowed: error.allowed };
}

module.exports = async function mcp(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status, data) => res.status(status).json(data);
  const rpcError = (status, id, code, message) => send(status, { jsonrpc: '2.0', id, error: { code, message } });
  const origin = req.headers.origin;
  const sameLocal = process.env.NODE_ENV === 'development' &&
    /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host) && origin === `http://${req.headers.host}`;
  if (origin !== undefined && !allowedOrigins.has(origin) && !sameLocal) return rpcError(403, null, -32000, 'Origin is not allowed');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return rpcError(405, null, -32000, 'Method not allowed');
  }
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') return rpcError(415, null, -32600, 'Expected application/json');
  const version = req.headers['mcp-protocol-version'];
  if (version !== undefined && !versions.includes(version)) return rpcError(400, null, -32600, 'Unsupported MCP protocol version');

  let message = req.body;
  if (typeof message === 'string' || Buffer.isBuffer(message)) {
    try { message = JSON.parse(message); }
    catch { return rpcError(400, null, -32700, 'Parse error'); }
  }
  const id = message?.id;
  const notification = id === undefined;
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (!notification && typeof id !== 'string' && !Number.isSafeInteger(id))) {
    return rpcError(400, null, -32600, 'Invalid request');
  }
  const { method, params = {} } = message;
  const result = value => send(200, { jsonrpc: '2.0', id, result: value });
  try {
    if (req.headers.authorization !== undefined && !internals.isConfigured()) throw new AppError('저장소 연결을 준비하고 있어요.', 503);
    const actor = await authenticateToken(req.headers.authorization, internals.db);
    if (notification) {
      if (method.startsWith('notifications/')) return res.status(202).end();
      return rpcError(400, null, -32600, 'Request ID required');
    }
    if (!isObject(params)) return rpcError(200, id, -32602, 'Invalid params');
    switch (method) {
      case 'initialize':
        if (typeof params.protocolVersion !== 'string') return rpcError(200, id, -32602, 'Protocol version required');
        return result({
          protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
          capabilities: { tools: {} }, serverInfo: { name: 'chamcoding', version: '1.0.0' }, instructions
        });
      case 'ping': return result({});
      case 'tools/list': return result({ tools: actor ? tools : tools.filter(tool => publicTools.has(tool.name)) });
      case 'tools/call': {
        const tool = tools.find(tool => tool.name === params.name);
        if (!tool) return rpcError(200, id, -32602, 'Unknown tool');
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!isObject(args)) return rpcError(200, id, -32602, 'Tool arguments must be an object');
        try {
          if (!publicTools.has(tool.name) && !actor) throw new AppError('참코딩 회원 토큰으로 연결해 주세요.', 401);
          const unknown = Object.keys(args).find(field => !Object.hasOwn(tool.inputSchema.properties, field));
          if (unknown) throw Object.assign(new AppError('이 도구가 지원하는 항목을 확인해 주세요.'), { allowed: Object.keys(tool.inputSchema.properties) });
          if (tool.name !== 'list_options' && !internals.isConfigured()) throw new AppError('저장소 연결을 준비하고 있어요.', 503);
          return result(toolResult(await callTool(tool.name, args, req, actor, internals)));
        } catch (error) {
          if (!(error instanceof AppError)) console.error('MCP tool failed', tool.name, error.name);
          return result(toolResult(describeError(error), true));
        }
      }
      default: return rpcError(200, id, -32601, 'Method not found');
    }
  } catch (error) {
    const { status, message: reason } = describeError(error);
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="chamcoding"');
    if (status === 500) console.error('MCP request failed', error.name);
    return rpcError(status, id ?? null, -32000, reason);
  }
};
