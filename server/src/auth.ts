import { randomBytes, createHash } from "node:crypto";

/**
 * 令牌管理：
 * - 服务器启动时若未设置 SYNC_TOKEN，生成一个并打印（可持久化到 data/token.txt）。
 * - ADMIN_TOKEN 用于管理端点（创建/撤销访问令牌）。
 * 访问令牌明文存库（个人自托管场景），哈希用于校验。
 */

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

export interface TokenRecord {
  id: number;
  name: string;
  tokenHash: string;
  created_at: number;
}

/** 校验 Bearer token；返回 true 表示有效 */
export function verifyToken(
  allTokens: () => TokenRecord[],
  staticTokens: string[],
  header: string | undefined,
): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (staticTokens.includes(token)) return true;
  const hash = hashToken(token);
  return allTokens().some((t) => t.tokenHash === hash);
}

/** 管理令牌校验（静态配置） */
export function verifyAdminToken(staticAdmin: string | null, header: string | undefined): boolean {
  if (!staticAdmin) return false;
  if (!header || !header.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length).trim() === staticAdmin;
}
