import { timingSafeEqual } from "node:crypto";

// Deliberately independent of customer auth (auth.js): no shared code, no
// shared config path, no customer api_key ever satisfies this. A customer
// can never reach an admin route no matter what they send, and a bug in
// customer auth can never widen into admin access, because the two don't
// touch each other. ADMIN_TOKEN is a separate secret (env var only, never
// in customers.yaml) -- unset means admin routes are off, not "open."
export function adminAuth() {
  return (req, res, next) => {
    const token = process.env.ADMIN_TOKEN;
    if (!token) {
      return res.status(503).json({ error: { message: "Admin access is not configured on this server.", type: "admin_not_configured" } });
    }

    const authHeader = req.get("authorization") || "";
    const supplied = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
    const suppliedBuf = Buffer.from(supplied);
    const tokenBuf = Buffer.from(token);
    const match = suppliedBuf.length === tokenBuf.length && timingSafeEqual(suppliedBuf, tokenBuf);

    if (!match) {
      return res.status(401).json({ error: { message: "Invalid admin token.", type: "authentication_error" } });
    }

    next();
  };
}
