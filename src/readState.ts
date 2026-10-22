import { prisma } from "./db.js";

async function messageBelongsToConversation(
  messageId: number,
  conversationId: number,
): Promise<boolean> {
  const message = await prisma.message.findFirst({
    where: { id: messageId, conversationId },
    select: { id: true },
  });
  return message !== null;
}

export async function markConversationRead(
  userId: number,
  conversationId: number,
  messageId: number,
): Promise<boolean> {
  // Rule 2: the message must belong to this conversation
  const belongs = await messageBelongsToConversation(messageId, conversationId);
  if (!belongs) return false;

  // Rule 1: only move forward
  await prisma.conversationMember.updateMany({
    where: {
      userId,
      conversationId,
      OR: [
        { lastReadMessageId: null },
        { lastReadMessageId: { lt: messageId } },
      ],
    },
    data: { lastReadMessageId: messageId },
  });

  return true;
}

export async function getUnreadCount(
  userId: number,
  conversationId: number,
): Promise<number> {
  // find this user's pointer
  const member = await prisma.conversationMember.findUnique({
    where: { userId_conversationId: { userId, conversationId } },
    select: { lastReadMessageId: true },
  });

  const pointer = member?.lastReadMessageId ?? 0; // null → 0 → "count everything"

  return prisma.message.count({
    where: {
      conversationId,
      id: { gt: pointer }, // newer than the pointer
      senderId: { not: userId }, // exclude messages I wrote
    },
  });
}
