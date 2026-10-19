'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const CAPACITY = 2;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 16 * 1024;

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function publicState(confirmed, waitlist) {
  return {
    capacity: CAPACITY,
    confirmed: confirmed.map((registration) => ({ ...registration })),
    waitlist: waitlist.map((registration) => ({ ...registration })),
    remainingSeats: Math.max(0, CAPACITY - confirmed.length),
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        const error = new Error('请求内容过大');
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (!body) {
        const error = new Error('请提交 JSON 数据');
        error.statusCode = 400;
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        const error = new Error('JSON 格式无效');
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function validateRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: '请提供姓名和邮箱' };
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const ordinaryEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!name) return { error: '请输入姓名' };
  if (!ordinaryEmail.test(email)) return { error: '请输入有效的邮箱地址' };
  return { name, email };
}

function createServer() {
  const confirmed = [];
  const waitlist = [];

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');

    try {
      if (request.method === 'GET' && url.pathname === '/api/state') {
        sendJson(response, 200, publicState(confirmed, waitlist));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/registrations') {
        sendJson(response, 200, { state: publicState(confirmed, waitlist) });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/registrations') {
        const input = await readJsonBody(request);
        const validated = validateRegistration(input);
        if (validated.error) {
          sendJson(response, 400, { error: validated.error });
          return;
        }

        const duplicate = [...confirmed, ...waitlist].some(
          (registration) => registration.email.toLowerCase() === validated.email.toLowerCase(),
        );
        if (duplicate) {
          sendJson(response, 409, { error: '该邮箱已完成报名' });
          return;
        }
        const status = confirmed.length < CAPACITY ? 'confirmed' : 'waitlisted';
        const registration = {
          id: randomUUID(),
          name: validated.name,
          email: validated.email,
          status,
          createdAt: new Date().toISOString(),
        };
        const destination = status === 'confirmed' ? confirmed : waitlist;
        destination.push(registration);
        sendJson(response, 201, {
          registration: { ...registration },
          state: publicState(confirmed, waitlist),
        });
        return;
      }

      if (request.method === 'DELETE' && url.pathname.startsWith('/api/registrations/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/registrations/'.length));
        const confirmedIndex = confirmed.findIndex((registration) => registration.id === id);
        const waitlistIndex = waitlist.findIndex((registration) => registration.id === id);
        if (confirmedIndex === -1 && waitlistIndex === -1) {
          sendJson(response, 404, { error: '未找到该报名记录' });
          return;
        }

        let cancelled;
        let promoted = null;
        if (confirmedIndex !== -1) {
          [cancelled] = confirmed.splice(confirmedIndex, 1);
          if (waitlist.length > 0) {
            promoted = waitlist.shift();
            promoted.status = 'confirmed';
            confirmed.push(promoted);
          }
        } else {
          [cancelled] = waitlist.splice(waitlistIndex, 1);
        }

        sendJson(response, 200, {
          cancelled: { ...cancelled },
          promoted: promoted ? { ...promoted } : null,
          state: publicState(confirmed, waitlist),
        });
        return;
      }

      if (request.method === 'GET' && STATIC_FILES.has(url.pathname)) {
        const [filename, contentType] = STATIC_FILES.get(url.pathname);
        const content = await readFile(path.join(PUBLIC_DIR, filename));
        response.writeHead(200, {
          'content-type': contentType,
          'cache-control': 'no-cache',
        });
        response.end(content);
        return;
      }

      sendJson(response, 404, { error: '页面或接口不存在' });
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 500, {
          error: error.statusCode ? error.message : '服务器暂时无法处理请求',
        });
      }
    }
  });
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  const server = createServer();
  server.listen(port, () => {
    console.log(`模拟活动报名服务已启动：http://localhost:${port}`);
  });
}

module.exports = { createServer };
