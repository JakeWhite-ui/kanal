// Дашборд канала — zero-dep сервер. node server.js → http://localhost:4320
// Источник правды — data.json в репо: коммитится и синкается между Mac.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 4320;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Запись через временный файл: обрыв на полпути не оставит битый data.json.
function writeData(obj) {
  obj.meta = obj.meta || {};
  obj.meta.updated = new Date().toISOString().slice(0, 10);
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, DATA);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/data' && req.method === 'GET') {
    try {
      return sendJSON(res, 200, JSON.parse(fs.readFileSync(DATA, 'utf8')));
    } catch (e) {
      return sendJSON(res, 500, { error: 'data.json не читается: ' + e.message });
    }
  }

  if (url.pathname === '/api/data' && req.method === 'PUT') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return sendJSON(res, 400, { error: 'не JSON: ' + e.message });
      }
      // Минимальная проверка формы, чтобы кривой клиент не затёр файл пустышкой.
      if (!parsed || typeof parsed !== 'object' || !parsed.goal || !Array.isArray(parsed.deals)) {
        return sendJSON(res, 400, { error: 'нет goal или deals — запись отклонена' });
      }
      try {
        writeData(parsed);
        return sendJSON(res, 200, { ok: true, updated: parsed.meta.updated });
      } catch (e) {
        return sendJSON(res, 500, { error: 'не записалось: ' + e.message });
      }
    });
    return;
  }

  // Статика, только внутри папки проекта.
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('403');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`Дашборд канала: http://localhost:${PORT}`);
  console.log(`Данные: ${DATA}`);
});
