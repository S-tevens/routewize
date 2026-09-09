import { getCustomerByApiKey } from "../config/loadConfig.js";

export function authMiddleware(configPath) {
  return (req, res, next) => {
    const authHeader = req.get("authorization") || "";
    const apiKey = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : req.get("x-api-key");

    if (!apiKey) {
      return res.status(401).json({
        error: { message: "Missing API key. Send it as `Authorization: Bearer <key>`.", type: "authentication_error" },
      });
    }

    const customer = getCustomerByApiKey(configPath, apiKey);
    if (!customer) {
      return res.status(401).json({
        error: { message: "Invalid API key.", type: "authentication_error" },
      });
    }

    req.customer = customer;
    next();
  };
}
