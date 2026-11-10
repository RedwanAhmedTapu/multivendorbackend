// modules/chat/services/media.service.ts
import { prisma } from "../../../config/prisma.ts";

import {
  uploadChatImage,
  uploadChatAudio,
  deleteChatMedia,
  deleteMessageMedia,
  extractMediaKeysFromUrls,
  validateImageFile,
  validateAudioFile,
  type UploadImageResult,
  type UploadAudioResult,
} from "../../../lib/r2-chat-media.ts";

// -----------------------------
// Types
// -----------------------------
export interface ProcessImageInput {
  messageId: string;
  file: Buffer;
  fileName: string;
  mimeType: string;
}

export interface ProcessAudioInput {
  messageId: string;
  file: Buffer;
  fileName: string;
  mimeType: string;
  duration?: number;
}

// -----------------------------
// Media Service
// -----------------------------
export class MediaService {
  /**
   * Upload and process chat image
   * Creates 3 variants: original, optimized (webp), thumbnail (webp)
   */
  async processImage(input: ProcessImageInput): Promise<UploadImageResult> {
    // 1. Validate
    validateImageFile({ buffer: input.file, mimeType: input.mimeType, fileName: input.fileName });

    // 2. Upload to R2 (processes + uploads all variants)
    const result = await uploadChatImage({
      messageId: input.messageId,
      file: input.file,
      fileName: input.fileName,
      mimeType: input.mimeType,
    });

    // 3. Create media record in DB
    await prisma.messageMedia.create({
      data: {
        messageId: input.messageId,
        mediaType: "IMAGE",
        status: "READY",
        url: result.url,
        thumbnailUrl: result.thumbnailUrl,
        originalUrl: result.originalUrl,
        fileName: input.fileName,
        fileSize: result.fileSize,
        mimeType: input.mimeType,
        width: result.width,
        height: result.height,
        aspectRatio: result.aspectRatio,
        blurhash: result.blurhash,
      },
    });

    return result;
  }

  /**
   * Upload chat audio
   * Stores original file, generates waveform data
   */
  async processAudio(input: ProcessAudioInput): Promise<UploadAudioResult> {
    // 1. Validate
    validateAudioFile({ buffer: input.file, mimeType: input.mimeType, fileName: input.fileName });

    // 2. Upload to R2
    const result = await uploadChatAudio({
      messageId: input.messageId,
      file: input.file,
      fileName: input.fileName,
      mimeType: input.mimeType,
      duration: input.duration,
    });

    // 3. Create media record in DB
    await prisma.messageMedia.create({
      data: {
        messageId: input.messageId,
        mediaType: "AUDIO",
        status: "READY",
        url: result.url,
        fileName: input.fileName,
        fileSize: result.fileSize,
        mimeType: input.mimeType,
        duration: result.duration,
        waveformData: result.waveformData,
      },
    });

    return result;
  }

  /**
   * Delete media for a single message
   * Removes from R2 and DB
   */
  async deleteMedia(messageId: string): Promise<void> {
    // 1. Get media record
    const media = await prisma.messageMedia.findUnique({
      where: { messageId },
    });

    if (!media) return;

    // 2. Extract keys from URLs
    const keys = extractMediaKeysFromUrls({
      url: media.url,
      thumbnailUrl: media.thumbnailUrl,
      originalUrl: media.originalUrl,
    });

    // 3. Delete from R2 and DB in parallel
    await Promise.all([
      deleteChatMedia(keys),
      prisma.messageMedia.delete({ where: { messageId } }),
    ]);
  }

  /**
   * Soft delete — mark as deleted but keep files
   * Used when message is deleted for one user but not all
   */
  async softDeleteMedia(messageId: string): Promise<void> {
    await prisma.messageMedia.update({
      where: { messageId },
      data: { status: "FAILED" }, // Reuse status to indicate unavailable
    });
  }

  /**
   * Delete all media for a conversation
   * Called when conversation is permanently deleted
   */
  async deleteConversationMedia(conversationId: string): Promise<void> {
    // 1. Get all media records
    const mediaList = await prisma.messageMedia.findMany({
      where: {
        message: { conversationId },
      },
      select: {
        url: true,
        thumbnailUrl: true,
        originalUrl: true,
        messageId: true,
      },
    });

    if (mediaList.length === 0) return;

    // 2. Collect all keys
    const allKeys: string[] = [];
    for (const media of mediaList) {
      const keys = extractMediaKeysFromUrls({
        url: media.url,
        thumbnailUrl: media.thumbnailUrl,
        originalUrl: media.originalUrl,
      });
      allKeys.push(...Object.values(keys).filter(Boolean) as string[]);
    }

    // 3. Delete from R2 (batch) and DB (batch)
    await Promise.all([
      deleteChatMedia({
        originalKey: allKeys.find((k) => k.includes("/original/")),
        optimizedKey: allKeys.find((k) => k.includes("optimized.webp")),
        thumbnailKey: allKeys.find((k) => k.includes("thumbnail.webp")),
        audioKey: allKeys.find((k) => k.includes("/audio/")),
      }),
      prisma.messageMedia.deleteMany({
        where: {
          message: { conversationId },
        },
      }),
    ]);
  }

  /**
   * Get media info (from DB, no R2 call)
   */
  async getMedia(messageId: string) {
    return prisma.messageMedia.findUnique({
      where: { messageId },
    });
  }

  /**
   * Pre-create media record as PROCESSING
   * Called before upload starts, so UI can show loading state
   */
  async createPendingMedia(
    messageId: string,
    mediaType: "IMAGE" | "AUDIO",
    fileName: string,
    fileSize: number,
    mimeType: string
  ) {
    return prisma.messageMedia.create({
      data: {
        messageId,
        mediaType,
        status: "PROCESSING",
        fileName,
        fileSize,
        mimeType,
      },
    });
  }

  /**
   * Update media record after successful upload
   */
  async updateMediaComplete(
    messageId: string,
    data:
      | { url: string; thumbnailUrl: string; originalUrl: string; width: number; height: number; aspectRatio: number; blurhash: string }
      | { url: string; duration: number; waveformData: string }
  ) {
    return prisma.messageMedia.update({
      where: { messageId },
      data: {
        status: "READY",
        ...data,
      },
    });
  }

  /**
   * Mark media as failed
   */
  async markMediaFailed(messageId: string) {
    return prisma.messageMedia.update({
      where: { messageId },
      data: { status: "FAILED" },
    });
  }
}

// Singleton
export const mediaService = new MediaService();