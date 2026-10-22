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

## 📋 Prerequisites

- **Node.js** (v18.0.0 or later recommended; tested on Node.js v22)
- **PostgreSQL** database instance

---

## ⚙️ Environment Configuration

Create a `.env` file in the root directory:

```env
DATABASE_URL="postgresql://<username>:<password>@localhost:5432/realtime_chat?schema=public"
JWT_SECRET="your-super-secure-secret-key-change-this"
PORT=3000
NODE_ENV="development"
```

> **Note**: `.env` is ignored by git to protect credentials.

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

---

## 🚦 Running the Application

### Development Server
```bash
npm run dev
```
The server starts listening on `http://localhost:3000`.

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
| `GET` | `/` | None | Service health-check |
| `POST` | `/dev/token` | None | Dev token generator (*disabled when `NODE_ENV=production`*) |
| `GET` | `/conversations/:id/messages` | `Bearer <JWT>` | Paginated message history (`?limit=50&before=<messageId>`) |
| `GET` | `/conversations/:id/unread` | `Bearer <JWT>` | Retrieves the current user's unread message count |

### Socket.IO Events

| Direction | Event Name | Payload | Description |
|---|---|---|---|
| Client → Server | `joinConversation` | `conversationId: string` | Joins a conversation room after membership check |
| Client → Server | `sendMessage` | `{ conversationId: string, message: string }` | Persists and broadcasts a message to the room |
| Client → Server | `markRead` | `{ conversationId: number, messageId: number }` | Advances member's read pointer; acknowledges with `{ ok, message? }` |
| Server → Client | `joinedConversation` | `room: string` | Confirms room join |
| Server → Client | `messageReceived` | `Message` object | Broadcasts newly saved message record |
| Server → Client | `errorMessage` | `string` | Error notification |
