import express from "express";
import { requireAuth } from "./auth.js";
import { isConversationMember } from "./membership.js";
import { prisma } from "./db.js";

const router = express.Router();
const MAX_INT = 2_147_483_647; // Max signed 32-bit integer for PostgreSQL/Prisma Int

router.get("/:id/messages", requireAuth, async (req, res) => {
  // 1. Validate conversation ID (positive 32-bit integer)
  const conversationId = Number(req.params.id);
  if (
    !Number.isInteger(conversationId) ||
    conversationId <= 0 ||
    conversationId > MAX_INT
  ) {
    return res.status(400).json({ message: "Invalid conversation id" });
  }

  // 2. Parse limit and before query parameters strictly
  const rawLimit = req.query.limit;
  let limit = 50;

  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "string") {
      return res.status(400).json({
        message: "limit must be a single string value",
      });
    }

    if (rawLimit.trim() !== "") {
      const parsedLimit = Number(rawLimit);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        return res.status(400).json({
          message: "limit must be a positive integer",
        });
      }
      limit = Math.min(parsedLimit, 100);
    }
  }

  const rawBefore = req.query.before;
  let before: number | undefined;

  if (rawBefore !== undefined) {
    if (typeof rawBefore !== "string") {
      return res.status(400).json({
        message: "before must be a single string value",
      });
    }

    const parsedBefore = Number(rawBefore);
    if (
      !Number.isInteger(parsedBefore) ||
      parsedBefore <= 0 ||
      parsedBefore > MAX_INT
    ) {
      return res.status(400).json({
        message: "before must be a positive integer",
      });
    }

    before = parsedBefore;
  }

  try {
    // 3. Membership check (cheap rejection before loading messages)
    const userId = res.locals.user.id;
    const isMember = await isConversationMember(userId, conversationId);

    if (!isMember) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // 4. Query messages: id < before only when cursor exists, newest first, take limit + 1
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        ...(before !== undefined ? { id: { lt: before } } : {}),
      },
      orderBy: {
        id: "desc",
      },
      take: limit + 1,
    });

    // 5. Cursor math: compute hasMore, drop extra row, grab cursor before reversing
    const hasMore = messages.length > limit;
    const pageMessages = messages.slice(0, limit);
    const nextCursor = hasMore ? (pageMessages.at(-1)?.id ?? null) : null;
    const ordered = [...pageMessages].reverse(); // oldest → newest

    // 6. Response shape: { messages, nextCursor }
    return res.json({ messages: ordered, nextCursor });
  } catch (error) {
    console.error("Failed to fetch messages:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
