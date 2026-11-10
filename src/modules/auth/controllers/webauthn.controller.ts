// src/controllers/webauthn.controller.ts
import type { Response } from "express";
import { randomUUID } from "crypto";
import * as webauthnService from "../services/webauthn.service.ts";
import * as authService from "../services/auth.service.ts";
import * as loginHistoryService from "../services/loginHistory.service.ts";
import { saveChallenge, consumeChallenge } from "../utils/challengeStore.util.ts";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import type { Request } from "express";

// =====================================================================
// REGISTRATION — add a passkey (PIN/fingerprint/FaceID) to an ALREADY
// logged-in account. Requires authenticateUser middleware.
// =====================================================================

export const registerOptions = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.rawId; // always the users table id, not vendorId
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const options = await webauthnService.buildRegistrationOptions(userId);

    const challengeId = randomUUID();
    saveChallenge(challengeId, options.challenge, userId);

    res.json({ challengeId, options });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

export const registerVerify = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.rawId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { challengeId, response, nickname } = req.body;
    if (!challengeId || !response) {
      return res.status(400).json({ message: "challengeId and response are required" });
    }

    const entry = consumeChallenge(challengeId);
    if (!entry || entry.userId !== userId) {
      return res.status(400).json({ message: "Challenge expired or invalid, please try again" });
    }

    const credential = await webauthnService.completeRegistration(
      userId,
      response,
      entry.challenge,
      nickname
    );

    res.json({
      message: "Passkey registered — you can now sign in with device PIN/fingerprint/Face ID",
      credential: {
        id: credential.id,
        nickname: credential.nickname,
        deviceType: credential.deviceType,
        createdAt: credential.createdAt,
      },
    });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// =====================================================================
// LOGIN — passwordless sign-in via device PIN/fingerprint/FaceID.
// Public endpoints, mirrors the shape of your existing /login response
// so the frontend can reuse the same success handler.
// =====================================================================

export const loginOptions = async (req: Request, res: Response) => {
  try {
    const { email, phone } = req.body || {};
    const options = await webauthnService.buildAuthenticationOptions({ email, phone });

    const challengeId = randomUUID();
    saveChallenge(challengeId, options.challenge);

    res.json({ challengeId, options });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

export const loginVerify = async (req: Request, res: Response) => {
  try {
    const { challengeId, response } = req.body;
    if (!challengeId || !response) {
      return res.status(400).json({ message: "challengeId and response are required" });
    }

    const entry = consumeChallenge(challengeId);
    if (!entry) {
      return res.status(400).json({ message: "Challenge expired or invalid, please try again" });
    }

    const user = await webauthnService.completeAuthentication(response, entry.challenge);

    const { accessToken, refreshToken } = authService.generateTokens(user);

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000,
    });

    await loginHistoryService.recordLoginAttempt({
      req,
      userId: user.id,
      success: true,
      method: "WEBAUTHN",
    });

    res.json({
      message: "Login successful",
      accessToken,
      // SECURITY: never return the bcrypt password hash.
      user: authService.toPublicUser(user),
    });
  } catch (err: any) {
    await loginHistoryService.recordLoginAttempt({
      req,
      success: false,
      method: "WEBAUTHN",
      failureReason: err.message,
    });
    res.status(401).json({ message: err.message });
  }
};

// =====================================================================
// CREDENTIAL MANAGEMENT — user manages their own passkeys from settings
// =====================================================================

export const listCredentials = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.rawId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const credentials = await webauthnService.listCredentials(userId);
    res.json({ credentials });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

export const removeCredential = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.rawId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    await webauthnService.deleteCredential(userId, req.params.id);
    res.json({ message: "Passkey removed" });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};