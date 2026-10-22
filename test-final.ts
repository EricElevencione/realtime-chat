import "dotenv/config";
import type { AddressInfo } from "net";
import { io, Socket } from "socket.io-client";
import { httpServer } from "./src/app.js";
import { prisma } from "./src/db.js";
import { generateToken } from "./src/auth.js";

interface MessageRecord {
  id: number;
  content: string;
  senderId: number;
  conversationId: number;
  createdAt: string;
}

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

async function runFinalTest() {
  console.log("===============================================================");
  console.log("   Task 8: Final Verification with Concurrent Clients          ");
  console.log("===============================================================\n");

  // Start test server on dynamic free port
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => resolve());
  });
  const port = (httpServer.address() as AddressInfo).port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`[Setup] In-memory test server listening on ${baseUrl}`);

  const testSuffix = Date.now();
  let userA: { id: number };
  let userB: { id: number };
  let userC: { id: number };
  let conv1: { id: number };
  let conv2: { id: number };

  let socketA: Socket | null = null;
  let socketB: Socket | null = null;
  let socketC: Socket | null = null;

  try {
    // -------------------------------------------------------------
    // CHUNK 1: Reuse test setup with three users & room membership
    // -------------------------------------------------------------
    console.log("--- Chunk 1: Setup test users, conversations, and clients ---");
    userA = await prisma.user.create({
      data: { username: `client_a_${testSuffix}` },
    });
    userB = await prisma.user.create({
      data: { username: `client_b_${testSuffix}` },
    });
    userC = await prisma.user.create({
      data: { username: `client_c_${testSuffix}` },
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

    const tokenA = generateToken({ id: userA.id });
    const tokenB = generateToken({ id: userB.id });
    const tokenC = generateToken({ id: userC.id });

    socketA = await connectSocket(baseUrl, tokenA);
    socketB = await connectSocket(baseUrl, tokenB);
    socketC = await connectSocket(baseUrl, tokenC);

    // Join respective conversations
    const joinAPromise = waitForEvent(socketA, "joinedConversation");
    socketA.emit("joinConversation", String(conv1.id));
    await joinAPromise;

    const joinBPromise = waitForEvent(socketB, "joinedConversation");
    socketB.emit("joinConversation", String(conv1.id));
    await joinBPromise;

    const joinCPromise = waitForEvent(socketC, "joinedConversation");
    socketC.emit("joinConversation", String(conv2.id));
    await joinCPromise;

    console.log("PASS: Chunk 1 - Clients A and B joined Conv 1; Client C joined Conv 2.\n");

    // -------------------------------------------------------------
    // CHUNK 2: Live delivery and room isolation
    // -------------------------------------------------------------
    console.log("--- Chunk 2: Live delivery and room isolation ---");
    const bReceivedLive: MessageRecord[] = [];
    const cReceivedLive: MessageRecord[] = [];

    socketB.on("messageReceived", (msg: MessageRecord) => {
      bReceivedLive.push(msg);
    });
    socketC.on("messageReceived", (msg: MessageRecord) => {
      cReceivedLive.push(msg);
    });

    // A sends message to conv1
    socketA.emit("sendMessage", {
      conversationId: String(conv1.id),
      message: "Room isolation test message from A",
    });

    // Wait for B to receive message
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (bReceivedLive.length >= 1) return resolve();
        if (Date.now() - start > 4000) return reject(new Error("Timeout waiting for B to receive message"));
        setTimeout(check, 40);
      };
      check();
    });

    // Give a small grace period to be certain C receives nothing
    await new Promise((r) => setTimeout(r, 200));

    const msgReceivedByB = bReceivedLive[0]!;
    if (
      msgReceivedByB.content !== "Room isolation test message from A" ||
      msgReceivedByB.senderId !== userA.id ||
      msgReceivedByB.conversationId !== conv1.id ||
      !Number.isInteger(msgReceivedByB.id)
    ) {
      throw new Error(`Chunk 2 FAIL: B received unexpected message payload: ${JSON.stringify(msgReceivedByB)}`);
    }

    if (cReceivedLive.length !== 0) {
      throw new Error(
        `Chunk 2 FAIL: Room isolation breached! Client C received ${cReceivedLive.length} message(s) from Conv 1`,
      );
    }
    console.log("PASS: Chunk 2 - Client B received the exact saved record, Client C received nothing.\n");

    // -------------------------------------------------------------
    // CHUNK 3: History matches what was sent (Pagination & Ordering)
    // -------------------------------------------------------------
    console.log("--- Chunk 3: History matches what was sent (Pagination & Ordering) ---");

    // Send 2 more messages from A to test pagination with 3 total messages
    for (let i = 2; i <= 3; i++) {
      const waitB = new Promise<void>((resolve) => {
        const check = () => {
          if (bReceivedLive.length >= i) resolve();
          else setTimeout(check, 30);
        };
        check();
      });

      socketA.emit("sendMessage", {
        conversationId: String(conv1.id),
        message: `History sequence message #${i}`,
      });

      await waitB;
    }

    // Now B fetches history with a small limit=1 to test cursor pagination page by page
    const fetchedPages: MessageRecord[][] = [];
    let currentCursor: number | null | undefined = undefined;

    while (true) {
      const url: string =
        currentCursor !== undefined && currentCursor !== null
          ? `${baseUrl}/conversations/${conv1.id}/messages?limit=1&before=${currentCursor}`
          : `${baseUrl}/conversations/${conv1.id}/messages?limit=1`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      if (res.status !== 200) {
        throw new Error(`Chunk 3 FAIL: Fetching history failed with status ${res.status}`);
      }

      const data = (await res.json()) as {
        messages: MessageRecord[];
        nextCursor: number | null;
      };

      fetchedPages.push(data.messages);
      if (!data.nextCursor) {
        break;
      }
      currentCursor = data.nextCursor;
    }

    // Reconstruct full conversation from oldest to newest
    // Each page goes further back in time, so reversing the pages gives oldest -> newest
    const reconstructedHistory = fetchedPages.slice().reverse().flat();

    if (reconstructedHistory.length !== 3) {
      throw new Error(
        `Chunk 3 FAIL: Expected 3 paginated messages, got ${reconstructedHistory.length}`,
      );
    }

    for (let i = 0; i < 3; i++) {
      const live = bReceivedLive[i]!;
      const hist = reconstructedHistory[i]!;
      if (live.id !== hist.id || live.content !== hist.content || live.senderId !== hist.senderId) {
        throw new Error(
          `Chunk 3 FAIL: Discrepancy between live and history at index ${i}: live=${JSON.stringify(live)}, history=${JSON.stringify(hist)}`,
        );
      }
    }
    console.log("PASS: Chunk 3 - History over REST matches live broadcast with zero gaps or duplicates.\n");

    // -------------------------------------------------------------
    // CHUNK 4: Concurrent sending
    // -------------------------------------------------------------
    console.log("--- Chunk 4: Concurrent sending from multiple clients ---");
    const aReceivedConcurrent: MessageRecord[] = [];
    const bReceivedConcurrent: MessageRecord[] = [];

    socketA.on("messageReceived", (msg: MessageRecord) => {
      aReceivedConcurrent.push(msg);
    });
    // bReceivedLive also collects live messages for B

    const messagesToSendPerClient = 5;
    const initialBLiveCount = bReceivedLive.length;

    console.log(`[Info] Firing ${messagesToSendPerClient} messages from A and ${messagesToSendPerClient} from B simultaneously...`);

    const sendPromises: Promise<void>[] = [];

    for (let i = 1; i <= messagesToSendPerClient; i++) {
      sendPromises.push(
        Promise.resolve().then(() => {
          socketA!.emit("sendMessage", {
            conversationId: String(conv1.id),
            message: `Concurrent from A #${i}`,
          });
        }),
      );
      sendPromises.push(
        Promise.resolve().then(() => {
          socketB!.emit("sendMessage", {
            conversationId: String(conv1.id),
            message: `Concurrent from B #${i}`,
          });
        }),
      );
    }

    await Promise.all(sendPromises);

    // Total concurrent messages sent = 10
    const expectedTotalConcurrent = messagesToSendPerClient * 2;

    // Wait until both A and B have received all 10 concurrent messages
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const bGot = bReceivedLive.length - initialBLiveCount;
        const aGot = aReceivedConcurrent.length;
        if (bGot >= expectedTotalConcurrent && aGot >= expectedTotalConcurrent) {
          return resolve();
        }
        if (Date.now() - start > 6000) {
          return reject(
            new Error(
              `Timeout waiting for concurrent messages: A received ${aGot}/${expectedTotalConcurrent}, B received ${bGot}/${expectedTotalConcurrent}`,
            ),
          );
        }
        setTimeout(check, 50);
      };
      check();
    });

    // Check message uniqueness and total count in DB
    const totalInDb = await prisma.message.count({
      where: { conversationId: conv1.id },
    });

    const expectedTotal = 3 + expectedTotalConcurrent; // 3 initial + 10 concurrent = 13
    if (totalInDb !== expectedTotal) {
      throw new Error(`Chunk 4 FAIL: Expected ${expectedTotal} total messages in DB, got ${totalInDb}`);
    }

    const allDbMessages = await prisma.message.findMany({
      where: { conversationId: conv1.id },
      orderBy: { id: "asc" },
    });

    const idsSet = new Set(allDbMessages.map((m) => m.id));
    if (idsSet.size !== expectedTotal) {
      throw new Error("Chunk 4 FAIL: Duplicate IDs detected in concurrently sent messages");
    }

    console.log(`PASS: Chunk 4 - All ${expectedTotalConcurrent} concurrent messages broadcast and persisted with unique IDs.\n`);

    // -------------------------------------------------------------
    // CHUNK 5: Auth failures
    // -------------------------------------------------------------
    console.log("--- Chunk 5: Auth failures & rejection checks ---");

    // 5.1 Socket connection without token
    let noTokenRejected = false;
    await new Promise<void>((resolve) => {
      const badSocket = io(baseUrl, {
        auth: {},
        autoConnect: true,
        reconnection: false,
        timeout: 3000,
      });
      badSocket.on("connect_error", (err) => {
        if (err.message === "Authentication token is missing") {
          noTokenRejected = true;
        }
        badSocket.disconnect();
        resolve();
      });
      badSocket.on("connect", () => {
        badSocket.disconnect();
        resolve();
      });
    });
    if (!noTokenRejected) throw new Error("Chunk 5 FAIL: Socket without token was not rejected");

    // 5.2 Socket connection with garbage token
    let garbageTokenRejected = false;
    await new Promise<void>((resolve) => {
      const badSocket = io(baseUrl, {
        auth: { token: "invalid.garbage.jwt" },
        autoConnect: true,
        reconnection: false,
        timeout: 3000,
      });
      badSocket.on("connect_error", (err) => {
        if (err.message === "Invalid or expired token") {
          garbageTokenRejected = true;
        }
        badSocket.disconnect();
        resolve();
      });
      badSocket.on("connect", () => {
        badSocket.disconnect();
        resolve();
      });
    });
    if (!garbageTokenRejected) throw new Error("Chunk 5 FAIL: Socket with garbage token was not rejected");

    // 5.3 REST request without token
    const resNoToken = await fetch(`${baseUrl}/conversations/${conv1.id}/messages`);
    if (resNoToken.status !== 401) throw new Error("Chunk 5 FAIL: REST without token did not return 401");

    // 5.4 REST request with invalid token
    const resBadToken = await fetch(`${baseUrl}/conversations/${conv1.id}/messages`, {
      headers: { Authorization: "Bearer bad.token.here" },
    });
    if (resBadToken.status !== 401) throw new Error("Chunk 5 FAIL: REST with bad token did not return 401");

    // 5.5 Non-member socket room join
    const nonMemberJoinPromise = waitForEvent<string>(socketC!, "errorMessage");
    socketC!.emit("joinConversation", String(conv1.id));
    const nonMemberJoinMsg = await nonMemberJoinPromise;
    if (nonMemberJoinMsg !== "You are not a member of this conversation") {
      throw new Error(`Chunk 5 FAIL: Non-member join expected rejection message, got ${nonMemberJoinMsg}`);
    }

    // 5.6 Non-member REST history fetch
    const resNonMemberHistory = await fetch(`${baseUrl}/conversations/${conv1.id}/messages`, {
      headers: { Authorization: `Bearer ${tokenC}` },
    });
    if (resNonMemberHistory.status !== 403) {
      throw new Error(`Chunk 5 FAIL: Non-member REST history fetch returned status ${resNonMemberHistory.status}`);
    }

    // 5.7 Non-member REST unread count
    const resNonMemberUnread = await fetchUnreadCount(baseUrl, conv1.id, tokenC);
    if (resNonMemberUnread.status !== 403) {
      throw new Error(`Chunk 5 FAIL: Non-member REST unread count returned status ${resNonMemberUnread.status}`);
    }

    console.log("PASS: Chunk 5 - All auth & membership rejection scenarios enforced successfully.\n");

    // -------------------------------------------------------------
    // CHUNK 6: Read state after all traffic
    // -------------------------------------------------------------
    console.log("--- Chunk 6: Read state after heavy traffic ---");

    // Before markRead, B should have unread messages sent by A
    const bUnreadBefore = await fetchUnreadCount(baseUrl, conv1.id, tokenB);
    console.log(`[Info] Client B unread count before markRead: ${bUnreadBefore.body.unreadCount}`);
    if ((bUnreadBefore.body.unreadCount ?? 0) <= 0) {
      throw new Error("Chunk 6 FAIL: Expected positive unread count for B before markRead");
    }

    // Get the latest message ID in conv1
    const latestMessage = allDbMessages.at(-1)!;

    // B emits markRead with latest ID
    const markAck = await emitMarkRead(socketB!, {
      conversationId: conv1.id,
      messageId: latestMessage.id,
    });

    if (!markAck.ok) {
      throw new Error(`Chunk 6 FAIL: markRead returned ${JSON.stringify(markAck)}`);
    }

    // Check B's unread count drops to 0
    const bUnreadAfter = await fetchUnreadCount(baseUrl, conv1.id, tokenB);
    if (bUnreadAfter.status !== 200 || bUnreadAfter.body.unreadCount !== 0) {
      throw new Error(`Chunk 6 FAIL: Expected unread count 0, got ${JSON.stringify(bUnreadAfter.body)}`);
    }

    // Verify pointer in DB
    const memberB = await prisma.conversationMember.findUnique({
      where: { userId_conversationId: { userId: userB.id, conversationId: conv1.id } },
    });
    if (memberB?.lastReadMessageId !== latestMessage.id) {
      throw new Error(
        `Chunk 6 FAIL: Expected pointer ${latestMessage.id}, got ${memberB?.lastReadMessageId}`,
      );
    }

    console.log(`PASS: Chunk 6 - B's pointer advanced to ${latestMessage.id} and unread count dropped to 0.\n`);

    console.log("===============================================================");
    console.log("   ALL TASK 8 FINAL VERIFICATION TESTS PASSED! 🎉              ");
    console.log("===============================================================");
  } finally {
    // Teardown
    console.log("\n[Teardown] Cleaning up sockets, server, and test database records...");
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
      console.warn("[Teardown] Warning during DB cleanup:", cleanupError);
    }

    await prisma.$disconnect();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    console.log("[Teardown] Complete.");
  }
}

runFinalTest().catch((err) => {
  console.error("Task 8 test failed:", err);
  process.exit(1);
});
