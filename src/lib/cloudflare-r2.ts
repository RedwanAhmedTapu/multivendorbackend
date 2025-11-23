// lib/cloudflare-r2.ts
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
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
  publicDomain: process.env.R2_PUBLIC_DOMAIN || null, // fallback to null if not set
  freeQuotaGB: 5,
  pricePerGBOverQuota: 0.015, // $0.015 per GB/month
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

  // Build URL based on env
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
