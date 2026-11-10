// modules/chat/controllers/media.controller.ts
import { AGENT_CHAT_LIMITS, isAgentConversationType } from "../../agent/chat/agent-chat.config.ts";
import type{ Request, Response } from "express";
import { mediaService } from "../services/media.service.ts";
import { validateImageFile, validateAudioFile } from "../../../lib/r2-chat-media.ts";
import { actorFrom, getMessageAccess, isSender, NOT_FOUND } from "../utils/chat-access.ts";

// Phase 0: media belongs to a message. Attaching or deleting it is the
// SENDER's action; reading it needs access to the message's conversation.
// Anything else answers 404 (existence is not revealed).
async function senderOf(req: Request, messageId: string) {
  const actor = actorFrom((req as any).user);
  if (!actor) return null;
  const found = await getMessageAccess(messageId, actor);
  return found && isSender(found.message, actor) ? found : null;
}

// -----------------------------
// Upload Chat Image
// POST /api/chat/media/image
// -----------------------------
export async function uploadImageController(req: Request, res: Response) {
  try {
    const file = req.file;
    const messageId = req.body.messageId;

    if (!file) {
      return res.status(400).json({ error: "No file provided" });
    }

    if (!messageId) {
      return res.status(400).json({ error: "messageId is required" });
    }
    const sent = await senderOf(req, String(messageId));
    if (!sent) {
      return res.status(404).json(NOT_FOUND);
    }
    // P10: agent conversations take images up to 5 MB only.
    if (isAgentConversationType(sent.access.conversation.type) && file.size > AGENT_CHAT_LIMITS.maxAttachmentBytes) {
      return res.status(413).json({ error: "Images in agent conversations can be at most 5 MB" });
    }

    // Validate file type and size
    validateImageFile({
      buffer: file.buffer,
      mimeType: file.mimetype,
      fileName: file.originalname,
    });

    // Process and upload
    const result = await mediaService.processImage({
      messageId,
      file: file.buffer,
      fileName: file.originalname,
      mimeType: file.mimetype,
    });

    return res.json({
      success: true,
      data: {
        url: result.url,
        thumbnailUrl: result.thumbnailUrl,
        originalUrl: result.originalUrl,
        width: result.width,
        height: result.height,
        aspectRatio: result.aspectRatio,
        blurhash: result.blurhash,
        fileSize: result.fileSize,
      },
    });
  } catch (error: any) {
    console.error("Image upload error:", error);
    return res.status(400).json({ error: error.message });
  }
}

// -----------------------------
// Upload Chat Audio
// POST /api/chat/media/audio
// -----------------------------
export async function uploadAudioController(req: Request, res: Response) {
  try {
    const file = req.file;
    const messageId = req.body.messageId;
    const duration = req.body.duration ? parseInt(req.body.duration, 10) : undefined;

    if (!file) {
      return res.status(400).json({ error: "No file provided" });
    }

    if (!messageId) {
      return res.status(400).json({ error: "messageId is required" });
    }
    const sentAudio = await senderOf(req, String(messageId));
    if (!sentAudio) {
      return res.status(404).json(NOT_FOUND);
    }
    // P10: no audio in agent conversations.
    if (isAgentConversationType(sentAudio.access.conversation.type)) {
      return res.status(415).json({ error: "Agent conversations accept images only" });
    }

    // Validate file type and size
    validateAudioFile({
      buffer: file.buffer,
      mimeType: file.mimetype,
      fileName: file.originalname,
    });

    // Process and upload
    const result = await mediaService.processAudio({
      messageId,
      file: file.buffer,
      fileName: file.originalname,
      mimeType: file.mimetype,
      duration,
    });

    return res.json({
      success: true,
      data: {
        url: result.url,
        duration: result.duration,
        waveformData: result.waveformData,
        fileSize: result.fileSize,
      },
    });
  } catch (error: any) {
    console.error("Audio upload error:", error);
    return res.status(400).json({ error: error.message });
  }
}

// -----------------------------
// Delete Media
// DELETE /api/chat/media/:messageId
// -----------------------------
export async function deleteMediaController(req: Request, res: Response) {
  try {
    const { messageId } = req.params;
    if (!(await senderOf(req, messageId))) {
      return res.status(404).json(NOT_FOUND);
    }

    await mediaService.deleteMedia(messageId);

    return res.json({ success: true });
  } catch (error: any) {
    console.error("Media delete error:", error);
    return res.status(500).json({ error: error.message });
  }
}

// -----------------------------
// Get Media Info
// GET /api/chat/media/:messageId
// -----------------------------
export async function getMediaController(req: Request, res: Response) {
  try {
    const { messageId } = req.params;
    const actor = actorFrom((req as any).user);
    if (!actor || !(await getMessageAccess(messageId, actor))) {
      return res.status(404).json({ error: "Media not found" });
    }
    const media = await mediaService.getMedia(messageId);

    if (!media) {
      return res.status(404).json({ error: "Media not found" });
    }

    return res.json({ success: true, data: media });
  } catch (error: any) {
    console.error("Media get error:", error);
    return res.status(500).json({ error: error.message });
  }
}