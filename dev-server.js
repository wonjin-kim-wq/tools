// Local verification uses the same API handler as the Vercel deployment.
process.env.NODE_ENV = 'development';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('./api/tools');
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/tools')) {
    let body = '', oversized = false;
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) { oversized = true; break; }
    }
    res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (oversized) return res.status(413).json({error:'파일이 너무 커요.'});
    try { req.body = body ? JSON.parse(body) : {}; } catch { return res.status(400).json({error:'잘못된 요청이에요.'}); }
    return handler(req, res);
  }
  const allowed = new Set(['/index.html','/tools.js','/tools.css','/recommend.js','/assets/chamssaem.png','/assets/share/chamcoding-og-v1.png','/favicon.ico','/assets/favicon.svg','/assets/favicon-32.png','/assets/favicon-192.png','/assets/apple-touch-icon.png']);
  const file = new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname;
  if (!allowed.has(file)) { res.statusCode=404; return res.end('Not found'); }
  const extension = path.extname(file);
  res.setHeader('Content-Type', {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'}[extension]);
  fs.createReadStream(path.join(__dirname,file)).pipe(res);
}).listen(process.env.PORT || 8741, '127.0.0.1', () => console.log(`Local verification server: http://127.0.0.1:${process.env.PORT || 8741}`));
