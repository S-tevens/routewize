import express from "express";
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { prepareEvaluation, runEvaluation } from "./evaluate.js";
import { evaluationProviders } from "../providers/registry.js";

const receiptFile = fileURLToPath(new URL("../../logs/evaluations.log", import.meta.url));
const digest = (s) => createHash("sha256").update(s).digest("hex");
export function evaluationRouter({ providers = evaluationProviders, saveReceipt = (receipt) => appendFile(receiptFile, JSON.stringify(receipt) + "\n", { mode: 0o600 }) } = {}) {
  const router = express.Router();
  const jobs = new Map();
  const active = new Set();
  router.get("/config", (req, res) => {
    const customer = req.customer;
    let ready = true;
    let reason = "Ready for a paid evaluation";
    try {
      prepareEvaluation(customer, { confirm_paid_calls: true, overhead_usd_per_request: 0, cases: [{ messages: [{ role: "user", content: "Readiness check" }], expected_contains: ["check"] }] });
    } catch (err) { ready = false; reason = err.message; }
    res.json({ ready, reason, default_model: customer.default?.model, provider: customer.default?.provider, pricing: customer.evaluation?.pricing ?? {}, max_cases: 3, max_calls_per_case: 2 });
  });
  router.post("/", async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: { message: "Send a JSON evaluation object" } });
    const idempotency = req.get("Idempotency-Key");
    if (!idempotency || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotency)) return res.status(400).json({ error: { message: "Supply an Idempotency-Key of 16–100 letters, numbers, underscores or hyphens" } });
    const tenant = digest(req.customer.api_key);
    const key = `${tenant}:${idempotency}`;
    const hash = digest(JSON.stringify(req.body));
    for (const [id, job] of jobs) if (job.finished && Date.now() - job.created > 3600000) jobs.delete(id);
    const existing = jobs.get(key);
    if (existing) {
      if (existing.hash !== hash) return res.status(409).json({ error: { message: "This Idempotency-Key was used with a different request" } });
      return res.json(await existing.promise);
    }
    let plan;
    try { plan = prepareEvaluation(req.customer, req.body); }
    catch (err) { return res.status(400).json({ error: { message: err.message } }); }
    if (active.has(tenant) || jobs.size >= 200) return res.status(429).json({ error: { message: "Evaluation is busy. Retry later with the same Idempotency-Key." } });
    active.add(tenant);
    const job = { hash, created: Date.now(), finished: false };
    job.promise = (async () => {
      try {
        const report = await runEvaluation(plan, providers);
        // Keep billing evidence without storing prompts, generated text or test phrases.
        const receipt = { ...report, customer_sha256: tenant, cases: report.cases.map((c) => ({
          id: c.id, net_savings_usd: c.net_savings_usd,
          ...Object.fromEntries(["baseline", "optimized"].map((name) => {
            const { answer, checks, ...billing } = c[name];
            return [name, billing];
          })),
        })) };
        try { await saveReceipt(receipt); report.receipt_saved = true; }
        catch { report.receipt_saved = false; }
        return report;
      } catch { return { error: { message: "Evaluation interrupted. Review provider billing before starting another run." } }; }
      finally { job.finished = true; active.delete(tenant); }
    })();
    jobs.set(key, job);
    res.json(await job.promise);
  });
  return router;
}
