# Production hardening — 2026-09-30

This is a single-host pilot deployment foundation, not enterprise certification.
Validation: 193 automated tests pass; dependency audit reports zero known vulnerabilities
at the time of this change. These results are not a security certification.

No real provider requests, customer savings study, public deployment, independent
penetration test or legal review were performed for this change.

## Behavior changes to review before upgrading

- Text chat rejects unknown options, unsupported message fields, non-text content,
  invalid token limits and malformed streaming/cache settings instead of ignoring them.
  Tool calls, structured response formats and multimodal requests remain unsupported.
- Semantic cache namespaces now include exact system instructions, optional trusted
  `rw_cache.scope` and `rw_cache.version`. Different namespaces do not share answers.
  `rw_cache.disabled: true` bypasses semantic lookup/storage and its embedding call;
  it does NOT disable the provider's native prompt caching. `cache.require_scope: true`
  bypasses semantic caching unless the customer's backend supplies a scope.
  Scope must include end-user identity and permission boundaries; rotate version on
  document/permission changes. Never trust a scope submitted directly by an end user.
  Similar user questions within one namespace can still hit. This is not a fix for
  adversarial embedding collisions or a guarantee of semantic equivalence. Disable
  semantic caching for secrets, authorization-sensitive or personalized responses.
- Dry-run now uses the same cache namespace helper and honors force_flagship and
  cache options. Earlier cross-route/cache estimates can change. Context-optimization
  records are rejected because the dry-run does not reproduce that transformation.
- Dashboard keys are no longer persisted in browser storage; old saved keys are
  removed on page load. Re-enter a scoped key after reloading. Browser scripts still
  have access while the page is open; this does not solve XSS or replace SSO.
- Customer names and primary keys must be unique. Keep both stable: legacy log
  records use the customer name, newer financial records also have a tenant hash.
- Upstream exceptions return generic errors. Use X-Request-ID to correlate logs;
  raw upstream bodies and exception messages are not exposed to clients.
- Disconnects abort the foreground provider/embedding request. Cancellation does
  not guarantee the provider stops billing; reconcile partial/unknown charges.
- Rate windows and recorded spend now persist in logs/usage.sqlite. SQLite operations
  coordinate processes sharing ONE local database, not machines or network disks.
  Existing in-memory totals cannot be migrated: deploy at a UTC day boundary or
  reconcile manually. This remains a soft daily threshold: no atomic reservations,
  no ceiling on concurrent in-flight cost, and incomplete embedding/evaluation/
  unknown-charge accounting. Do not sell it as a guaranteed hard budget.

## Credentials

Run `npm run key:create` locally in a private terminal. Deliver the generated raw
key through the customer's approved secret channel; do not paste it into tickets.
Store only its `sha256`, `expires_at`, and scopes in customers.yaml under auth.keys.
Use `read` for dashboard statistics/provider catalog, `inference` for chat/optimization,
and `evaluation` for paid evaluation creation. Separate keys are recommended.
Set `auth.legacy_key_enabled: false` after testing replacement credentials. The
primary `api_key` remains a stable internal tenant identifier, not a login credential.
To revoke, set `revoked: true` or remove the entry, save valid config and verify a
401. Invalid config reload keeps the previous config, including previous credentials;
check the reload result and test revocation rather than assuming it succeeded.
Restart if urgently revoking during a config reload failure. ADMIN_TOKEN is separate.

## Deploy, monitor and recover

1. Run `npm ci`, `npm test`, and `npm run check:setup`. The latter is offline and
   deliberately fails for the demo configuration. Supply current rates and actual
   provider credentials in your environment. Never use mock embeddings for real traffic.
2. Review `Dockerfile` and `compose.yaml`. Build an immutable image tagged with the
   commit SHA. Docker execution is not verified on the development host (no engine).
   CI tests Node code; a staging image-build/restore test is still required.
3. The Compose listener is bound to 127.0.0.1. Put an HTTPS reverse proxy/load balancer
   in front of it with trusted certificates, request-size/time limits, and streaming
   buffering disabled. Do not expose port 8787 directly to the public internet.
   Set ADMIN_TOKEN and install provider secrets in the deployment secret store.
   Persist the data volume and validate ownership for the non-root node user.
   Restart after atomic replacement of the bind-mounted config file; a Docker file
   bind mount can retain the previous inode rather than seeing that replacement.
4. `/healthz` is liveness; `/readyz` checks config and writable log directory, not
   provider availability. Scrape `/admin/api/metrics` using the admin bearer token
   from a private monitoring network. Histograms cover whole HTTP request lifetime,
   including streaming duration; they do not represent time to first token.
   Metrics reset on restart; export them to your monitoring system.
5. Connect `ops/alerts.yml` to Prometheus/Alertmanager and assign a real on-call owner.
   This file alone does not send alerts. Routewize does not ship a hosted status page.
6. On SIGTERM/SIGINT, new requests are rejected and active HTTP connections get up
   to 30 seconds to drain. Longer requests/background work can be interrupted. Disable
   paid near-miss verification and allow it to finish before planned maintenance.
7. Roll back by redeploying the previous immutable image with its compatible config
   and the same data volume. Back up first; test schema compatibility in staging.

### Offline backup and retention

Stop ALL writers before these commands, including replicas and background jobs.
`--offline` acknowledges this requirement; it does not discover other processes.

```
node scripts/maintainLogs.js backup logs /secure/new-backup-directory --offline
node scripts/maintainLogs.js restore /secure/new-backup-directory /secure/new-restored-logs --offline
node scripts/maintainLogs.js retain logs 30 --offline
node scripts/maintainLogs.js retain logs 30 --offline --apply
```

Backup includes request/evaluation JSONL and the durable usage ledger/WAL, with
SHA-256 corruption checks. Restore refuses an existing destination. The request
SQLite index is derived and rebuilt; it is not copied. Config and secret recovery
are separate responsibilities. Encrypt backups using the chosen hosting platform
and restrict operator access. A local snapshot is not a disaster-recovery plan.

Retention defaults to preview; `--apply` rewrites the logs and removes the derived
request index/WAL. Unknown timestamps are preserved; malformed/partial JSONL stops
maintenance before rewriting. Histories shown in the dashboard shrink accordingly.
This implementation loads a log into memory, so run before files outgrow available
memory; automated online rotation/streaming compaction is still outstanding. Apply
retention separately to backup copies. It does not implement customer-specific export
or erasure, nor delete the usage ledger. Establish those procedures before promising
privacy-request fulfillment. Verify restore and log reindexing in staging regularly.

## Launch gates still open

| Gate | Required evidence / implementation |
|---|---|
| Real provider compatibility | Each offered model: normal/SSE, usage, truncation, disconnect and failures using real keys; tool/schema support if required by the pilot |
| Real savings and quality | Customer-controlled paired evaluation, latency and all overheads; reconcile actual provider invoices |
| Hard budgets | Durable atomic preauthorization, settlement/idempotency, conservative unknown charges, all paid paths covered |
| Multiple hosts | Shared cache, distributed quotas and coordination, operational datastore decision |
| Enterprise identity | Organization membership/RBAC, SSO/MFA, audit trail for admin actions; SCIM if required |
| Privacy operations | Enforced scheduling/rotation, customer export/deletion and backup expiry; data residency/egress agreements |
| Operational evidence | Hosted HTTPS staging/production, alert delivery, load/soak tests, recovery drill, incident owner and support SLA |
| Security evidence | Threat-model review, independent pentest, remediation and secret scanning; SOC 2 only through a real audit |
| Contracts | Approved legal entity/contact, privacy policy, DPA, subprocessor list, terms, pricing and support commitments |

## Incident procedure template (operator must assign owners)

Record incident ID, UTC timeline, affected tenants, symptoms and request IDs. Never
copy prompts, credentials or raw provider errors into public tickets. Stop/bypass the
affected route, revoke compromised scoped keys, rotate provider secrets if exposed,
and disable semantic caching for suspected cross-user/incorrect responses. Notify
affected customers through the agreed channel, coordinate with their engineering
owner, restore from a tested backup if needed, then verify provider billing and
publish a factual timeline with corrective actions. Do not promise an SLA until an
owner, coverage hours and escalation path have been agreed.
