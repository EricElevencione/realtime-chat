import { prisma } from "./db.js";
import express from "express";
import { requireAuth } from "./auth.js";

const app = express();

app.use(express.json());

app.get("/:id/messages", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.user.id;
    const conversationId = Number(req.params.id);
    const messageId = req.body.messageId;
  } catch {}
});
