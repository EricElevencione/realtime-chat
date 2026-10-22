import { createServer } from "http";
import { Server } from "socket.io";
import express from "express";
import "dotenv/config";
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";
import { verifyToken } from "./auth.js";
import { requireAuth } from "./auth.js";
import { isConversationMember } from "./membership.js";
import conversationsRouter from "./conversations.routes.js";
import { markConversationRead } from "./readState.js";

const app = express();

app.use(express.json());
app.use("/conversations", conversationsRouter);

// Development endpoint for generating a JWT.
// Do not expose this unrestricted endpoint in production.
app.post("/dev/token", (_req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({
      error: "Endpoint not available in production",
    });
  }

  const secret = process.env.JWT_SECRET;

  // Prevent token generation if the server secret is missing.
  if (!secret) {
    return res.status(500).json({
      error: "JWT_SECRET is not configured",
    });
  }

  // Generate a token containing the user's ID that expires in one hour.
  const token = jwt.sign({ id: 1 }, secret, { expiresIn: "1h" });

  res.json({ token });
});

// Create an HTTP server that will handle Express and Socket.IO.
const httpServer = createServer(app);

// Attach Socket.IO to the existing HTTP server.
const io = new Server(httpServer, {
  cors: {
    // Allow connections from any origin during development.
    // Restrict this to your frontend origin in production.
    origin: "*",
  },
});

// Authenticate each Socket.IO connection using a JWT.
io.use((socket, next) => {
  const token = socket.handshake.auth.token;

  if (typeof token !== "string") {
    return next(new Error("Authentication token is missing"));
  }

  try {
    // Store the verified identity for use in later event handlers.
    socket.data.user = verifyToken(token);

    // Allow the connection to proceed after successful authentication.
    next();
  } catch {
    // Reject tokens that are invalid or expired.
    next(new Error("Invalid or expired token"));
  }
});

// Register event handlers for each successfully authenticated client.

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Join a conversation only if the authenticated user is a member.
  socket.on("joinConversation", async (rawConversationId: unknown) => {
    if (
      typeof rawConversationId !== "string" ||
      !/^[1-9]\d*$/.test(rawConversationId)
    ) {
      socket.emit("errorMessage", "Invalid conversation ID");
      return;
    }

    const conversationId = Number(rawConversationId);
    const userId = socket.data.user?.id;

    if (!Number.isSafeInteger(conversationId) || typeof userId !== "number") {
      socket.emit("errorMessage", "Invalid user or conversation ID");
      return;
    }

    try {
      const isMember = await isConversationMember(userId, conversationId);

      if (!isMember) {
        socket.emit(
          "errorMessage",
          "You are not a member of this conversation",
        );
        return;
      }

      const room = String(conversationId);
      await socket.join(room);
      socket.emit("joinedConversation", room);
    } catch (error) {
      console.error("Failed to join conversation:", error);
      socket.emit("errorMessage", "Could not join conversation");
    }
  });

  socket.on(
    "markRead",
    async (
      payload: unknown,
      ack?: (response: { ok: boolean; message?: string }) => void,
    ) => {
      const reply = typeof ack === "function" ? ack : () => {};

      // 1. payload is untrusted: check it's two positive integers
      const { conversationId, messageId } = (payload ?? {}) as {
        conversationId?: unknown;
        messageId?: unknown;
      };

      if (!isPositiveInt(conversationId) || !isPositiveInt(messageId)) {
        return reply({ ok: false, message: "Invalid payload" });
      }

      // 2. identity comes from the token, never from the payload
      const userId = socket.data.user?.id;
      if (typeof userId !== "number") {
        return reply({ ok: false, message: "Unauthorized" });
      }

      try {
        // 3. permission comes from the database
        const isMember = await isConversationMember(userId, conversationId);
        if (!isMember) {
          return reply({ ok: false, message: "Forbidden" });
        }

        // 4. move the pointer (your chunk 2 function)
        const ok = await markConversationRead(
          userId,
          conversationId,
          messageId,
        );
        if (!ok) {
          return reply({
            ok: false,
            message: "Message not found in this conversation",
          });
        }

        return reply({ ok: true });
      } catch (error) {
        console.error("markRead failed:", error);
        return reply({ ok: false, message: "Server error" });
      }
    },
  );

  // Save the message first, then broadcast the saved database record.
  socket.on("sendMessage", async (payload: unknown) => {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("conversationId" in payload) ||
      !("message" in payload)
    ) {
      socket.emit("errorMessage", "Invalid message payload");
      return;
    }

    const { conversationId: rawConversationId, message } = payload;
    const userId = socket.data.user?.id;

    if (
      typeof rawConversationId !== "string" ||
      !/^[1-9]\d*$/.test(rawConversationId) ||
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 2000 ||
      typeof userId !== "number"
    ) {
      socket.emit("errorMessage", "Invalid message or conversation ID");
      return;
    }

    const conversationId = Number(rawConversationId);

    if (!Number.isSafeInteger(conversationId)) {
      socket.emit("errorMessage", "Invalid conversation ID");
      return;
    }

    try {
      // Check membership on the server; never trust the client alone.
      const isMember = await isConversationMember(userId, conversationId);

      if (!isMember) {
        socket.emit(
          "errorMessage",
          "You are not a member of this conversation",
        );
        return;
      }

      // Persist the message before broadcasting it.
      const savedMessage = await prisma.message.create({
        data: {
          content: message.trim(),
          senderId: userId,
          conversationId,
        },
      });

      // Broadcast the saved record, including its database ID and timestamp.
      io.to(String(conversationId)).emit("messageReceived", savedMessage);
    } catch (error) {
      console.error("Failed to save or send message:", error);
      socket.emit("errorMessage", "Message could not be sent");
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Simple health-check endpoint to confirm the API is running.
app.get("/", (_req, res) => {
  res.send("Real-Time Chat API is running");
});

// Tempo file for testing
app.get("/test-auth", requireAuth, (req, res) => {
  return res.status(200).json({
    message: "Authentication successful",
    user: res.locals.user,
  });
});

// Export the HTTP server so another file can start listening on a port.

export { httpServer };
