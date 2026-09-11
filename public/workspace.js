const viewNames = ["playground", "usage", "guide", "proof"];
function showView(name) {
  if (!viewNames.includes(name)) name = "playground";
  for (const view of viewNames) document.getElementById(`${view}View`).hidden = view !== name;
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (name === "usage" && allDaily.length) renderForPeriod();
  if (name === "proof") window.dispatchEvent(new Event("proof-view"));
  if (name === "usage") window.dispatchEvent(new Event("overview-view"));
}
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
  location.hash = button.dataset.view;
  showView(button.dataset.view);
}));
window.addEventListener("hashchange", () => showView(location.hash.slice(1)));
showView(location.hash.slice(1));

$("loadExample").addEventListener("click", () => {
  $("questionInput").value = "What is the refund policy?";
  $("contextInput").value = "Customers can request a refund within 30 days of purchase. Items must be unused and returned with proof of purchase.\n\nCustomers can request a refund within 30 days of purchase. Items must be unused and returned with proof of purchase.\n\n---\n\nStandard shipping takes five business days. Express shipping is available in selected regions.\n\n---\n\nOur offices are open Monday through Friday from 9 am to 5 pm.";
  $("tokenBudget").value = 65;
  $("compressionToggle").checked = true;
  $("selectionToggle").checked = true;
  $("protectedDocs").value = "";
  $("previewError").hidden = true;
  $("resultStatus").textContent = "Example loaded";
});
let resultText = "";
$("optimizeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("previewError");
  error.hidden = true;
  if (!realKey) {
    error.textContent = "Enter your Routewise API key in the header first, then try again.";
    error.hidden = false;
    $("apiKey").focus();
    return;
  }
  const button = $("runOptimization");
  button.disabled = true;
  button.textContent = "Optimizing…";
  $("resultStatus").textContent = "Working…";
  $("previewResult").hidden = true;
  $("previewPlaceholder").hidden = false;
  try {
    const payload = playgroundPayload();
    const response = await fetch("/v1/optimize", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${realKey}` },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Couldn't optimize this request. Try again.");
    const metrics = data.metrics;
    $("tokensBefore").textContent = metrics.estimated_input_tokens_before.toLocaleString();
    $("tokensAfter").textContent = metrics.estimated_input_tokens_after.toLocaleString();
    $("reductionPercent").textContent = `${metrics.estimated_input_tokens_before ? Math.round(metrics.estimated_tokens_removed / metrics.estimated_input_tokens_before * 100) : 0}%`;
    $("documentSummary").textContent = `${metrics.context_documents_selected} of ${metrics.context_documents_received} documents retained.${metrics.dropped_context_ids.length ? ` Removed: ${metrics.dropped_context_ids.join(", ")}.` : ""}${metrics.context_documents_received && !metrics.context_documents_selected ? " No references fit this budget. Increase it to retain context." : ""}`;
    if (metrics.context_budget_exceeded) $("documentSummary").textContent += " Protected documents exceed the requested budget and were retained in full.";
    resultText = data.messages.map((message) => `${message.role.toUpperCase()}\n${message.content}`).join("\n\n");
    $("optimizedOutput").textContent = resultText;
    $("previewPlaceholder").hidden = true;
    $("previewResult").hidden = false;
    $("resultStatus").textContent = "Preview complete";
  } catch (err) {
    error.textContent = err.name === "TimeoutError" ? "The preview timed out. Please try again." : err.message;
    error.hidden = false;
    $("resultStatus").textContent = "Try again";
  } finally {
    button.disabled = false;
    button.innerHTML = "Optimize context <span>→</span>";
  }
});

function playgroundPayload() {
  const question = $("questionInput").value.trim();
  if (!question) throw new Error("Add a question in Playground first.");
  const docs = $("contextInput").value.split(/^\s*---\s*$/m).map((s) => s.trim()).filter(Boolean);
  const protectedText = $("protectedDocs").value.trim();
  const indices = protectedText ? protectedText.split(",").map((s) => Number(s.trim())) : [];
  if (indices.some((i) => !Number.isInteger(i) || i < 1 || i > docs.length)) throw new Error("Protected document numbers must match documents in your context.");
  return { messages: [{ role: "user", content: question }], rw_optimization: {
    context: docs.map((text, i) => ({ id: `document-${i + 1}`, text, protected: indices.includes(i + 1) })),
    compression: $("compressionToggle").checked, selection: $("selectionToggle").checked,
    max_context_tokens: Number($("tokenBudget").value),
  } };
}
$("copyResult").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(resultText); $("copyResult").textContent = "Copied"; }
  catch { $("copyResult").textContent = "Select text to copy"; }
  setTimeout(() => { $("copyResult").textContent = "Copy"; }, 2500);
});
$("integrationCode").textContent = `curl ${location.origin}/v1/chat/completions \\\n  -H 'Authorization: Bearer YOUR_ROUTEWISE_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ messages: [{ role: "user", content: "What is the refund policy?" }], rw_optimization: { compression: true, selection: true, max_context_tokens: 2000, context: [{ id: "refund-policy", text: "Refunds are available within 30 days." }] } }, null, 2)}'`;
