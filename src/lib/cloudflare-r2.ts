// lib/cloudflare-r2.ts
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export const R2_CONFIG = {
  bucket: process.env.R2_BUCKET_NAME!,
  endpoint: process.env.R2_ENDPOINT!,
  publicDomain: process.env.R2_PUBLIC_DOMAIN || null,
  freeQuotaGB: 5,
  pricePerGBOverQuota: 0.015,
};

export async function uploadToR2(params: {
  file: Buffer;
  key: string;
  contentType: string;
  vendorId: string;
}) {
  const command = new PutObjectCommand({
    Bucket: R2_CONFIG.bucket,
    Key: params.key,
    Body: params.file,
    ContentType: params.contentType,
    Metadata: {
      vendorId: params.vendorId,
      uploadedAt: new Date().toISOString(),
    },
  });

  await r2Client.send(command);

  const baseUrl = R2_CONFIG.publicDomain
    ? R2_CONFIG.publicDomain
    : `${R2_CONFIG.endpoint}/${R2_CONFIG.bucket}`;

  return {
    key: params.key,
    url: `${baseUrl}/${params.key}`,
  };
}

export async function deleteFromR2(key: string) {
  const command = new DeleteObjectCommand({
    Bucket: R2_CONFIG.bucket,
    Key: key,
  });

  await r2Client.send(command);
}

export async function getSignedR2Url(key: string, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: R2_CONFIG.bucket,
    Key: key,
  });

  return await getSignedUrl(r2Client, command, { expiresIn });
}

// ─────────────────────────────────────────────────────────────────
// NEW — list objects directly from R2 by key prefix
// ─────────────────────────────────────────────────────────────────

export interface R2ListedObject {
  key: string;
  url: string;
  size: number;
  lastModified: Date | undefined;
}

export async function listR2Objects(prefix: string, maxKeys = 1000): Promise<R2ListedObject[]> {
  const baseUrl = R2_CONFIG.publicDomain
    ? R2_CONFIG.publicDomain
    : `${R2_CONFIG.endpoint}/${R2_CONFIG.bucket}`;

  const objects: R2ListedObject[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: R2_CONFIG.bucket,
      Prefix: prefix,
      MaxKeys: Math.min(maxKeys - objects.length, 1000),
      ContinuationToken: continuationToken,
    });

    const result = await r2Client.send(command);

    (result.Contents ?? []).forEach((obj) => {
      if (!obj.Key) return;
      objects.push({
        key: obj.Key,
        url: `${baseUrl}/${obj.Key}`,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified,
      });
    });

    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken && objects.length < maxKeys);

  return objects;
}

// Convenience: list every product image for a vendor directly from R2
export async function listVendorProductImagesFromR2(vendorId: string) {
  return listR2Objects(`vendors/${vendorId}/productimages/`);
}

// Convenience: list "general" (non-product) images for a vendor
export async function listVendorGeneralImagesFromR2(vendorId: string) {
  return listR2Objects(`vendors/${vendorId}/images/`);
}