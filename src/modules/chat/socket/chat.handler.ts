import { Server, Socket } from "socket.io";
import type { ParticipantType } from "@prisma/client";
import { actorFrom, getConversationAccess, personalRoom } from "../utils/chat-access.ts";

type EmitFn = (event: string, data: any, room?: string) => void;

export const SocketEmitter = {
  _emit: null as EmitFn | null,
  /** P10: additional servers (the /agent-socket server, flag on only) get room events too. */
  _extra: [] as EmitFn[],
  setEmitter(fn: EmitFn) {
    this._emit = fn;
  },
  addEmitter(fn: EmitFn) {
    this._extra.push(fn);
  },
  toRoom: (room: string) => ({
    emit: (event: string, data: any) => {
      SocketEmitter._emit?.(event, data, room);
      for (const extra of SocketEmitter._extra) extra(event, data, room);
    },
  }),
  // NEW: targets a specific participant's personal room directly, using the
  // same (type, id) pairing as Message's sender columns / ConversationParticipant's
  // identity columns — so callers never have to hand-build the room string.
  toParticipant: (type: ParticipantType, id: string) => ({
    emit: (event: string, data: any) => {
      SocketEmitter._emit?.(event, data, `participant:${type}:${id}`);
      for (const extra of SocketEmitter._extra) extra(event, data, `participant:${type}:${id}`);
    },
  }),
};

interface ChatJoinPayload {
  // Phase 0: participantType / participantId are IGNORED — the identity is the
  // authenticated socket.data.user (chatSocketAuth). They stay in the payload
  // type only so existing clients that still send them keep working.
  participantType?: ParticipantType;
  participantId?: string;
  // Optional: conversation ids the client wants to be live-subscribed to
  // right away. Each one is joined only if the actor may access it.
  conversations?: string[];
}

type Ack = ((res: { ok: boolean; error?: string }) => void) | undefined;
const reply = (ack: Ack, res: { ok: boolean; error?: string }) => {
  if (typeof ack === "function") ack(res);
};

/** Joins `conversation:<id>` only for an actor with access (participant, or support staff on a support chat). */
export async function joinConversationIfAllowed(socket: Socket, conversationId: unknown): Promise<boolean> {
  const actor = actorFrom(socket.data?.user);
  if (!actor || typeof conversationId !== "string" || !conversationId) return false;
  const access = await getConversationAccess(conversationId, actor);
  if (!access || access.viaModeration) return false; // P10: moderation reads go through the audited REST route only
  socket.join(`conversation:${conversationId}`);
  return true;
}

export function initChatSocket(io: Server) {
  SocketEmitter.setEmitter((event, data, room) => {
    if (room) io.to(room).emit(event, data);
    else io.emit(event, data);
  });

  io.on("connection", (socket: Socket) => {
    // Phase 0: the personal/inbox room is derived from the authenticated
    // identity — a client can no longer name another participant's room.
    socket.on("chat:join", async (data: ChatJoinPayload, ack?: Ack) => {
      const actor = actorFrom(socket.data?.user);
      if (!actor) return reply(ack, { ok: false, error: "Unauthorized" });
      socket.join(personalRoom(actor));
      const requested = Array.isArray(data?.conversations) ? data.conversations.slice(0, 200) : [];
      for (const c of requested) {
        try {
          await joinConversationIfAllowed(socket, c);
        } catch {
          // a lookup failure just leaves that room unjoined
        }
      }
      reply(ack, { ok: true });
    });

    // Called when a specific chat thread is opened in the UI. Joined only after
    // the server confirms the actor may access that conversation.
    socket.on("chat:joinConversation", async (conversationId: string, ack?: Ack) => {
      try {
        const ok = await joinConversationIfAllowed(socket, conversationId);
        reply(ack, ok ? { ok: true } : { ok: false, error: "Not found" });
      } catch {
        reply(ack, { ok: false, error: "Not found" });
      }
    });

    socket.on("chat:leaveConversation", (conversationId: string) => {
      if (typeof conversationId !== "string" || !conversationId) return;
      socket.leave(`conversation:${conversationId}`);
    });

    socket.on("disconnect", () => {
      // Handle offline status via redis TTL in presence.handler
    });
  });
}
