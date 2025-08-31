import type { Request, Response, NextFunction } from "express";
import redis from "../config/redis.ts";

export const cache = (key: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const data = await redis.get(key);
    if (data) {
      return res.json({ fromCache: true, data: JSON.parse(data) });
    }
    next();
  };
};
