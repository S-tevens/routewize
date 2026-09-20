import { selectRoute } from "./rules.js";

// Customer configuration is the allowlist for models billed to their keys.
export function configuredModels(customer) {
  const routes = [customer.default, ...(customer.models ?? []), ...(customer.routing?.rules ?? []).map((rule) => rule.route_to)];
  const models = new Map();
  for (const route of routes) {
    if (!route || !["openai", "anthropic"].includes(route.provider) || typeof route.model !== "string" || !route.model) continue;
    models.set(`${route.provider}/${route.model}`, { provider: route.provider, model: route.model });
  }
  return models;
}

export function listModels(customer) {
  return { object: "list", data: [
    { id: "routewise/auto", object: "model", created: 0, owned_by: "routewise" },
    ...[...configuredModels(customer)].map(([id, route]) => ({ id, object: "model", created: 0, owned_by: route.provider })),
  ] };
}

export function resolveModel({ customer, model, promptText, forceFlagship }) {
  if (model !== undefined && (typeof model !== "string" || !model.trim())) {
    throw Object.assign(new Error("model must be a non-empty string"), { status: 400, code: "invalid_model" });
  }
  if (forceFlagship || model === undefined || model === "routewise/auto") return selectRoute({ customer, promptText, forceFlagship });
  const models = configuredModels(customer);
  const matches = models.has(model) ? [models.get(model)] : [...models.values()].filter((route) => route.model === model);
  if (matches.length !== 1) throw Object.assign(new Error("Model is unavailable or ambiguous. Use an ID returned by GET /v1/models, or routewise/auto."), { status: 404, code: "model_not_found" });
  return { ...matches[0], matchedRule: "explicit-model" };
}

export function validateChatRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be a JSON object");
  const supported = new Set(["model", "messages", "temperature", "max_tokens", "stream", "n", "rw_optimization", "force_flagship"]);
  if (Object.keys(body).some((key) => !supported.has(key))) throw new Error("Unsupported parameter. Supported: model, messages, temperature, max_tokens, stream=false, n=1, rw_optimization, force_flagship. Streaming, tools and structured output are not supported yet.");
  if (body.stream !== undefined && body.stream !== false) throw new Error("Only non-streaming requests (stream=false) are supported");
  if (body.n !== undefined && body.n !== 1) throw new Error("Only one answer per request (n=1) is supported");
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) throw new Error("temperature must be a number from 0 to 2");
  if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)) throw new Error("max_tokens must be a positive integer");
  if (body.force_flagship !== undefined && typeof body.force_flagship !== "boolean") throw new Error("force_flagship must be a boolean");
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.some((m) => !m || typeof m !== "object" || Object.keys(m).some((key) => !["role", "content"].includes(key)))) throw new Error("messages must contain text messages with only role and content");
}
