let overviewController;
const preciseMoney = (value) => value == null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: Math.abs(value) > 0 && Math.abs(value) < 1 ? 6 : 2 }).format(value);
function clearFinancialOverview() {
  window.dispatchEvent(new Event("activity-reset"));
  for (const id of ["providerSpend", "potentialSavings", "costSaved", "moneyRequests", "evaluationSpend", "tokensSaved"]) $(id).textContent = "—";
  $("providerSpendNote").textContent = "Waiting for recorded provider usage.";
  $("potentialSavingsNote").textContent = "Run Savings proof to measure the difference.";
  $("costSavedNote").textContent = "Avoided costs estimated from gateway logs.";
  $("costSavedBreakdown").textContent = "";
  $("evaluationSpendNote").textContent = "Separate from gateway spend";
  $("costComparison").setAttribute("hidden", "");
  $("comparisonEmpty").hidden = false;
  $("comparisonNote").textContent = "Original vs optimized cost for the same test inputs.";
  $("liveCostComparison").setAttribute("hidden", "");
  $("liveComparisonEmpty").hidden = false;
  $("liveComparisonNote").textContent = "What your default model would have cost vs. what gateway requests actually cost, by day.";
  $("liveComparisonBadge").textContent = "Waiting for traffic";
}
async function loadFinancialOverview() {
  overviewController?.abort();
  const controller = new AbortController(); overviewController = controller;
  clearFinancialOverview();
  if (!realKey) { $("moneyStatus").textContent = "Connect your Routewize key to load financial evidence."; return; }
  $("moneyStatus").textContent = "Loading recorded costs…";
  try {
    const res = await fetch(`/api/financial-overview?days=${$("overviewDays").value}`, { headers: { Authorization: `Bearer ${realKey}` }, signal: controller.signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "Couldn't load financial evidence.");
    $("providerSpend").textContent = preciseMoney(data.provider_spend_usd);
    $("providerSpendNote").textContent = data.unpriced_requests ? `${data.unpriced_requests} requests lack billing evidence. ${data.priced_requests ? `${preciseMoney(data.known_provider_spend_usd)} is known; total unavailable.` : "Total unavailable."}` : data.request_count ? "Provider-reported usage at configured rates. Excludes evaluation calls." : "No gateway requests in this period.";
    $("potentialSavings").textContent = preciseMoney(data.potential_savings_usd);
    $("potentialSavingsNote").textContent = data.qualified_pairs ? `${data.qualified_pairs} test pairs passed phrase checks.${data.potential_reduction_pct == null ? "" : ` ${data.potential_reduction_pct.toFixed(1)}% net reduction on those pairs.`}` : "No priced comparisons passing both answer checks yet.";
    $("costSaved").textContent = preciseMoney(data.cost_saved_estimate_usd);
    $("costSavedNote").textContent = data.unverified_historical_requests ? `Includes ${data.unverified_historical_requests} unverified historical requests that may contain demo data. Not realized savings.` : "Caching and routing estimates. Excludes unknown overhead and evaluation potential.";
    const breakdown = data.cost_saved_breakdown_usd;
    $("costSavedBreakdown").textContent = breakdown
      ? `Cache ${preciseMoney(breakdown.cache_usd)} · Routing ${preciseMoney(breakdown.routing_usd)} · Prompt caching ${breakdown.prompt_cache_usd == null ? "unpriced" : preciseMoney(breakdown.prompt_cache_usd)}`
      : "";
    $("moneyRequests").textContent = data.request_count.toLocaleString();
    $("evaluationSpend").textContent = preciseMoney(data.known_evaluation_provider_spend_usd);
    $("evaluationSpendNote").textContent = data.evaluation_spend_incomplete ? "Known portion only; some charges are unknown" : "Both test arms; excludes supplied overhead";
    $("moneyStatus").textContent = `${data.priced_requests} of ${data.request_count} gateway requests priced · ${data.evaluation_count} evaluation reports · UTC date range`;
    $("comparisonNote").textContent = data.compared_pairs ? `${data.compared_pairs} priced test pairs across ${data.comparison_daily.length} days. Lower cost is better.` : "Original vs optimized cost for the same test inputs.";
    drawCostComparison("costComparison", "comparisonEmpty", data.comparison_daily);
    const liveDaily = data.live_comparison_daily ?? [];
    $("liveComparisonNote").textContent = data.live_priced_requests ? `${data.live_priced_requests} gateway requests across ${liveDaily.length} days. Lower cost is better.` : "What your default model would have cost vs. what gateway requests actually cost, by day.";
    $("liveComparisonBadge").textContent = data.live_priced_requests ? "Live" : "Waiting for traffic";
    drawCostComparison("liveCostComparison", "liveComparisonEmpty", liveDaily);
    // Daily context estimates use the same UTC calendar window as financials.
    const statsRes = await fetch("/api/stats", { headers: { Authorization: `Bearer ${realKey}` }, signal: controller.signal });
    if (!statsRes.ok) throw new Error("Token statistics unavailable. Financial figures loaded.");
    const stats = await statsRes.json();
    const days = Number($("overviewDays").value), now = new Date();
    const start = days ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1)).toISOString().slice(0, 10) : "";
    const end = now.toISOString().slice(0, 10);
    const daily = stats.daily.filter(day => day.date >= start && day.date <= end);
    window.dispatchEvent(new CustomEvent("activity-data", {detail: {daily, recent: stats.recent, start, end}}));
    selectedDays = days; allDaily = stats.daily; renderForPeriod();
    $("tokensSaved").textContent = daily.reduce((sum, day) => sum + (day.tokensRemoved ?? 0), 0).toLocaleString();
  } catch (err) {
    if (err.name !== "AbortError") $("moneyStatus").textContent = err.message;
  }
}

function drawCostComparison(svgId, emptyId, daily) {
  const svg = $(svgId); svg.replaceChildren();
  svg.toggleAttribute("hidden", !daily.length); $(emptyId).hidden = !!daily.length;
  if (!daily.length) return;
  const ns = "http://www.w3.org/2000/svg";
  const element = (name, attrs, text) => {
    const node = document.createElementNS(ns, name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text !== undefined) node.textContent = text;
    svg.appendChild(node); return node;
  };
  svg.setAttribute("viewBox", "0 0 720 300");
  element("title", {}, svgId === "liveCostComparison" ? "Baseline versus actual gateway cost by day" : "Original versus optimized costs including overhead, by evaluation date");
  element("desc", {}, daily.map((d) => `${d.date}: baseline ${preciseMoney(d.baseline)}, ${svgId === "liveCostComparison" ? "actual" : "optimized including overhead"} ${preciseMoney(d.optimized)}`).join(". "));
  const left = 100, right = 695, top = 20, bottom = 251;
  const max = Math.max(...daily.map((d) => Math.max(d.baseline, d.optimized)), 0.000001) * 1.12;
  const y = (n) => bottom - (n / max) * (bottom - top);
  for (let i = 0; i <= 4; i++) {
    const value = max * i / 4;
    element("line", { x1: left, x2: right, y1: y(value), y2: y(value), stroke: "#d6e0d1", "stroke-dasharray": "3 7" });
    element("text", { x: left - 12, y: y(value) + 4, fill: "#65735f", "font-size": 12, "text-anchor": "end" }, preciseMoney(value));
  }
  // Dotted columns retain exact bar heights; dots are a texture, not token units.
  const slot = (right - left) / daily.length;
  const barWidth = Math.min(66, slot * 0.34);
  const gap = Math.min(2, slot * 0.04);
  const pitch = Math.min(11, barWidth / 2);
  const defs = element("defs", {});
  const labels = svgId === "liveCostComparison"
    ? ["Baseline", "Actual"] : ["Original", "Optimized + overhead"];
  for (const [index, key, color] of [[0, "baseline", "#889c7d"], [1, "optimized", "#4b9247"]]) {
    const pattern = document.createElementNS(ns, "pattern");
    const patternId = `${svgId}-${key}-dots`;
    for (const [name, value] of Object.entries({ id: patternId, width: pitch, height: 11, patternUnits: "userSpaceOnUse" })) pattern.setAttribute(name, value);
    const dot = document.createElementNS(ns, "circle");
    for (const [name, value] of Object.entries({ cx: pitch / 2, cy: 5.5, r: Math.min(3.8, pitch * 0.38), fill: color })) dot.setAttribute(name, value);
    pattern.appendChild(dot); defs.appendChild(pattern);
    daily.forEach((day, i) => {
      const value = day[key];
      const center = left + slot * (i + 0.5);
      const x = center + (index === 0 ? -barWidth - gap : gap);
      const height = Math.max(0, bottom - y(value));
      const label = `${day.date}: ${labels[index]} ${preciseMoney(value)}`;
      const bar = element("rect", { x, y: y(value), width: barWidth, height, fill: `url(#${patternId})`, tabindex: 0, role: "img", "aria-label": label });
      const title = document.createElementNS(ns, "title"); title.textContent = label; bar.appendChild(title);
      // Exact cap preserves small nonzero values that fall between dot rows.
      if (value > 0) element("line", { x1: x, x2: x + barWidth, y1: y(value), y2: y(value), stroke: color, "stroke-width": 1.5 });
    });
  }
  [...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])].forEach((i) => element("text", { x: left + slot * (i + 0.5), y: 282, fill: "#65735f", "font-size": 12, "text-anchor": "middle" }, daily[i].date));

}
$("overviewDays").addEventListener("change", loadFinancialOverview);
$("connectBtn").addEventListener("click", loadFinancialOverview);
window.addEventListener("overview-view", loadFinancialOverview);
window.addEventListener("proof-complete", loadFinancialOverview);
$("apiKey").addEventListener("input", () => { overviewController?.abort(); clearFinancialOverview(); $("moneyStatus").textContent = "Connect this key to load its financial evidence."; });
if (!$("usageView").hidden) loadFinancialOverview();
