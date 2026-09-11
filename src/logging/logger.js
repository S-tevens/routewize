import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOG_DIR = fileURLToPath(new URL("../../logs/", import.meta.url));
export const LOG_FILE = path.join(LOG_DIR, "requests.log");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

export function logRequestEvent(event) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  fs.appendFile(LOG_FILE, line + "\n", (err) => {
    if (err) console.error("Failed to write request log:", err);
  });
  console.log(
    `[${event.cache_hit ? "CACHE HIT " : "MISS      "}] customer=${event.customer} requested=${event.model_requested} used=${event.model_used} saved=$${event.estimated_savings.toFixed(5)}`
  );
}
