export interface CursorResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  // ✅ FIX: Safety check before passing to Buffer
  if (!cursor || typeof cursor !== "string") {
    throw new Error("Invalid or missing cursor");
  }
  
  const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
  const [createdAt, id] = decoded.split("|");
  return { createdAt: new Date(createdAt), id };
}

export function getPrismaCursorFilter(cursor?: string | null): any {
  // ✅ FIX: The ! operator safely catches null, undefined, and empty strings
  if (!cursor) {
    return {};
  }

  try {
    const { createdAt, id } = decodeCursor(cursor);
    return {
      OR: [
        { createdAt: { lt: createdAt } }, 
        { createdAt: createdAt, id: { lt: id } }
      ]
    };
  } catch (error) {
    // If the cursor is malformed, just return an empty filter (fetches from the beginning)
    console.error("Failed to parse cursor:", error);
    return {};
  }
}