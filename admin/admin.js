const $ = (id) => document.getElementById(id);
const money = (value) => value == null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);

async function loadOverview() {
  const token = $("adminToken").value.trim();
  if (!token) { $("status").textContent = "Enter the admin token first."; $("status").className = "error"; return; }
  $("status").textContent = "Loading…"; $("status").className = "";
  $("loadBtn").disabled = true;
  try {
    const res = await fetch(`/admin/api/overview?days=${$("days").value}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "Could not load admin overview.");

    $("totals").hidden = false;
    $("totalCustomers").textContent = data.customer_count;
    $("totalRequests").textContent = data.totals.request_count.toLocaleString();
    $("totalSpend").textContent = money(data.totals.known_provider_spend_usd);
    $("totalSaved").textContent = money(data.totals.cost_saved_estimate_usd);

    $("customerRows").replaceChildren(...data.customers.map((c) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(c.name)}</td><td>${c.request_count.toLocaleString()}</td><td>${money(c.provider_spend_usd ?? c.known_provider_spend_usd)}</td><td>${c.unpriced_requests}</td><td>${money(c.cost_saved_estimate_usd)}</td>`;
      return tr;
    }));
    $("customerTable").hidden = false;
    $("status").textContent = `${data.customer_count} customer(s), last updated now.`;
  } catch (err) {
    $("status").textContent = err.message;
    $("status").className = "error";
  } finally {
    $("loadBtn").disabled = false;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

$("loadBtn").addEventListener("click", loadOverview);
$("adminToken").addEventListener("keydown", (e) => { if (e.key === "Enter") loadOverview(); });
