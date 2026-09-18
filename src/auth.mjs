// 角色与权限矩阵。只有 publisher/admin 可发布；审批与发布分离（审批人不能凭审批权直接发布）。
const GRANTS = {
  viewer: ['read'],
  analyst: ['read', 'create', 'edit', 'copy', 'run', 'export', 'remind'],
  approver: ['read', 'approve'],
  publisher: ['read', 'publish'],
  admin: ['read', 'create', 'edit', 'copy', 'run', 'export', 'remind', 'approve', 'publish'],
};

export const ROLES = Object.keys(GRANTS);

export const can = (role, action) => GRANTS[role]?.includes(action) ?? false;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requireAction(actor, action) {
  if (!actor.user) throw new HttpError(401, 'unauthorized', '缺少 x-user 请求头');
  if (!can(actor.role, action)) {
    throw new HttpError(403, 'forbidden', `角色 ${actor.role} 无权执行 ${action}`);
  }
}
