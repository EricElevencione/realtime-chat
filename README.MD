# Real-Time Chat API

A robust, production-grade real-time chat backend built with **Node.js**, **Express**, **Socket.IO**, **Prisma ORM**, and **PostgreSQL**.

Designed for high reliability, room isolation, secure authentication, cursor-based pagination, and lean read-status tracking.

---

## 🚀 Key Features

- **JWT-Secured WebSockets & REST**: Every socket connection and REST request is authenticated using signed JSON Web Tokens (`HS256`).
- **Strict Room Isolation & Membership Checks**: Users can only join, send messages to, or read history/unread status for conversations they are verified members of in PostgreSQL.
- **Persistent Real-Time Messaging**: Messages are validated and persisted to the database before being broadcast to room members.
- **Cursor-Based History Pagination**: `GET /conversations/:id/messages` supports backward cursor pagination (`limit` & `before`), returning chronological message slices without duplication or missed entries.
- **Lean Read / Unread Status Tracking**:
  - Implements a monotonic per-member pointer (`lastReadMessageId` on `ConversationMember`).
  - Read pointer only advances forward (old or out-of-order events never move it backward).
  - Validates that acknowledged messages belong strictly to that conversation.
  - Excludes self-sent messages from unread counts.
- **Production Safeguards**: Development-only endpoints (such as `/dev/token`) are automatically disabled in production (`NODE_ENV === "production"`).
- **Concurrency & Resilience**: Verified to handle concurrent message streams from multiple clients with guaranteed uniqueness and delivery integrity.

---

## 🛠️ Tech Stack

- **Runtime & Language**: Node.js, TypeScript
- **HTTP Framework**: Express 5
- **Real-Time Engine**: Socket.IO 4
- **ORM & Database**: Prisma ORM 7 with PostgreSQL (`@prisma/adapter-pg`)
- **Authentication**: `jsonwebtoken`
- **Runner & Development**: `tsx`

---

## 🐳 One-Command Local Setup (Docker Compose)

Anyone can run this entire stack locally with zero manual database configuration using Docker Compose:

```bash
docker compose up --build
```

**What this spins up automatically**:
- **PostgreSQL 16**: With healthcheck verification and persistent data volume (`postgres_data`).
- **Redis 7**: In-memory cache and real-time pub/sub layer.
- **Chat API**: Builds from `node:20-alpine`, automatically applies migrations via `prisma migrate deploy`, and starts the server on `http://localhost:3000`.

To stop the containers:
```bash
docker compose down
```

---

## 📋 Prerequisites (For Local Non-Docker Development)

- **Node.js** (v20.0.0 or later recommended; tested on Node.js v20/v22)
- **PostgreSQL** database instance
- **Docker & Docker Compose** (optional, for containerized run)

---

## ⚙️ Environment Configuration

Create a `.env` file in the root directory:

```env
DATABASE_URL="postgresql://<username>:<password>@localhost:5432/realtime_chat?schema=public"
JWT_SECRET="your-super-secure-secret-key-change-this"
PORT=3000
NODE_ENV="development"
```

> **Note**: `.env` is ignored by git to protect credentials. Inside Docker, `DATABASE_URL` connects using the container name `postgres` instead of `localhost`.

---

## 📦 Setup & Database Migration

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Run database migrations**:
   ```bash
   npx prisma migrate dev
   ```

3. **Generate Prisma Client**:
   ```bash
   npx prisma generate
   ```

4. **Build TypeScript for Production**:
   ```bash
   npm run build
   ```

---

## 🚦 Running the Application

### Development Server (Hot Reload via tsx)
```bash
npm run dev
```

### Production Server (Compiled JavaScript)
```bash
npm start
```
The server starts listening on `http://0.0.0.0:3000` (or `PORT` provided by your cloud host).

---

## 🧪 Testing

The repository contains an automated end-to-end integration test suite that spawns an in-memory server, creates test users and rooms, simulates concurrent WebSocket clients, tests authorization boundaries, and performs complete cleanup.

### Run All Final Verification Tests
```bash
npm test
```
*(or `npm run test:final` / `npx tsx test-final.ts`)*

**What this verifies**:
1. **Room Isolation**: Client A sends a message in Conversation 1; Client B in Conversation 1 receives it, while Client C in Conversation 2 receives nothing.
2. **Cursor-Based History**: Paginates backwards page-by-page using `nextCursor` and confirms that REST history matches live socket broadcasts with zero gaps or duplicates.
3. **Concurrent Sending**: Multiple clients fire simultaneous message streams; verifies persistence, delivery, and strictly unique message IDs.
4. **Auth & Membership Rejections**:
   - Connections without token or with invalid tokens are rejected.
   - Non-members are forbidden from joining rooms, sending messages, or reading history.
5. **Read / Unread State**:
   - `markRead` advances the read pointer to the latest message and unread count drops to 0.
   - Older message IDs cannot move the pointer backward.
   - Message IDs belonging to other conversations are rejected.
   - User's own sent messages are never counted as unread.

### Run Read-State Specific Tests
```bash
npm run test:read-state
```

### Run Unit / Auth Tests
```bash
npx tsx test-auth.ts
npx tsx test-socket-auth.ts
```

---

## 📡 API Reference

### REST Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/` | None | Service root check |
| `GET` | `/health` | None | Production readiness & liveness check with DB ping |
| `POST` | `/dev/token` | None | Dev token generator (*disabled when `NODE_ENV=production`*) |
| `GET` | `/conversations/:id/messages` | `Bearer <JWT>` | Paginated message history (`?limit=50&before=<messageId>`) |
| `GET` | `/conversations/:id/unread` | `Bearer <JWT>` | Retrieves the current user's unread message count |

---

## 🚀 Deployment & CI/CD

### 🔄 GitHub Actions CI Pipeline
Every push and pull request to `main` triggers `.github/workflows/ci.yml`:
1. Spawns an ephemeral PostgreSQL 16 container.
2. Installs clean dependencies with `npm ci`.
3. Runs `prisma migrate deploy` to test migrations.
4. Executes the full integration test suite (`npm test`).
5. Compiles TypeScript with `npm run build` to verify type safety.

### ☁️ Production Deployment (Render / Railway / Fly.io)

1. **Connect Repository**: Link this GitHub repository to Render or Railway.
2. **Provision Managed PostgreSQL**: Create a hosted PostgreSQL database on the platform.
3. **Environment Variables**:
   - `DATABASE_URL`: Set to the managed database connection string.
   - `JWT_SECRET`: Set to a strong production secret.
   - `NODE_ENV`: Set to `production`.
4. **Build & Release Settings**:
   - **Build Command**: `npm ci && npm run build`
   - **Pre-deploy / Release Command**: `npx prisma migrate deploy`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`

### Socket.IO Events

| Direction | Event Name | Payload | Description |
|---|---|---|---|
| Client → Server | `joinConversation` | `conversationId: string` | Joins a conversation room after membership check |
| Client → Server | `sendMessage` | `{ conversationId: string, message: string }` | Persists and broadcasts a message to the room |
| Client → Server | `markRead` | `{ conversationId: number, messageId: number }` | Advances member's read pointer; acknowledges with `{ ok, message? }` |
| Server → Client | `joinedConversation` | `room: string` | Confirms room join |
| Server → Client | `messageReceived` | `Message` object | Broadcasts newly saved message record |
| Server → Client | `errorMessage` | `string` | Error notification |
