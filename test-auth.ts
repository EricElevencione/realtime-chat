import { generateToken, verifyToken } from "./src/auth.js";

// Test 1: Valid token
try {
  const token = generateToken({ id: 1 });
  const result = verifyToken(token);

  if (result.id !== 1) {
    throw new Error("Expected ID 1");
  }

  console.log("PASS: Valid token accepted");
} catch (error) {
  console.error("FAIL: Valid token rejected", error);
}

// Test 2: Token without an ID
try {
  const tokenWithoutId = generateToken({} as { id: number });

  verifyToken(tokenWithoutId);

  console.error("FAIL: Token without an ID was accepted");
} catch {
  console.log("PASS: Token without an ID rejected");
}
