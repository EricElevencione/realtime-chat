import jwt from "jsonwebtoken";
import "dotenv/config";
import type { Request, Response, NextFunction } from "express";

// Get the token
const JWT_SECRET = process.env.JWT_SECRET;

// If no jwt
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not defined");
}

// Verify token
interface TokenPayload {
  id: number;
}

// Middleware
export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ message: "Unauthorized: Missing or invalid token format" });
  }

  const token = header.substring(7);

  try {
    const user = verifyToken(token);

    res.locals.user = user;

    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};

export const verifyToken = (token: string): TokenPayload => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });

    // Ensure the decoded payload is a non-null object.
    if (typeof decoded !== "object" || decoded === null) {
      throw new Error("Token payload must be an object");
    }

    // Ensure the payload contains a numeric ID.
    if (!Number.isInteger(decoded.id)) {
      throw new Error("Token ID must be a number");
    }

    // Return the validated payload.
    return { id: decoded.id };
  } catch (error) {
    console.error("Token verification failed:", error);
    throw new Error("Invalid or expired token");
  }
};

// Generate token
export const generateToken = (payload: TokenPayload) => {
  return jwt.sign(payload, JWT_SECRET, { algorithm: "HS256", expiresIn: "7h" });
  // 7-hour lifetime
};
