/* Reads existing customer statistics; never loads prompts or provider credentials. */
(() => {
  let daily = [], recent = [], filtered = [];
  const byId = id => document.getElementById(id);
  const outcome = row => row.cache_hit ? 'cache' : row.matched_rule && !['default-fallback', 'forced-flagship'].includes(row.matched_rule) ? 'routed' : 'default';
  const labels = {cache: 'Cache hit', routed: 'Routed cheaper', default: 'Default model'};
  const money = value => typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(6)}` : 'Unknown';
  const cell = (row, text) => { const td = document.createElement('td'); td.textContent = text; row.append(td); return td; };
  function render() {
    const query = byId('activitySearch').value.trim().toLowerCase();
    const selection = byId('activityOutcome').value;
    filtered = recent.filter(row => `${row.model_requested || ''} ${row.model_used || ''}`.toLowerCase().includes(query) && (selection === 'all' || outcome(row) === selection));
    byId('explorerCount').textContent = `${filtered.length} matching events · ${recent.length} of the latest 25 fall in this date range`;
    const body = byId('explorerRows'); body.replaceChildren();
    for (const event of filtered) {
      const row = document.createElement('tr');
      cell(row, new Date(event.timestamp).toISOString().replace('T', ' ').slice(0, 19));
      cell(row, event.cache_hit ? 'Response cache' : event.model_used || 'Unknown');
      cell(row, labels[outcome(event)]); cell(row, money(event.estimated_savings));
      const details = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = 'View'; details.append(summary);
      const dl = document.createElement('dl'); dl.className = 'event-details';
      for (const [name, value] of [['Requested model', event.model_requested], ['Used model', event.model_used], ['Routing rule', event.matched_rule], ['Route reason', event.route_why], ['Provider spend (USD)', event.financials?.provider_spend_usd], ['Estimated context tokens removed', event.optimization?.estimated_tokens_removed]]) {
        const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value == null ? 'Not recorded' : String(value); dl.append(dt, dd);
      }
      details.append(dl); cell(row, '').append(details); body.append(row);
    }
    if (!filtered.length) { const row = document.createElement('tr'); const td = cell(row, 'No matching events. Try another period or clear the filters.'); td.colSpan = 5; body.append(row); }
    byId('exportRecent').disabled = !filtered.length;
  }
  // Quote every cell and neutralize spreadsheet formulas in untrusted model names.
  function csvCell(value) { let s = value == null ? '' : String(value); if (typeof value === 'string' && /^[\s]*[=+@-]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; }
  function download(name, rows) {
    const url = URL.createObjectURL(new Blob([rows.map(row => row.map(csvCell).join(',')).join('\r\n')], {type:'text/csv;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  byId('exportDaily').addEventListener('click', () => download('routewize-daily.csv', [['date_utc','requests','estimated_savings_usd','cache_hits','routed_cheaper','estimated_context_tokens_removed'], ...daily.map(d => [d.date,d.requests,d.savings,d.cacheHits,d.routedCheaper,d.tokensRemoved])]));
  byId('exportRecent').addEventListener('click', () => download('routewize-recent-sample.csv', [['timestamp','requested_model','used_model','outcome','estimated_savings_usd'], ...filtered.map(e => [e.timestamp,e.model_requested,e.model_used,labels[outcome(e)],e.estimated_savings])]));
  byId('activitySearch').addEventListener('input', render); byId('activityOutcome').addEventListener('change', render);
  byId('resetActivity').addEventListener('click', () => { byId('activitySearch').value = ''; byId('activityOutcome').value = 'all'; render(); });
  window.addEventListener('activity-reset', () => { daily = []; recent = []; filtered = []; byId('explorerRows').replaceChildren(); byId('explorerCount').textContent = 'Connect a key or wait for statistics to load.'; for (const id of ['explorerCache','explorerRouted']) byId(id).textContent = '—'; byId('exportDaily').disabled = true; byId('exportRecent').disabled = true; });
  window.addEventListener('activity-data', ({detail}) => {
    daily = detail.daily;
    recent = detail.recent.filter(row => { const time = new Date(row.timestamp); if (!Number.isFinite(time.getTime())) return false; const date = time.toISOString().slice(0,10); return date >= detail.start && date <= detail.end; });
    const total = daily.reduce((sum,d) => sum + d.requests, 0);
    for (const [id,key] of [['explorerCache','cacheHits'],['explorerRouted','routedCheaper']]) byId(id).textContent = total ? `${(100 * daily.reduce((sum,d)=>sum + d[key],0) / total).toFixed(1)}%` : '—';
    byId('exportDaily').disabled = !daily.length; render();
  });
})();
