let proofReport = null;
let pendingProof = null;
let proofRunning = false;
const proofMoney = (n) => n === null || n === undefined ? "Unknown" : `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(6)}`;
async function checkProofConfig() {
  if (!realKey) { $("proofConfig").textContent = "Connect a Routewise key to check evaluation availability."; return; }
  try {
    const res = await fetch("/v1/evaluations/config", { headers: { Authorization: `Bearer ${realKey}` } });
    const config = await res.json();
    if (!res.ok) throw new Error("Could not check configuration. Verify your Routewise key.");
    $("proofConfig").textContent = config.ready ? `Ready · ${config.provider} / ${config.default_model}. Costs use the rates configured for your account.` : config.reason;
  } catch (err) { $("proofConfig").textContent = err.message; }
}
window.addEventListener("proof-view", checkProofConfig);
$("connectBtn").addEventListener("click", checkProofConfig);
if (location.hash === "#proof") checkProofConfig();

$("proofForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (proofRunning) return;
  $("proofError").hidden = true;
  try {
    if (!realKey) throw new Error("Connect your Routewise key first.");
    const sample = playgroundPayload();
    const expected = $("expectedPhrases").value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!expected.length) throw new Error("Add at least one required answer phrase.");
    const payload = JSON.stringify({ confirm_paid_calls: $("proofConsent").checked, cases: [{ ...sample, expected_contains: expected }], use_routing: $("proofRouting").checked, overhead_usd_per_request: Number($("proofOverhead").value), max_tokens: 512 });
    // Reuse the key after a network failure; do not silently create another paid job.
    if (pendingProof && pendingProof.payload !== payload) throw new Error("The prior comparison has an uncertain outcome. Restore its inputs and retry to recover it before starting a different comparison.");
    if (!pendingProof) pendingProof = { payload, id: crypto.randomUUID(), apiKey: realKey };
    if (pendingProof.apiKey !== realKey) throw new Error("Use the original Routewise key to recover the pending comparison.");
    proofRunning = true;
    $("runProof").disabled = true;
    $("runProof").textContent = "Comparing two model calls…";
    $("proofState").textContent = "Running baseline and optimized requests. This can take about a minute.";
    $("proofResults").hidden = true;
    $("downloadProof").hidden = true;
    const res = await fetch("/v1/evaluations", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${realKey}`, "Idempotency-Key": pendingProof.id }, body: payload });
    const report = await res.json();
    if (!res.ok || report.error) {
      if ([400, 401, 429].includes(res.status)) pendingProof = null;
      throw new Error(report.error?.message || "Comparison failed. Retry with the same input to recover the result.");
    }
    pendingProof = null;
    proofReport = report;
    window.dispatchEvent(new Event("proof-complete"));
    const row = report.cases[0];
    $("proofState").textContent = "Live provider comparison completed. Review both answers before drawing conclusions.";
    $("proofNet").textContent = proofMoney(report.summary.net_savings_per_replayed_batch_usd);
    $("proofLedger").replaceChildren();
    const lines = [
      ["Original model cost", proofMoney(row.baseline.usage?.cost_usd)],
      ["Optimized model cost", proofMoney(row.optimized.usage?.cost_usd)],
      ["Added overhead / request", proofMoney(report.policy.overhead_usd_per_optimized_request)],
      ["Total cost of this evaluation", proofMoney(report.summary.total_evaluation_cost_usd)],
      ["Input tokens · original → optimized", `${row.baseline.usage?.input_tokens ?? "?"} → ${row.optimized.usage?.input_tokens ?? "?"}`],
      ["Output tokens · original → optimized", `${row.baseline.usage?.output_tokens ?? "?"} → ${row.optimized.usage?.output_tokens ?? "?"}`],
      ["Latency · original → optimized", `${row.baseline.latency_ms} ms → ${row.optimized.latency_ms} ms`],
      ["Required phrase checks", report.summary.checks_passed ? "Passed on both answers" : "Failed or incomplete"],
    ];
    for (const [label, value] of lines) {
      const dt = document.createElement("dt"); dt.textContent = label;
      const dd = document.createElement("dd"); dd.textContent = value;
      $("proofLedger").append(dt, dd);
    }
    $("proofVerdict").textContent = report.summary.next_step;
    $("baselineAnswer").textContent = row.baseline.answer ?? row.baseline.error;
    $("candidateAnswer").textContent = row.optimized.answer ?? row.optimized.error;
    $("proofChecks").textContent = ["baseline", "optimized"].map((arm) => `${arm}: ${(row[arm].checks ?? []).map((c) => `${c.passed ? "pass" : "fail"} — ${c.phrase}`).join("; ") || "No checks completed"}`).join(". ");
    $("proofReceipt").textContent = `Report ${report.id}. ${report.receipt_saved ? "Billing receipt saved on server without prompts or answers." : "Server receipt could not be saved; download this report."}`;
    $("proofResults").hidden = false;
    $("downloadProof").hidden = false;
  } catch (err) {
    $("proofError").textContent = err.message;
    $("proofError").hidden = false;
    $("proofState").textContent = "No new verified report. Resolve the issue and retry.";
  } finally {
    proofRunning = false;
    $("runProof").disabled = false;
    $("runProof").innerHTML = "Run paid comparison <span>→</span>";
  }
});
$("downloadProof").addEventListener("click", () => {
  if (!proofReport) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(proofReport, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `routewise-evaluation-${proofReport.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
