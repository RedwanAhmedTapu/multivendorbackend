// lib/r2-chat-media.ts
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

// -----------------------------
// Config
// -----------------------------
const R2_CHAT_CONFIG = {
  bucket: process.env.R2_BUCKET_NAME!,
  endpoint: process.env.R2_ENDPOINT!,
  publicDomain: process.env.R2_PUBLIC_DOMAIN || null,
  chatFolder: "chat",
  allowedImageTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  allowedAudioTypes: ["audio/mpeg", "audio/ogg", "audio/webm", "audio/aac"],
  maxImageSize: 10 * 1024 * 1024, // 10MB
  maxAudioSize: 20 * 1024 * 1024, // 20MB
  imageVariants: {
    optimized: { maxWidth: 1200, quality: 80, format: "webp" as const },
    thumbnail: {
      width: 150,
      height: 150,
      quality: 60,
      format: "webp" as const,
    },
  },
};

// -----------------------------
// S3 Client (reuse singleton if exists, else create)
// -----------------------------
let s3Client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: "auto",
      endpoint: R2_CHAT_CONFIG.endpoint,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return s3Client;
}

// -----------------------------
// Key Generators
// -----------------------------
// Pattern: chat/media/{msgId[:2]}/{msgId}/original/{fileName}
// Pattern: chat/media/{msgId[:2]}/{msgId}/optimized.webp
// Pattern: chat/media/{msgId[:2]}/{msgId}/thumbnail.webp
// Pattern: chat/media/{msgId[:2]}/{msgId}/audio/{fileName}

function getBasePath(messageId: string): string {
  return `${R2_CHAT_CONFIG.chatFolder}/media/${messageId.slice(0, 2)}/${messageId}`;
}

export function generateImageKeys(messageId: string, fileName: string) {
  const base = getBasePath(messageId);
  const ext = fileName.split(".").pop()?.toLowerCase() || "jpg";
  return {
    original: `/original/${messageId}.${ext}`,
    optimized: `/optimized.webp`,
    thumbnail: `/thumbnail.webp`,
  };
}

export function generateAudioKeys(messageId: string, fileName: string) {
  const base = getBasePath(messageId);
  const ext = fileName.split(".").pop()?.toLowerCase() || "mp3";
  return {
    audio: `/audio/${messageId}.${ext}`,
  };
}

// -----------------------------
// URL Builder
// -----------------------------
function buildUrl(key: string): string {
  if (R2_CHAT_CONFIG.publicDomain) {
    return `${R2_CHAT_CONFIG.publicDomain}/${key}`;
  }
  return `${R2_CHAT_CONFIG.endpoint}/${R2_CHAT_CONFIG.bucket}/${key}`;
}

// -----------------------------
// Validation
// -----------------------------
export function validateImageFile(file: {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): void {
  if (!R2_CHAT_CONFIG.allowedImageTypes.includes(file.mimeType)) {
    throw new Error(
      `Invalid image type: ${file.mimeType}. Allowed: ${R2_CHAT_CONFIG.allowedImageTypes.join(", ")}`,
    );
  }
  if (file.buffer.length > R2_CHAT_CONFIG.maxImageSize) {
    throw new Error(
      `Image too large. Max ${R2_CHAT_CONFIG.maxImageSize / 1024 / 1024}MB`,
    );
  }
}

export function validateAudioFile(file: {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): void {
  if (!R2_CHAT_CONFIG.allowedAudioTypes.includes(file.mimeType)) {
    throw new Error(
      `Invalid audio type: ${file.mimeType}. Allowed: ${R2_CHAT_CONFIG.allowedAudioTypes.join(", ")}`,
    );
  }
  if (file.buffer.length > R2_CHAT_CONFIG.maxAudioSize) {
    throw new Error(
      `Audio too large. Max ${R2_CHAT_CONFIG.maxAudioSize / 1024 / 1024}MB`,
    );
  }
}

// -----------------------------
// Upload Image
// -----------------------------
export interface UploadImageResult {
  // Keys
  originalKey: string;
  optimizedKey: string;
  thumbnailKey: string;
  // URLs
  url: string;
  thumbnailUrl: string;
  originalUrl: string;
  // Metadata
  width: number;
  height: number;
  aspectRatio: number;
  fileSize: number;
  blurhash: string;
  mimeType: string;
  fileName: string;
}

export async function uploadChatImage(params: {
  messageId: string;
  file: Buffer;
  fileName: string;
  mimeType: string;
}): Promise<UploadImageResult> {
  const client = getR2Client();

  // Validate
  validateImageFile({
    buffer: params.file,
    mimeType: params.mimeType,
    fileName: params.fileName,
  });

  // Get metadata
  const metadata = await sharp(params.file).metadata();
  const width = metadata.width!;
  const height = metadata.height!;
  const aspectRatio = Math.round((width / height) * 100) / 100;

  // Generate blurhash placeholder
  const blurhash = await generateBlurhash(params.file);

  // Process variants in parallel
  const [optimizedBuffer, thumbnailBuffer] = await Promise.all([
    sharp(params.file)
      .resize(
        R2_CHAT_CONFIG.imageVariants.optimized.maxWidth,
        R2_CHAT_CONFIG.imageVariants.optimized.maxWidth,
        {
          fit: "inside",
          withoutEnlargement: true,
        },
      )
      .webp({ quality: R2_CHAT_CONFIG.imageVariants.optimized.quality })
      .toBuffer(),

    sharp(params.file)
      .resize(
        R2_CHAT_CONFIG.imageVariants.thumbnail.width,
        R2_CHAT_CONFIG.imageVariants.thumbnail.height,
        {
          fit: "cover",
        },
      )
      .webp({ quality: R2_CHAT_CONFIG.imageVariants.thumbnail.quality })
      .toBuffer(),
  ]);

  // Generate keys
  const keys = generateImageKeys(params.messageId, params.fileName);

  // Upload all 3 variants in parallel
  await Promise.all([
    client.send(
      new PutObjectCommand({
        Bucket: R2_CHAT_CONFIG.bucket,
        Key: keys.original,
        Body: params.file,
        ContentType: params.mimeType,
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: {
          messageId: params.messageId,
          type: "CHAT_IMAGE_ORIGINAL",
          uploadedAt: new Date().toISOString(),
        },
      }),
    ),
    client.send(
      new PutObjectCommand({
        Bucket: R2_CHAT_CONFIG.bucket,
        Key: keys.optimized,
        Body: optimizedBuffer,
        ContentType: "image/webp",
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: {
          messageId: params.messageId,
          type: "CHAT_IMAGE_OPTIMIZED",
          width: String(width),
          height: String(height),
        },
      }),
    ),
    client.send(
      new PutObjectCommand({
        Bucket: R2_CHAT_CONFIG.bucket,
        Key: keys.thumbnail,
        Body: thumbnailBuffer,
        ContentType: "image/webp",
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: {
          messageId: params.messageId,
          type: "CHAT_IMAGE_THUMBNAIL",
        },
      }),
    ),
  ]);

  return {
    originalKey: keys.original,
    optimizedKey: keys.optimized,
    thumbnailKey: keys.thumbnail,
    url: buildUrl(keys.optimized),
    thumbnailUrl: buildUrl(keys.thumbnail),
    originalUrl: buildUrl(keys.original),
    width,
    height,
    aspectRatio,
    fileSize: params.file.length,
    blurhash,
    mimeType: params.mimeType,
    fileName: params.fileName,
  };
}

// -----------------------------
// Upload Audio
// -----------------------------
export interface UploadAudioResult {
  // Keys
  audioKey: string;
  // URLs
  url: string;
  // Metadata
  fileSize: number;
  duration: number;
  waveformData: string;
  mimeType: string;
  fileName: string;
}

export async function uploadChatAudio(params: {
  messageId: string;
  file: Buffer;
  fileName: string;
  mimeType: string;
  duration?: number; // Pass if already calculated client-side
}): Promise<UploadAudioResult> {
  const client = getR2Client();

  // Validate
  validateAudioFile({
    buffer: params.file,
    mimeType: params.mimeType,
    fileName: params.fileName,
  });

  // Generate keys
  const keys = generateAudioKeys(params.messageId, params.fileName);

  // Get duration (use provided or estimate)
  const duration =
    params.duration || estimateAudioDuration(params.file, params.mimeType);

  // Generate simplified waveform (16 bars)
  const waveformData = generateSimpleWaveform(params.file);

  // Upload
  await client.send(
    new PutObjectCommand({
      Bucket: R2_CHAT_CONFIG.bucket,
      Key: keys.audio,
      Body: params.file,
      ContentType: params.mimeType,
      CacheControl: "public, max-age=31536000, immutable",
      Metadata: {
        messageId: params.messageId,
        type: "CHAT_AUDIO",
        duration: String(duration),
        uploadedAt: new Date().toISOString(),
      },
    }),
  );

  return {
    audioKey: keys.audio,
    url: buildUrl(keys.audio),
    fileSize: params.file.length,
    duration,
    waveformData,
    mimeType: params.mimeType,
    fileName: params.fileName,
  };
}

// -----------------------------
// Delete Chat Media
// -----------------------------
export async function deleteChatMedia(keys: {
  originalKey?: string;
  optimizedKey?: string;
  thumbnailKey?: string;
  audioKey?: string;
}): Promise<void> {
  const client = getR2Client();
  const allKeys = Object.values(keys).filter(Boolean) as string[];

  if (allKeys.length === 0) return;

  await Promise.all(
    allKeys.map((key) =>
      client.send(
        new DeleteObjectCommand({
          Bucket: R2_CHAT_CONFIG.bucket,
          Key: key,
        }),
      ),
    ),
  );
}

// -----------------------------
// Delete All Media for a Message
// -----------------------------
export async function deleteMessageMedia(messageId: string): Promise<void> {
  const client = getR2Client();
  const base = getBasePath(messageId);

  // List and delete all objects under this message's folder
  // Note: R2 supports ListObjectsV2
  // For simplicity, delete known patterns
  const possibleKeys = [
    `${base}/original/`,
    `${base}/optimized.webp`,
    `${base}/thumbnail.webp`,
    `${base}/audio/`,
  ];

  // In production, use ListObjectsV2 to get exact keys then batch delete
  // This is a simplified version
  await Promise.allSettled(
    possibleKeys.map(async (prefix) => {
      try {
        // Attempt deletion - will silently fail if key doesn't exist
        await client.send(
          new DeleteObjectCommand({
            Bucket: R2_CHAT_CONFIG.bucket,
            Key: prefix,
          }),
        );
      } catch {
        // Ignore - key might not exist
      }
    }),
  );
}

// -----------------------------
// Extract Keys from URLs
// -----------------------------
export function extractMediaKeysFromUrls(urls: {
  url?: string | null;
  thumbnailUrl?: string | null;
  originalUrl?: string | null;
}): {
  originalKey?: string;
  optimizedKey?: string;
  thumbnailKey?: string;
  audioKey?: string;
} {
  const result: Record<string, string> = {};

  if (urls.url) {
    const key = extractKeyFromUrl(urls.url);
    if (key) {
      if (key.includes("/audio/")) result.audioKey = key;
      else result.optimizedKey = key;
    }
  }

  if (urls.thumbnailUrl) {
    const key = extractKeyFromUrl(urls.thumbnailUrl);
    if (key) result.thumbnailKey = key;
  }

  if (urls.originalUrl) {
    const key = extractKeyFromUrl(urls.originalUrl);
    if (key) result.originalKey = key;
  }

  return result;
}

function extractKeyFromUrl(url: string): string | null {
  try {
    if (!url) return null;

    if (
      R2_CHAT_CONFIG.publicDomain &&
      url.startsWith(R2_CHAT_CONFIG.publicDomain)
    ) {
      return url.replace(`${R2_CHAT_CONFIG.publicDomain}/`, "");
    }

    if (url.includes(R2_CHAT_CONFIG.endpoint)) {
      return url.replace(
        `${R2_CHAT_CONFIG.endpoint}/${R2_CHAT_CONFIG.bucket}/`,
        "",
      );
    }

    if (url.startsWith(`${R2_CHAT_CONFIG.chatFolder}/`)) {
      return url;
    }

    return null;
  } catch (error) {
    console.error("Error extracting media key from URL:", error);
    return null;
  }
}

// -----------------------------
// Blurhash Generation (Simplified)
// -----------------------------
async function generateBlurhash(imageBuffer: Buffer): Promise<string> {
  try {
    // In production, use the 'blurhash' package:
    // import { encode } from "blurhash";
    // const { data, width, height } = await sharp(imageBuffer)
    //   .resize(32, 32, { fit: "inside" })
    //   .raw()
    //   .toBuffer({ resolveWithObject: true });
    // const pixels = new Uint8ClampedArray(data.buffer);
    // return encode(pixels, width, height, 4, 4);

    // Placeholder - replace with actual blurhash implementation
    return "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
  } catch {
    return "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
  }
}

// -----------------------------
// Audio Duration Estimation (Simplified)
// -----------------------------
function estimateAudioDuration(buffer: Buffer, mimeType: string): number {
  try {
    // In production, use ffprobe or music-metadata package:
    // import { parseBuffer } from "music-metadata";
    // const metadata = await parseBuffer(buffer, mimeType);
    // return Math.round(metadata.format.duration || 0);

    // Rough estimation based on file size and bitrate
    const bitrates: Record<string, number> = {
      "audio/mpeg": 128000,
      "audio/ogg": 128000,
      "audio/webm": 128000,
      "audio/aac": 128000,
    };
    const bitrate = bitrates[mimeType] || 128000;
    return Math.round((buffer.length * 8) / bitrate);
  } catch {
    return 0;
  }
}

// -----------------------------
// Simple Waveform Generation
// -----------------------------
function generateSimpleWaveform(buffer: Buffer, bars: number = 32): string {
  try {
    // In production, use audio-decoder or similar:
    // 1. Decode audio to PCM
    // 2. Split into bars
    // 3. Calculate RMS for each bar
    // 4. Normalize to 0-1 range
    // 5. Return as JSON array

    // Placeholder: random waveform
    const waveform: number[] = [];
    for (let i = 0; i < bars; i++) {
      waveform.push(Math.random() * 0.8 + 0.1);
    }
    return JSON.stringify(waveform);
  } catch {
    return JSON.stringify(new Array(32).fill(0.5));
  }
}

// -----------------------------
// Batch Delete for Conversation
// -----------------------------
export async function deleteConversationMedia(
  messageIds: string[],
): Promise<void> {
  await Promise.allSettled(messageIds.map((id) => deleteMessageMedia(id)));
}
