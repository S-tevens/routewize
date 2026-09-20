const integrationBaseURL = `${location.origin}/v1`;
$("integrationBaseUrl").textContent = integrationBaseURL;

function renderIntegration() {
  const model = JSON.stringify($("integrationModel").value);
  const url = JSON.stringify(integrationBaseURL);
  const examples = {
    javascript: `// Install: npm install openai
// Set ROUTEWISE_API_KEY in your server environment.
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: ${url},
  apiKey: process.env.ROUTEWISE_API_KEY,
});

const answer = await client.chat.completions.create({
  model: ${model},
  messages: [{ role: "user", content: "Classify: I love this product!" }],
  max_tokens: 200,
});

console.log(answer.choices[0].message.content);`,
    python: `# Install: pip install openai
# Set ROUTEWISE_API_KEY in your server environment.
import os
from openai import OpenAI

client = OpenAI(
    base_url=${url},
    api_key=os.environ["ROUTEWISE_API_KEY"],
)

answer = client.chat.completions.create(
    model=${model},
    messages=[{"role": "user", "content": "Classify: I love this product!"}],
    max_tokens=200,
)

print(answer.choices[0].message.content)`,
    curl: `# Set ROUTEWISE_API_KEY in your shell environment.
curl ${JSON.stringify(`${integrationBaseURL}/chat/completions`)} \\
  -H "Authorization: Bearer $ROUTEWISE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ model: $("integrationModel").value, messages: [{ role: "user", content: "Classify: I love this product!" }], max_tokens: 200 }, null, 2).replaceAll("'", "'\\''")}'`,
  };
  $("integrationCode").textContent = examples[$("integrationLanguage").value];
  $("copyIntegration").textContent = "Copy code";
}

let integrationController;
function renderModelCatalog(models = []) {
  const container = $("modelCatalog"); container.replaceChildren();
  for (const model of models) {
    const auto = model.id === "routewise/auto";
    const card = document.createElement("article"); card.className = `model-card${auto ? " auto" : ""}`;
    const head = document.createElement("div"); head.className = "model-card-head";
    const icon = document.createElement("span"); icon.className = "provider-icon"; icon.setAttribute("aria-hidden", "true"); icon.textContent = auto ? "↔" : model.owned_by === "anthropic" ? "A" : "O";
    const provider = document.createElement("span"); provider.textContent = auto ? "Routewise routing" : model.owned_by === "anthropic" ? "Anthropic" : "OpenAI";
    head.append(icon, provider);
    const title = document.createElement("h2"); title.textContent = auto ? "Automatic routing" : model.id.split("/").slice(1).join("/");
    const id = document.createElement("code"); id.textContent = model.id;
    const description = document.createElement("p"); description.textContent = auto ? "Let your configured rules choose a model. Matching requests can route to a cheaper option." : "Send requests to this specific model. Automatic routing will not change your selection.";
    const use = document.createElement("button"); use.className = "text-button"; use.textContent = "Use in your app ↗"; use.setAttribute("aria-label", `Use ${model.id} in your app`);
    use.addEventListener("click", () => { $("integrationModel").value = model.id; renderIntegration(); location.hash = "guide"; });
    card.append(head, title, id, description, use); container.append(card);
  }
}
function resetIntegrationModels() {
  $("integrationModel").replaceChildren(new Option("routewise/auto", "routewise/auto"));
  $("integrationModelStatus").textContent = "Connect your key to list configured models.";
  $("modelCatalogStatus").textContent = "Connect your Routewise key in the top bar to see configured models.";
  renderModelCatalog();
  renderIntegration();
}
async function loadIntegrationModels() {
  integrationController?.abort();
  const controller = new AbortController(); integrationController = controller;
  if (!realKey) { resetIntegrationModels(); return; }
  $("integrationModelStatus").textContent = "Loading configured models…";
  $("modelCatalogStatus").textContent = "Loading configured models…";
  try {
    const response = await fetch("/v1/models", { headers: { Authorization: `Bearer ${realKey}` }, signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Couldn't load models.");
    const previous = $("integrationModel").value;
    $("integrationModel").replaceChildren(...data.data.map((model) => new Option(model.id, model.id)));
    if (data.data.some((model) => model.id === previous)) $("integrationModel").value = previous;
    $("integrationModelStatus").textContent = "Configured models for this key. Provider availability depends on your server credentials.";
    $("modelCatalogStatus").textContent = `${data.data.filter((model) => model.id !== "routewise/auto").length} configured models · automatic routing available`;
    renderModelCatalog(data.data);
    renderIntegration();
  } catch (err) {
    if (err.name !== "AbortError") { resetIntegrationModels(); $("integrationModelStatus").textContent = err.message; $("modelCatalogStatus").textContent = err.message; }
  }
}
$("integrationLanguage").addEventListener("change", renderIntegration);
$("integrationModel").addEventListener("change", renderIntegration);
$("copyIntegration").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("integrationCode").textContent); $("copyIntegration").textContent = "Copied"; }
  catch { $("copyIntegration").textContent = "Select code to copy"; }
});
window.addEventListener("routewise-connected", loadIntegrationModels);
$("apiKey").addEventListener("input", () => { integrationController?.abort(); resetIntegrationModels(); });
window.addEventListener("guide-view", loadIntegrationModels);
window.addEventListener("models-view", loadIntegrationModels);
renderIntegration();
if (["#guide", "#models"].includes(location.hash)) loadIntegrationModels();
