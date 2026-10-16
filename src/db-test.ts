import { prisma } from "./db.js";

async function main() {
  await prisma.$connect();
  console.log("Connected to PostgreSQL through Prisma!");
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
