import { createServer } from "http";
import { Server } from "socket.io";
import express from "express";
import "dotenv/config";
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";
import { verifyToken } from "./auth.js";
import { requireAuth } from "./auth.js";

const app = express();

app.use(express.json());

// Development endpoint for generating a JWT.
// Do not expose this unrestricted endpoint in production.
app.post("/dev/token", (_req, res) => {
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
    const userId = socket.data.user?.userId;

    if (!Number.isSafeInteger(conversationId) || typeof userId !== "number") {
      socket.emit("errorMessage", "Invalid user or conversation ID");
      return;
    }

    try {
      const membership = await prisma.conversationMember.findUnique({
        where: {
          userId_conversationId: {
            userId,
            conversationId,
          },
        },
      });

      if (!membership) {
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
    const userId = socket.data.user?.userId;

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
      const membership = await prisma.conversationMember.findUnique({
        where: {
          userId_conversationId: {
            userId,
            conversationId,
          },
        },
      });

      if (!membership) {
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

// Temporary
app.get("/:id/messages", requireAuth, async (req, res) => {
  const conversationId = Number(req.params.id);
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
    return res.status(400).json({
      message: "Invalid conversation id",
    });
  }
  // Parse and clamp the limit (default 50, max 100)
  const rawLimit = req.query.limit;
  const parsedLimit =
    typeof rawLimit === "string" && rawLimit !== "" ? Number(rawLimit) : NaN;
  const limit = Number.isInteger(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, 100))
    : 50;
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    // Always send back the response so curl does not get stuck!
    return res.status(200).json({
      conversationId,
      limit,
      user: res.locals.user,
    });
  } catch (error) {
    console.error("Failed to fetch messages:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
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
