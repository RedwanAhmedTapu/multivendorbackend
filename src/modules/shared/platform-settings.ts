// PHASE 2 — platform_settings reads (key/value configuration) via the typed
// PlatformSettings model (migration 20261002000000 + 20261002090000).
import { prisma } from "../../config/prisma.ts";

export async function getPlatformSetting(key: string): Promise<{ key: string; value: string; note: string | null } | null> {
  const row = await prisma.platformSettings.findUnique({ where: { key } });
  return row ? { key: row.key, value: row.value, note: row.note } : null;
}
