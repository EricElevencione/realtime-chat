import { prisma } from "./db.js";

export async function isConversationMember(
  userId: number,
  conversationId: number,
): Promise<boolean> {
  const member = await prisma.conversationMember.findUnique({
    where: {
      userId_conversationId: {
        userId,
        conversationId,
      },
    },
    select: { userId: true },
  });

  return member !== null;
}
