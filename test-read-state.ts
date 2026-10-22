import "dotenv/config";
import type { AddressInfo } from "net";
import { io, Socket } from "socket.io-client";
import { httpServer } from "./src/app.js";
import { prisma } from "./src/db.js";
import { generateToken } from "./src/auth.js";

function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event "${event}"`));
    }, timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function connectSocket(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      auth: { token },
      autoConnect: true,
      reconnection: false,
      timeout: 5000,
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => reject(err));
  });
}

function emitMarkRead(
  socket: Socket,
  payload: { conversationId: number; messageId: number },
  timeoutMs = 5000,
): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timeout waiting for markRead acknowledgement"));
    }, timeoutMs);
    socket.emit(
      "markRead",
      payload,
      (response: { ok: boolean; message?: string }) => {
        clearTimeout(timer);
        resolve(response);
      },
    );
  });
}

async function fetchUnreadCount(
  baseUrl: string,
  conversationId: number,
  token: string,
): Promise<{ status: number; body: { unreadCount?: number; message?: string } }> {
  const res = await fetch(`${baseUrl}/conversations/${conversationId}/unread`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const body = (await res.json()) as { unreadCount?: number; message?: string };
  return { status: res.status, body };
}

async function runTests() {
  console.log("=== Task 7: Read/Unread Status Test Suite ===\n");

  // 1. Start test server on dynamic port
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => resolve());
  });
  const port = (httpServer.address() as AddressInfo).port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`[Setup] Test server running on ${baseUrl}`);

  const testSuffix = Date.now();
  let userA: { id: number };
  let userB: { id: number };
  let userC: { id: number };
  let conv1: { id: number };
  let conv2: { id: number };
  let otherMessage: { id: number };

  let socketA: Socket | null = null;
  let socketB: Socket | null = null;
  let socketC: Socket | null = null;

  try {
    // 2. Create test fixtures in database
    console.log("[Setup] Creating test users and conversations...");
    userA = await prisma.user.create({
      data: { username: `test_user_a_${testSuffix}` },
    });
    userB = await prisma.user.create({
      data: { username: `test_user_b_${testSuffix}` },
    });
    userC = await prisma.user.create({
      data: { username: `test_user_c_${testSuffix}` },
    });

    conv1 = await prisma.conversation.create({
      data: {
        members: {
          create: [
            { userId: userA.id, lastReadMessageId: null },
            { userId: userB.id, lastReadMessageId: null },
          ],
        },
      },
    });

    conv2 = await prisma.conversation.create({
      data: {
        members: {
          create: [{ userId: userC.id, lastReadMessageId: null }],
        },
      },
    });

    otherMessage = await prisma.message.create({
      data: {
        content: "Message from another conversation",
        senderId: userC.id,
        conversationId: conv2.id,
      },
    });

    const tokenA = generateToken({ id: userA.id });
    const tokenB = generateToken({ id: userB.id });
    const tokenC = generateToken({ id: userC.id });

    // 3. Connect sockets for Client A and Client B
    console.log("[Setup] Connecting Client A and Client B sockets...");
    socketA = await connectSocket(baseUrl, tokenA);
    socketB = await connectSocket(baseUrl, tokenB);

    // Join conv1
    const joinAPromise = waitForEvent(socketA, "joinedConversation");
    socketA.emit("joinConversation", String(conv1.id));
    await joinAPromise;

    const joinBPromise = waitForEvent(socketB, "joinedConversation");
    socketB.emit("joinConversation", String(conv1.id));
    await joinBPromise;

    console.log("[Setup] Client A and B connected and joined conversation " + conv1.id + "\n");

    // ==========================================
    // STEP 1: A sends 3 messages, and B's unread count is 3.
    // ==========================================
    console.log("--- Step 1: A sends 3 messages, and B's unread count is 3 ---");
    const receivedMessages: Array<{ id: number; content: string }> = [];

    const messageHandler = (msg: { id: number; content: string }) => {
      receivedMessages.push(msg);
    };
    socketB.on("messageReceived", messageHandler);

    for (let i = 1; i <= 3; i++) {
      const waitPromise = new Promise<void>((resolve) => {
        const check = () => {
          if (receivedMessages.length >= i) resolve();
          else setTimeout(check, 50);
        };
        check();
      });

      socketA.emit("sendMessage", {
        conversationId: String(conv1.id),
        message: `Message #${i} from A`,
      });

      await waitPromise;
    }

    if (receivedMessages.length !== 3) {
      throw new Error(`Expected B to receive 3 messages, but got ${receivedMessages.length}`);
    }

    const [msg1, msg2, msg3] = receivedMessages as [
      { id: number; content: string },
      { id: number; content: string },
      { id: number; content: string },
    ];
    console.log(`[Info] Sent 3 messages: IDs = [${msg1.id}, ${msg2.id}, ${msg3.id}]`);

    // Check B's unread count via REST
    const unreadRes1 = await fetchUnreadCount(baseUrl, conv1.id, tokenB);
    if (unreadRes1.status !== 200 || unreadRes1.body.unreadCount !== 3) {
      throw new Error(
        `Step 1 FAIL: Expected unread count 3, got status ${unreadRes1.status} and body ${JSON.stringify(unreadRes1.body)}`,
      );
    }
    console.log("PASS: A sends 3 messages, and B's unread count is 3 (unreadCount = 3)\n");

    // ==========================================
    // STEP 2: B emits markRead with latest ID, and B's count becomes 0.
    // ==========================================
    console.log("--- Step 2: B emits markRead with latest ID, and B's count becomes 0 ---");
    const markResLatest = await emitMarkRead(socketB, {
      conversationId: conv1.id,
      messageId: msg3.id,
    });

    if (!markResLatest.ok) {
      throw new Error(`Step 2 FAIL: markRead ack returned not ok: ${JSON.stringify(markResLatest)}`);
    }

    const unreadRes2 = await fetchUnreadCount(baseUrl, conv1.id, tokenB);
    if (unreadRes2.status !== 200 || unreadRes2.body.unreadCount !== 0) {
      throw new Error(
        `Step 2 FAIL: Expected unread count 0, got status ${unreadRes2.status} and body ${JSON.stringify(unreadRes2.body)}`,
      );
    }

    const memberBAfterLatest = await prisma.conversationMember.findUnique({
      where: { userId_conversationId: { userId: userB.id, conversationId: conv1.id } },
    });
    if (memberBAfterLatest?.lastReadMessageId !== msg3.id) {
      throw new Error(
        `Step 2 FAIL: DB lastReadMessageId expected ${msg3.id}, got ${memberBAfterLatest?.lastReadMessageId}`,
      );
    }
    console.log(`PASS: B emits markRead with latest ID (${msg3.id}), count becomes 0, and DB pointer updated to ${msg3.id}\n`);

    // ==========================================
    // STEP 3: B emits markRead with an older ID, and nothing changes.
    // ==========================================
    console.log("--- Step 3: B emits markRead with an older ID, and nothing changes ---");
    const markResOlder = await emitMarkRead(socketB, {
      conversationId: conv1.id,
      messageId: msg1.id,
    });

    if (!markResOlder.ok) {
      throw new Error(`Step 3 FAIL: markRead ack returned not ok: ${JSON.stringify(markResOlder)}`);
    }

    const unreadRes3 = await fetchUnreadCount(baseUrl, conv1.id, tokenB);
    if (unreadRes3.status !== 200 || unreadRes3.body.unreadCount !== 0) {
      throw new Error(
        `Step 3 FAIL: Expected unread count to remain 0, got ${unreadRes3.body.unreadCount}`,
      );
    }

    const memberBAfterOlder = await prisma.conversationMember.findUnique({
      where: { userId_conversationId: { userId: userB.id, conversationId: conv1.id } },
    });
    if (memberBAfterOlder?.lastReadMessageId !== msg3.id) {
      throw new Error(
        `Step 3 FAIL: DB lastReadMessageId moved backwards! Expected ${msg3.id}, got ${memberBAfterOlder?.lastReadMessageId}`,
      );
    }
    console.log(`PASS: B emits markRead with older ID (${msg1.id}), unread count is still 0, pointer remained ${msg3.id}\n`);

    // ==========================================
    // STEP 4: B emits markRead with an ID from another conversation, and it's rejected.
    // ==========================================
    console.log("--- Step 4: B emits markRead with an ID from another conversation, and it's rejected ---");
    const markResOther = await emitMarkRead(socketB, {
      conversationId: conv1.id,
      messageId: otherMessage.id,
    });

    if (markResOther.ok) {
      throw new Error(
        `Step 4 FAIL: Expected markRead with other conversation message ID to fail, but it succeeded!`,
      );
    }
    console.log(`[Info] Rejected with message: "${markResOther.message}"`);

    const memberBAfterOther = await prisma.conversationMember.findUnique({
      where: { userId_conversationId: { userId: userB.id, conversationId: conv1.id } },
    });
    if (memberBAfterOther?.lastReadMessageId !== msg3.id) {
      throw new Error(
        `Step 4 FAIL: DB lastReadMessageId was unexpectedly changed! Expected ${msg3.id}, got ${memberBAfterOther?.lastReadMessageId}`,
      );
    }
    console.log("PASS: B emits markRead with ID from another conversation, and it is rejected\n");

    // ==========================================
    // STEP 5: Additional Edge Cases & Security Checks
    // ==========================================
    console.log("--- Step 5: Edge cases and security checks ---");

    // 5a. User's own messages never count as unread
    console.log("[5a] Verifying user's own sent messages are excluded from unread count...");
    const unreadResA = await fetchUnreadCount(baseUrl, conv1.id, tokenA);
    if (unreadResA.body.unreadCount !== 0) {
      throw new Error(`Step 5a FAIL: Expected user A unread count 0 for own messages, got ${unreadResA.body.unreadCount}`);
    }
    console.log("PASS: User A's unread count is 0 (own messages are excluded)");

    // 5b. Non-member access to REST unread count is forbidden
    console.log("[5b] Verifying non-member REST route returns 403 Forbidden...");
    const unreadResNonMember = await fetchUnreadCount(baseUrl, conv1.id, tokenC);
    if (unreadResNonMember.status !== 403) {
      throw new Error(`Step 5b FAIL: Expected 403 for non-member, got status ${unreadResNonMember.status}`);
    }
    console.log("PASS: Non-member REST unread route returned 403 Forbidden");

    // 5c. Non-member socket markRead is forbidden
    console.log("[5c] Verifying non-member markRead socket event is rejected...");
    socketC = await connectSocket(baseUrl, tokenC);
    const markResNonMember = await emitMarkRead(socketC, {
      conversationId: conv1.id,
      messageId: msg3.id,
    });
    if (markResNonMember.ok || markResNonMember.message !== "Forbidden") {
      throw new Error(`Step 5c FAIL: Expected forbidden for non-member, got ${JSON.stringify(markResNonMember)}`);
    }
    console.log("PASS: Non-member markRead returned { ok: false, message: 'Forbidden' }");

    // 5d. Invalid payload rejection
    console.log("[5d] Verifying invalid markRead payload is rejected...");
    const markResInvalid = await emitMarkRead(socketB, {
      conversationId: -1,
      messageId: msg3.id,
    });
    if (markResInvalid.ok || markResInvalid.message !== "Invalid payload") {
      throw new Error(`Step 5d FAIL: Expected Invalid payload rejection, got ${JSON.stringify(markResInvalid)}`);
    }
    console.log("PASS: Invalid payload markRead returned { ok: false, message: 'Invalid payload' }\n");

    console.log("==========================================");
    console.log("ALL TASK 7 TESTS PASSED SUCCESSFULLY! 🎉");
    console.log("==========================================");
  } finally {
    // Teardown
    console.log("\n[Teardown] Cleaning up resources...");
    if (socketA) socketA.disconnect();
    if (socketB) socketB.disconnect();
    if (socketC) socketC.disconnect();

    try {
      if (conv1?.id) await prisma.conversation.delete({ where: { id: conv1.id } });
      if (conv2?.id) await prisma.conversation.delete({ where: { id: conv2.id } });
      if (userA?.id) await prisma.user.delete({ where: { id: userA.id } });
      if (userB?.id) await prisma.user.delete({ where: { id: userB.id } });
      if (userC?.id) await prisma.user.delete({ where: { id: userC.id } });
    } catch (cleanupError) {
      console.warn("Cleanup warning:", cleanupError);
    }

    await prisma.$disconnect();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    console.log("[Teardown] Done.");
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
