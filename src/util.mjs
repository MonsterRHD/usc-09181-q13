// 通用工具：HTTP 错误、日期、数值与编码校验。
// 计算引擎与领域层共用，保证校验口径一致。

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (message, extra) => new HttpError(400, 'bad-request', message, extra);
export const unauthorized = (message = '缺少身份标识（x-user-id / x-role）') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = '当前角色无权执行该操作') => new HttpError(403, 'forbidden', message);
export const notFound = (message = '资源不存在') => new HttpError(404, 'not-found', message);
export const conflict = (message, extra) => new HttpError(409, 'conflict', message, extra);

export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isoDate(value, field = 'date') {
  if (!isISODate(value)) throw badRequest(`${field} 必须是 YYYY-MM-DD 格式的有效日期，收到：${value}`);
  return value;
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function nowISO() {
  return new Date().toISOString();
}

// 金额统一保留两位小数，避免浮点尾差进入汇总
export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function normCurrency(value, field = 'currency') {
  if (typeof value !== 'string') throw badRequest(`${field} 必须是三字母币种代码`);
  const c = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw badRequest(`${field} 必须是三字母币种代码，收到：${value}`);
  return c;
}

export function normCountry(value, field = 'country') {
  if (typeof value !== 'string') throw badRequest(`${field} 必须是两字母国家/地区代码`);
  const c = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) throw badRequest(`${field} 必须是两字母国家/地区代码，收到：${value}`);
  return c;
}

export function num(value, field, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw badRequest(`${field} 必须是有限数值，收到：${value}`);
  if (n < min || n > max) throw badRequest(`${field} 超出允许范围 [${min}, ${max}]，收到：${n}`);
  return n;
}

export function intInRange(value, field, min, max) {
  const n = num(value, field);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${field} 必须是 [${min}, ${max}] 内的整数，收到：${value}`);
  return n;
}

export function nonEmptyString(value, field, maxLen = 200) {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${field} 不能为空`);
  if (value.length > maxLen) throw badRequest(`${field} 长度不能超过 ${maxLen}`);
  return value.trim();
}

export function clone(o) {
  return structuredClone(o);
}
