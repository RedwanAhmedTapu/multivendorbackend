// lib/r2-vendor-config.ts
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

export const R2_VENDOR_CONFIG = {
  bucket: process.env.R2_BUCKET_NAME!,
  endpoint: process.env.R2_ENDPOINT!,
  publicDomain: process.env.R2_PUBLIC_DOMAIN || null,
  vendorFolder: "vendor",
};

const s3Client = new S3Client({
  region: "auto",
  endpoint: R2_VENDOR_CONFIG.endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export async function uploadToR2Vendor(params: {
  file: Buffer;
  key: string;
  contentType: string;
}) {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: R2_VENDOR_CONFIG.bucket,
      Key: params.key,
      Body: params.file,
      ContentType: params.contentType,
      Metadata: {
        uploadedBy: "vendor",
        uploadedAt: new Date().toISOString(),
      },
    })
  );

  const baseUrl = R2_VENDOR_CONFIG.publicDomain
    ? R2_VENDOR_CONFIG.publicDomain
    : `${R2_VENDOR_CONFIG.endpoint}/${R2_VENDOR_CONFIG.bucket}`;

  return {
    key: params.key,
    url: `${baseUrl}/${params.key}`,
  };
}

export async function deleteFromR2Vendor(key: string) {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: R2_VENDOR_CONFIG.bucket,
      Key: key,
    })
  );
}