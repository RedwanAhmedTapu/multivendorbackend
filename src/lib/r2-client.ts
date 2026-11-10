// lib/r2-client.ts
// Shared R2 client singleton — used by both user config and chat media

import { S3Client } from "@aws-sdk/client-s3";

let client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT!,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return client;
}

// For testing/reset
export function resetR2Client(): void {
  client = null;
}