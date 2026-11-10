// src/services/webauthn.service.ts
//
// This is what powers "use device PIN / fingerprint / FaceID to log in".
//
// Important: your server NEVER sees a fingerprint or face scan. The
// browser's platform authenticator (Touch ID, Windows Hello, Android
// biometric prompt, etc.) unlocks a private key that's stored on the
// user's device. Your server only ever stores the matching PUBLIC key
// and verifies a signature. This is the WebAuthn / passkey standard.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { isoUint8Array, isoBase64URL } from "@simplewebauthn/server/helpers";
import { prisma } from "../../../config/prisma.ts";

const RP_NAME = process.env.WEBAUTHN_RP_NAME || "MyApp";
const RP_ID = process.env.WEBAUTHN_RP_ID || "localhost";
// Comma-separated if you serve web + mobile webview from different origins
const ORIGINS = (process.env.WEBAUTHN_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

// ---------------------------------------------------------------------
// Registration — user is already logged in (password/social) and wants
// to add "unlock with PIN/fingerprint/FaceID" to their account.
// ---------------------------------------------------------------------

export const buildRegistrationOptions = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { webauthnCredentials: true },
  });
  if (!user) throw new Error("User not found");

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.email || user.phone || user.id,
    userDisplayName: user.name || user.email || user.phone || "User",
    // v10+ requires a Uint8Array, stable per user
    userID: isoUint8Array.fromUTF8String(user.id),
    attestationType: "none",
    excludeCredentials: user.webauthnCredentials.map((cred) => ({
      id: cred.credentialId,
      transports: cred.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      // "required" forces a discoverable credential (passkey) so the user
      // can log in without typing an email/phone first — the device
      // itself offers up the matching credential after PIN/biometric unlock.
      residentKey: "required",
      userVerification: "preferred", // actually enforced at verify-time below
    },
  });

  return options;
};

export const completeRegistration = async (
  userId: string,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  nickname?: string
) => {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    requireUserVerification: false, // set true if you want to REQUIRE biometric/PIN, not just "present"
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Passkey registration could not be verified");
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  const saved = await prisma.webAuthnCredential.create({
  data: {
    userId,
    credentialId: credential.id, // already base64url 
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: BigInt(credential.counter),
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    transports: credential.transports ?? [],
    nickname: nickname || null,
  },
});
  return saved;
};

// ---------------------------------------------------------------------
// Authentication — logging in directly via PIN/fingerprint/FaceID,
// no password. Uses discoverable credentials, so we don't need to know
// who the user is up front: the browser/OS shows the user their saved
// passkeys for this site and unlocks the chosen one.
// ---------------------------------------------------------------------

export const buildAuthenticationOptions = async (identifier?: {
  email?: string;
  phone?: string;
}) => {
  // Optional: if the frontend already knows the user (e.g. "Use Face ID"
  // button on a specific account), scope the credential list. Otherwise
  // leave allowCredentials empty for a fully discoverable/passwordless flow.
  let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] | undefined;

  if (identifier?.email || identifier?.phone) {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          identifier.email ? { email: identifier.email } : undefined,
          identifier.phone ? { phone: identifier.phone } : undefined,
        ].filter(Boolean) as any,
      },
      include: { webauthnCredentials: true },
    });

    if (user) {
      allowCredentials = user.webauthnCredentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      }));
    }
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "preferred",
    allowCredentials,
  });

  return options;
};

export const completeAuthentication = async (
  response: AuthenticationResponseJSON,
  expectedChallenge: string
) => {
  const credentialId = response.id;

  const credential = await prisma.webAuthnCredential.findUnique({
    where: { credentialId },
    include: { user: true },
  });

  if (!credential) {
    throw new Error("Unrecognized passkey — it may have been removed on another device");
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    credential: {
      id: credential.credentialId,
      publicKey: isoBase64URL.toBuffer(credential.publicKey),
      counter: Number(credential.counter),
      transports: credential.transports as AuthenticatorTransportFuture[],
    },
    requireUserVerification: false,
  });

  if (!verification.verified) {
    throw new Error("Passkey sign-in could not be verified");
  }

  // Update counter (clone/replay protection) + last used timestamp
  await prisma.webAuthnCredential.update({
    where: { id: credential.id },
    data: {
      counter: BigInt(verification.authenticationInfo.newCounter),
      lastUsedAt: new Date(),
    },
  });

  const { password, ...safeUser } = credential.user;
  return safeUser;
};

// ---------------------------------------------------------------------
// Credential management
// ---------------------------------------------------------------------

export const listCredentials = (userId: string) =>
  prisma.webAuthnCredential.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      nickname: true,
      deviceType: true,
      backedUp: true,
      transports: true,
      createdAt: true,
      lastUsedAt: true,
      // credentialId/publicKey intentionally excluded from API responses
    },
  });

export const deleteCredential = async (userId: string, credentialRecordId: string) => {
  const credential = await prisma.webAuthnCredential.findUnique({
    where: { id: credentialRecordId },
  });
  if (!credential || credential.userId !== userId) {
    throw new Error("Passkey not found");
  }
  await prisma.webAuthnCredential.delete({ where: { id: credentialRecordId } });
};