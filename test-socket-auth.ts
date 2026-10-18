import "dotenv/config";
import { io } from "socket.io-client";
import { generateToken } from "./src/auth.js";

const SERVER_URL = "http://localhost:3000";

function testConnection(
  label: string,
  auth: Record<string, unknown>,
  shouldConnect: boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const socket = io(SERVER_URL, {
      auth,
      autoConnect: false,
      reconnection: false,
      timeout: 3000,
    });

    let finished = false;

    const finish = (passed: boolean, detail?: string) => {
      if (finished) return;
      finished = true;

      console.log(
        `${passed ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`,
      );

      socket.disconnect();
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      finish(false, "Connection timed out");
    }, 5000);

    socket.on("connect", () => {
      finish(shouldConnect);
    });

    socket.on("connect_error", (error) => {
      finish(!shouldConnect, error.message);
    });

    socket.connect();
  });
}

async function main() {
  // Test 1: Valid token
  await testConnection(
    "Valid token",
    { token: generateToken({ id: 1 }) },
    true,
  );

  // Test 2: Invalid token
  await testConnection("Invalid token", { token: "not.a.valid.token" }, false);

  // Test 3: Missing token
  await testConnection("Missing token", {}, false);
}

main().catch(console.error);
