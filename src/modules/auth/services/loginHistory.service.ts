import type { Request } from "express";
import { UAParser } from "ua-parser-js";
import { prisma } from "../../../config/prisma.ts";
import { LoginMethod } from "@prisma/client";

// ------------------- Header / UA helpers -------------------

function cleanHeader(value: unknown): string {
  if (!value || typeof value !== "string") return "";
  return value.replace(/^"|"$/g, "").trim();
}

interface ParsedUA {
  os: string;
  browser: string;
  device: string; // "mobile" | "tablet" | "desktop"
  deviceName: string;
  platform: string | null;
  platformVersion: string | null;
  model: string | null;
}

function parseUserAgent(uaString: string, headers: Record<string, unknown>): ParsedUA {
  const ua = uaString || "";

  const parser = new UAParser(ua);
  const result = parser.getResult();
  const { os, browser, device } = result;

  // Client Hints
  const chPlatform = cleanHeader(headers["sec-ch-ua-platform"]);
  const chPlatformVersion = cleanHeader(headers["sec-ch-ua-platform-version"]);
  const chModel = cleanHeader(headers["sec-ch-ua-model"]);

  // --------------------------------------------------
  // OS Detection
  // --------------------------------------------------
  let osName = os.name || "Unknown";
  let osVersion = os.version || "";

  if (chPlatform.toLowerCase() === "android" || /Android/i.test(ua)) {
    osName = "Android";

    if (chPlatformVersion) {
      osVersion = chPlatformVersion;
    }

    if (!osVersion) {
      const match = ua.match(/Android\s([0-9.]+)/i);
      if (match) osVersion = match[1];
    }
  } else if (/iPhone|iPad|iPod/i.test(ua) || chPlatform.toLowerCase() === "ios") {
    osName = "iOS";
    const match = ua.match(/(?:CPU (?:iPhone )?OS|iPhone OS)\s([\d_]+)/i);
    if (match) osVersion = match[1].replace(/_/g, ".");
  } else if (osName === "Windows") {
    if (chPlatformVersion) {
      const major = parseInt(chPlatformVersion.split(".")[0], 10);
      if (!isNaN(major)) {
        osVersion = major >= 13 ? "11" : "10";
      }
    }
  } else if (osName === "Mac OS" || chPlatform.toLowerCase() === "macos") {
    osName = "macOS";
  }

  // --------------------------------------------------
  // Device Type
  // --------------------------------------------------
  let deviceType = device.type || null;

  if (/iPhone|iPod/i.test(ua) || /Android.*Mobile/i.test(ua)) {
    deviceType = "mobile";
  } else if (/iPad/i.test(ua) || /Android(?!.*Mobile)/i.test(ua)) {
    deviceType = "tablet";
  } else if (!deviceType) {
    deviceType = "desktop";
  }

  // --------------------------------------------------
  // Device Name
  // --------------------------------------------------
  let deviceName = "Unknown Device";

  if (chModel && chModel !== "Unknown") {
    deviceName = chModel;
  } else if (device.model) {
    deviceName = device.vendor ? `${device.vendor} ${device.model}` : device.model;
  } else if (/iPhone/i.test(ua)) {
    deviceName = "iPhone";
  } else if (/iPad/i.test(ua)) {
    deviceName = "iPad";
  } else if (deviceType === "mobile") {
    deviceName = "Android Device";
  } else if (deviceType === "tablet") {
    deviceName = "Tablet";
  } else {
    deviceName = "Desktop";
  }

  return {
    os: `${osName} ${osVersion}`.trim(),
    browser: `${browser.name || "Unknown"} ${browser.version || ""}`.trim(),
    device: deviceType,
    deviceName,
    platform: chPlatform || null,
    platformVersion: chPlatformVersion || null,
    model: chModel || device.model || null,
  };
}

function getClientIp(req: Request): string {
  let ip: string | undefined = req.ip;

  if (!ip) {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(",")[0].trim();
    }
  }

  if (!ip) {
    ip = req.socket?.remoteAddress;
  }

  if (ip?.startsWith("::ffff:")) {
    ip = ip.substring(7);
  }

  if (ip === "::1") {
    ip = "127.0.0.1";
  }

  return ip || "unknown";
}

// ------------------- Public API -------------------

interface RecordLoginAttemptParams {
  req: Request;
  userId?: string | null;
  success: boolean;
  method?: LoginMethod; // defaults to PASSWORD
  attemptedEmail?: string | null;
  attemptedPhone?: string | null;
  failureReason?: string | null;
}

/**
 * Fire-and-forget by design (controllers call this without `await`-blocking
 * the response). Never throws outward — logging failures must not break auth.
 */
export const recordLoginAttempt = async ({
  req,
  userId = null,
  success,
  method = LoginMethod.PASSWORD,
  attemptedEmail = null,
  attemptedPhone = null,
  failureReason = null,
}: RecordLoginAttemptParams): Promise<void> => {
  try {
    const parsedUA = parseUserAgent(
      (req.headers["user-agent"] as string) || "",
      req.headers as Record<string, unknown>
    );

    await prisma.loginHistory.create({
      data: {
        userId: userId ?? undefined,
        success,
        method,
        failureReason: failureReason ?? undefined,
        attemptedEmail: attemptedEmail ?? undefined,
        attemptedPhone: attemptedPhone ?? undefined,
        ipAddress: getClientIp(req),
        device: parsedUA.device,
        deviceName: parsedUA.deviceName,
        browser: parsedUA.browser,
        os: parsedUA.os,
        platform: parsedUA.platform ?? undefined,
        platformVersion: parsedUA.platformVersion ?? undefined,
        model: parsedUA.model ?? undefined,
      },
    });
  } catch (err: any) {
    // Never let history logging break the auth flow
    console.error("💥 Failed to record login attempt:", err.message);
  }
};

interface PageOptions {
  page?: number;
  pageSize?: number;
}

export const getLoginHistory = async (
  userId: string,
  { page = 1, pageSize = 20 }: PageOptions = {}
) => {
  const safePage = Math.max(1, page);
  const safePageSize = Math.min(100, Math.max(1, pageSize));

  const [items, total] = await Promise.all([
    prisma.loginHistory.findMany({
      where: { userId },
      orderBy: { loginAt: "desc" },
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
    }),
    prisma.loginHistory.count({ where: { userId } }),
  ]);

  return {
    items,
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages: Math.ceil(total / safePageSize),
  };
};

export const getLastSuccessfulLogin = async (userId: string) => {
  return prisma.loginHistory.findFirst({
    where: { userId, success: true },
    orderBy: { loginAt: "desc" },
  });
};