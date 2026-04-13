import { PrismaClient, Gender } from '@prisma/client';
import * as verificationService from './verification.service.ts';
import {
  uploadUserAvatar,
  updateUserAvatar,
  deleteUserAvatar,
  extractAvatarKeyFromUrl,
} from '../lib/r2-user-config.ts';

const prisma = new PrismaClient();

// ─── Select shape ─────────────────────────────────────────────────────────────

const profileSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  isVerified: true,
  provider: true,
  createdAt: true,
  customerProfile: {
    select: {
      id: true,
      profileImage: true,      // public R2 URL
      gender: true,
      dateOfBirth: true,
      wallet: true,
      loyaltyPoints: true,
      isVerifiedBySocialMedia: true,
    },
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface UpdateProfileInput {
  name?: string;
  gender?: Gender;
  dateOfBirth?: string; // ISO string
}

// Express/Multer file shape
interface MulterFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class CustomerProfileService {

  /** Return full profile for the authenticated user. */
  async getProfile(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: profileSelect,
    });
  }

  /**
   * Update non-sensitive fields only: name, gender, dateOfBirth.
   * Avatar goes through uploadAvatar / deleteAvatar.
   * Email / phone go through their own 2-step endpoints.
   */
  async updateProfile(userId: string, input: UpdateProfileInput) {
    const { name, gender, dateOfBirth } = input;

    return prisma.$transaction(async (tx) => {
      if (name !== undefined) {
        await tx.user.update({ where: { id: userId }, data: { name } });
      }

      const profileData: Record<string, unknown> = {};
      if (gender !== undefined)      profileData.gender = gender;
      if (dateOfBirth !== undefined) profileData.dateOfBirth = new Date(dateOfBirth);

      if (Object.keys(profileData).length > 0) {
        await tx.customerProfile.upsert({
          where: { userId },
          update: profileData,
          create: { userId, ...profileData },
        });
      }

      return tx.user.findUnique({ where: { id: userId }, select: profileSelect });
    });
  }

  // ─── Avatar ─────────────────────────────────────────────────────────────────

  /**
   * Upload or replace the user's avatar.
   *  - If they already have one, the old R2 object is deleted first
   *    (updateUserAvatar handles this when oldAvatarKey is supplied).
   *  - The resulting public URL and R2 key are stored in CustomerProfile.
   */
  async uploadAvatar(userId: string, file: MulterFile) {
    // Fetch current avatar key so R2 can delete the old file
    const current = await prisma.customerProfile.findUnique({
      where: { userId },
      select: { profileImage: true },
    });

    const oldAvatarKey = current?.profileImage
      ? extractAvatarKeyFromUrl(current.profileImage) ?? undefined
      : undefined;

    const { url } = await updateUserAvatar({
      userId,
      file: file.buffer,
      fileName: file.originalname,
      contentType: file.mimetype,
      oldAvatarKey,
    });

    // Persist the new public URL (the key is embedded inside the URL via extractAvatarKeyFromUrl)
    await prisma.customerProfile.upsert({
      where: { userId },
      update: { profileImage: url },
      create: { userId, profileImage: url },
    });

    return prisma.user.findUnique({ where: { id: userId }, select: profileSelect });
  }

  /**
   * Remove avatar from R2 and clear the field in DB.
   */
  async deleteAvatar(userId: string) {
    const current = await prisma.customerProfile.findUnique({
      where: { userId },
      select: { profileImage: true },
    });

    if (!current?.profileImage) {
      throw new Error('No profile image to delete');
    }

    // Delete from R2
    const key = extractAvatarKeyFromUrl(current.profileImage);
    if (key) {
      await deleteUserAvatar(key);
    }

    // Clear in DB
    await prisma.customerProfile.update({
      where: { userId },
      data: { profileImage: null },
    });

    return prisma.user.findUnique({ where: { id: userId }, select: profileSelect });
  }

  // ─── Email change ────────────────────────────────────────────────────────────

  /**
   * Step 1 — guard verified email, check uniqueness, send token.
   */
  async requestEmailChange(userId: string, newEmail: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    if (user.email && user.isVerified) {
      throw new Error(
        'Your email is already verified and cannot be changed. Contact support if needed.',
      );
    }

    const normalized = newEmail.toLowerCase().trim();

    const conflict = await prisma.user.findFirst({
      where: { email: normalized, id: { not: userId } },
    });
    if (conflict) throw new Error('This email is already in use by another account');

    await verificationService.sendEmailVerification(normalized, user.name ?? '', {
      password: '',
      role: user.role,
    } as any);
  }

  /**
   * Step 2 — consume token, update email, mark verified.
   */
  async verifyEmailChange(userId: string, token: string) {
    const data = await verificationService.verifyEmail(token);
    if (!data) throw new Error('Invalid or expired verification token');

    await verificationService.consumeEmailToken(token);

    return prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { email: data.email, isVerified: true },
      });
      return tx.user.findUnique({ where: { id: userId }, select: profileSelect });
    });
  }

  // ─── Phone change ─────────────────────────────────────────────────────────

  /**
   * Step 1 — guard verified phone, check uniqueness, send OTP.
   */
  async requestPhoneChange(userId: string, newPhone: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    if (user.phone && user.isVerified) {
      throw new Error(
        'Your phone number is already verified and cannot be changed. Contact support if needed.',
      );
    }

    const conflict = await prisma.user.findFirst({
      where: { phone: newPhone, id: { not: userId } },
    });
    if (conflict) throw new Error('This phone number is already in use by another account');

    await verificationService.sendOtp(newPhone);
  }

  /**
   * Step 2 — verify OTP, update phone, mark verified.
   */
  async verifyPhoneChange(userId: string, newPhone: string, otp: string) {
    const verifiedPhone = await verificationService.verifyOtp(newPhone, otp);
    if (!verifiedPhone) throw new Error('Invalid or expired OTP');

    return prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { phone: verifiedPhone, isVerified: true },
      });
      return tx.user.findUnique({ where: { id: userId }, select: profileSelect });
    });
  }
}