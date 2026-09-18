// 极简路由与 JSON 助手：模式形如 /scenarios/:id/versions/:n/inputs。
import { HttpError } from './auth.mjs';

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) =>
    routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });

  async function handle(req, res, ctx) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    for (const route of routes) {
      if (route.method !== req.method || route.parts.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        const p = route.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]);
        else if (p !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      ctx.params = params;
      ctx.query = Object.fromEntries(url.searchParams);
      return route.handler(ctx);
    }
    throw new HttpError(404, 'not_found', `无此路由: ${req.method} ${url.pathname}`);
  }

  return { add, handle };
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'too_large', '请求体超过 1MB');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体不是合法 JSON');
  }
}
