import { generateToken, verifyToken } from "./src/auth.js";

// Test 1: Valid token
const token = generateToken({ id: 1 });
console.log(verifyToken(token));

// Test 2: Token without an ID
const tokenWithoutId = generateToken({} as { id: number });

try {
  console.log(verifyToken(tokenWithoutId));
} catch (error) {
  console.log("Invalid payload rejected");
}
