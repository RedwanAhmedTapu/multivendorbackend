import { prisma } from "../../../config/prisma.ts";
import redisClient from "../../../config/redis.ts";
import { RedisKeys } from "../utils/redis-keys.ts";
import type { UpdateNotificationSettingsInput } from "../dto/notification-settings.dto.ts";
import type { ParticipantType } from "@prisma/client";
import { identityWhere } from "../utils/participant-resolver.ts";

// FIX: single place that maps ownerType -> the one owner FK that's actually
// @unique on NotificationSetting. Both getSettings and updateSettings need
// this exact mapping and previously only getSettings had it (buried inline);
// updateSettings instead hardcoded `userId`, which is invalid/wrong for
// every non-customer owner.
function buildOwnerWhere(ownerType: ParticipantType, ownerId: string) {
  // unknown → EMPLOYEE / ADMIN column; typed so Prisma keeps the @unique owner FK
  return identityWhere(ownerType, ownerId, "employeeId") as { userId: string } | { vendorId: string } | { employeeId: string } | { deliveryPersonId: string };
}

export class NotificationService {
  async getSettings(ownerId: string, ownerType: ParticipantType) {
    const cacheKey = RedisKeys.notifSettings(ownerId);
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const ownerWhere = buildOwnerWhere(ownerType, ownerId);
    // findFirst still needs ownerType in the filter alongside the FK, since
    // the FK columns aren't scoped by type on their own.
    let settings = await prisma.notificationSetting.findFirst({
      where: { ownerType, ...ownerWhere },
    });

    if (!settings) {
      // FIX: this is exactly what triggered "Argument ownerType is missing" —
      // ownerType must always be present on create. It's included here
      // explicitly rather than relying on a `where` object that may have
      // had it stripped out upstream.
      settings = await prisma.notificationSetting.create({
        data: { ownerType, ...ownerWhere },
      });
    }

    await redisClient.set(cacheKey, JSON.stringify(settings), { EX: 1800 });
    return settings;
  }

  async updateSettings(
    ownerId: string,
    ownerType: ParticipantType,
    data: UpdateNotificationSettingsInput
  ) {
    // FIX: `where: { userId: ownerType === "CUSTOMER" ? ownerId : "none" }`
    // was always wrong for non-customer owners — "none" is not a real
    // userId, so this either matched nothing (causing a duplicate insert
    // attempt against the real unique row) or violated the unique
    // constraint outright. Each owner type has its own @unique FK column;
    // use the one that actually applies.
    const ownerWhere = buildOwnerWhere(ownerType, ownerId);

    const settings = await prisma.notificationSetting.upsert({
      where: ownerWhere,
      update: data,
      create: { ownerType, ...ownerWhere, ...data },
    });

    await redisClient.del(RedisKeys.notifSettings(ownerId));
    return settings;
  }
}