# Use Node.js 20 on lightweight Alpine Linux
FROM node:20-alpine

# Install OpenSSL (required by Prisma engine on Alpine)
RUN apk add --no-cache openssl

# Set working directory inside container
WORKDIR /app

# Copy dependency specifications first for Docker layer caching
COPY package*.json ./
COPY prisma.config.ts ./
COPY prisma ./prisma/

# Install exact dependencies
RUN npm ci

# Copy TypeScript configuration and application source
COPY tsconfig.json ./
COPY src ./src/

# Generate Prisma Client and compile TypeScript to ./dist
RUN npm run build

# Default environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose HTTP / WebSocket port
EXPOSE 3000

# Start compiled server
CMD ["node", "dist/server.js"]
