import { assertProviderRoute } from "../providers/catalog.js";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { optimizeContext } from "../optimization/context.js";
import { selectRoute } from "../router/rules.js";
import { validateRates, priceResponse } from "./cost.js";

export function prepareEvaluation(customer, body) {
  if (customer.evaluation?.enabled !== true) throw new Error("Live evaluation is not configured for this account. Add provider keys and confirmed model rates on the server.");
  if (body?.confirm_paid_calls !== true) throw new Error("Confirm that this evaluation makes paid provider calls");
  if (!Array.isArray(body.cases) || body.cases.length < 1 || body.cases.length > 3) throw new Error("Supply 1–3 test cases");
  if (body.use_routing !== undefined && typeof body.use_routing !== "boolean") throw new Error("use_routing must be a boolean");
  const overhead = body.overhead_usd_per_request;
  if (!Number.isFinite(overhead) || overhead < 0 || overhead > 100) throw new Error("Supply overhead_usd_per_request between 0 and 100, including your service/infrastructure costs");
  const maxTokens = body.max_tokens ?? 512;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1024) throw new Error("max_tokens must be between 1 and 1024");
  if (JSON.stringify(body).length > 100000) throw new Error("Evaluation input is limited to 100,000 characters");
  const cases = body.cases.map((item, index) => {
    if (!item || !Array.isArray(item.expected_contains) || item.expected_contains.length < 1 || item.expected_contains.length > 20 || item.expected_contains.some((s) => typeof s !== "string" || !s.trim() || s.length > 500)) throw new Error("Each test needs 1–20 expected answer phrases");
    if (!Array.isArray(item.messages) || !item.messages.some((m) => m?.role === "user" && typeof m.content === "string" && m.content.trim())) throw new Error("Each test needs a non-empty user question");
    const options = item.rw_optimization ?? {};
    const baseline = optimizeContext(item.messages, { ...options, compression: false, selection: false }, customer.optimization);
    const optimized = optimizeContext(item.messages, options, customer.optimization);
    const route = body.use_routing ? selectRoute({ customer, promptText: item.messages.map((m) => m.content).join("\n"), forceFlagship: false }) : customer.default;
    const arms = [{ name: "baseline", route: customer.default, messages: baseline.messages }, { name: "optimized", route, messages: optimized.messages }].map((arm) => {
      assertProviderRoute(arm.route);
      const apiKey = customer.provider_keys?.[arm.route.provider];
      if (!apiKey || /REPLACE_ME/.test(apiKey)) throw new Error(`Configure a real ${arm.route.provider} key before running evaluation`);
      const rates = validateRates(customer.evaluation.pricing?.[`${arm.route.provider}/${arm.route.model}`], arm.route.provider);
      return { ...arm, rates, apiKey };
    });
    return { id: `case-${index + 1}`, expected: item.expected_contains.map((s) => s.trim()), arms, metrics: optimized.metrics };
  });
  return { cases, maxTokens, overhead, useRouting: body.use_routing === true, inputHash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

export async function runEvaluation(plan, providers) {
  const report = {
    id: randomUUID(), created_at: new Date().toISOString(), input_sha256: plan.inputHash,
    evidence: "provider_reported_usage_at_customer_supplied_rates", invoice_verified: false,
    quality_method: "case_insensitive_required_phrase_checks_not_semantic_quality",
    policy: { use_routing: plan.useRouting, max_output_tokens: plan.maxTokens, automatic_retries: 0, response_cache: "bypassed", overhead_usd_per_optimized_request: plan.overhead },
    cases: [],
  };
  for (const sample of plan.cases) {
    const row = { id: sample.id, optimization: sample.metrics };
    // Alternate ordering to reduce systematic warm-cache/order bias across cases.
    const arms = report.cases.length % 2 ? [...sample.arms].reverse() : sample.arms;
    for (const arm of arms) {
      const started = performance.now();
      let response;
      const result = { provider: arm.route.provider, requested_model: arm.route.model, rates: arm.rates };
      try {
        response = await providers[arm.route.provider]({ apiKey: arm.apiKey, model: arm.route.model, messages: arm.messages, max_tokens: plan.maxTokens, timeout: 30000, maxRetries: 0 });
        result.answer = response.content;
        result.provider_response_id = response.raw?.id ?? null;
        result.served_model = response.raw?.model ?? arm.route.model;
        result.usage = priceResponse(arm.route.provider, response.raw, arm.rates);
        const finish = arm.route.provider === "anthropic" ? response.raw?.stop_reason : response.raw?.choices?.[0]?.finish_reason;
        result.finish_reason = finish ?? null;
        result.completed = ["stop", "end_turn", "stop_sequence"].includes(finish);
        result.checks = sample.expected.map((phrase) => ({ phrase, passed: typeof response.content === "string" && response.content.toLowerCase().includes(phrase.toLowerCase()) }));
        result.passed = result.completed && result.checks.every((c) => c.passed);
        result.status = "measured";
      } catch (err) {
        // Provider errors can contain sensitive request details. Return only safe categories.
        result.status = "unmeasured";
        result.error = response ? "Usage could not be priced. Review provider billing." : "Provider call failed or timed out. It may still have incurred a charge.";
        result.passed = false;
      }
      result.latency_ms = Math.round(performance.now() - started);
      row[arm.name] = result;
    }
    const known = row.baseline.status === "measured" && row.optimized.status === "measured";
    row.net_savings_usd = known ? row.baseline.usage.cost_usd - row.optimized.usage.cost_usd - plan.overhead : null;
    report.cases.push(row);
  }
  const allMeasured = report.cases.every((c) => c.net_savings_usd !== null);
  const knownSpend = report.cases.reduce((sum, c) => sum + (c.baseline.usage?.cost_usd ?? 0) + (c.optimized.usage?.cost_usd ?? 0), 0);
  const net = allMeasured ? report.cases.reduce((sum, c) => sum + c.net_savings_usd, 0) : null;
  const qualified = report.cases.every((c) => c.baseline.passed && c.optimized.passed);
  report.summary = {
    completed_pairs: report.cases.filter((c) => c.net_savings_usd !== null).length,
    total_pairs: report.cases.length, known_provider_spend_usd: knownSpend,
    total_evaluation_cost_usd: allMeasured ? knownSpend + plan.overhead * report.cases.length : null,
    net_savings_per_replayed_batch_usd: net,
    checks_passed: qualified,
    verdict: !allMeasured ? "inconclusive" : !qualified ? "quality_checks_failed" : net > 0 ? "savings_observed_on_this_sample" : "no_net_savings",
    next_step: !allMeasured ? "Resolve missing billing evidence before drawing conclusions." : !qualified ? "Keep the original policy; inspect failed answers and protect missing context." : net > 0 ? "Review answer quality and test a larger representative dataset before any rollout." : "Keep the original policy; this sample does not justify optimization.",
  };
  return report;
}
