// lib/r2-user-config.ts
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

// -----------------------------
// Config
// -----------------------------
const R2_CONFIG = {
  bucket: process.env.R2_BUCKET_NAME!,
  endpoint: process.env.R2_ENDPOINT!,
  publicDomain: process.env.R2_PUBLIC_DOMAIN || null,
  userFolder: "users",
};

// -----------------------------
// S3 Client (singleton)
// -----------------------------
const s3Client = new S3Client({
  region: "auto",
  endpoint: R2_CONFIG.endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

// -----------------------------
// Key Generator
// -----------------------------
// Key pattern: users/{userId}/avatar.{ext}
// Fixed name ensures update always overwrites old file — no orphans
export function generateAvatarKey(userId: string, fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "jpg";
  return `${R2_CONFIG.userFolder}/${userId}/avatar.${ext}`;
}

// -----------------------------
// Upload Profile Image
// -----------------------------
export async function uploadUserAvatar(params: {
  userId: string;
  file: Buffer;
  fileName: string;
  contentType: string;
}): Promise<{ url: string; key: string }> {
  const key = generateAvatarKey(params.userId, params.fileName);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: R2_CONFIG.bucket,
      Key: key,
      Body: params.file,
      ContentType: params.contentType,
      Metadata: {
        userId: params.userId,
        uploadedAt: new Date().toISOString(),
      },
    })
  );

  const baseUrl = R2_CONFIG.publicDomain
    ? R2_CONFIG.publicDomain
    : `${R2_CONFIG.endpoint}/${R2_CONFIG.bucket}`;

  return {
    key,
    url: `${baseUrl}/${key}`,
  };
}

// -----------------------------
// Update Profile Image
// Deletes old avatar (any ext) then uploads new one
// -----------------------------
export async function updateUserAvatar(params: {
  userId: string;
  file: Buffer;
  fileName: string;
  contentType: string;
  oldAvatarKey?: string; // pass existing key from DB if extension might differ
}): Promise<{ url: string; key: string }> {
  // Delete old avatar if we have its key
  if (params.oldAvatarKey) {
    await deleteUserAvatar(params.oldAvatarKey);
  }

  // Upload new avatar
  return uploadUserAvatar({
    userId: params.userId,
    file: params.file,
    fileName: params.fileName,
    contentType: params.contentType,
  });
}

// -----------------------------
// Delete Avatar
// -----------------------------
export async function deleteUserAvatar(key: string): Promise<void> {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: R2_CONFIG.bucket,
      Key: key,
    })
  );
}

// -----------------------------
// Extract Key from URL
// -----------------------------
export function extractAvatarKeyFromUrl(url: string): string | null {
  try {
    if (!url) return null;

    if (R2_CONFIG.publicDomain && url.startsWith(R2_CONFIG.publicDomain)) {
      return url.replace(`${R2_CONFIG.publicDomain}/`, "");
    }

    if (url.includes(R2_CONFIG.endpoint)) {
      return url.replace(`${R2_CONFIG.endpoint}/${R2_CONFIG.bucket}/`, "");
    }

    // Fallback: if already a relative key
    if (url.startsWith(`${R2_CONFIG.userFolder}/`)) {
      return url;
    }

    return null;
  } catch (error) {
    console.error("Error extracting avatar key from URL:", error);
    return null;
  }
}