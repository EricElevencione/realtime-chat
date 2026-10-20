import { requireAuth } from "./auth.js";
import express from "express";

const app = express();

app.use(express.json());

app.get("/:id/messages", requireAuth, (req, res) => {
  const conversationId = Number(req.params.id);
  const rawLimit = req.query.limit;
  const rawBefore = req.query.before; // absent and present
  const parsedLimit =
    typeof rawLimit === "string" && rawLimit !== "" ? Number(rawLimit) : NaN;
  let before: number | undefined;

  if (!Number.isInteger(conversationId)) {
    return res.status(400).json({ message: "Invalid conversation id" });
  }

  const limit = Number.isInteger(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, 100))
    : 50;

  if (rawBefore !== undefined) {
    if (typeof rawBefore !== "string") {
      return res.status(400).json({
        message: "before must be a single string value",
      });
    }

    const parsedBefore = Number(rawBefore);

    if (!Number.isInteger(parsedBefore) || parsedBefore <= 0) {
      return res.status(400).json({
        message: "before must be a positive integer",
      });
    }

    before = parsedBefore;
  }

  res.json({
    conversationId,
    limit,
    before,
    user: res.locals.user,
  });
});
