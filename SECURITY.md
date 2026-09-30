# Security posture

Routewize is undergoing pilot hardening. No SOC 2 certification, penetration-test
attestation, guaranteed hard budget, or blanket enterprise-readiness claim is made.

Sensitive assets: provider credentials, customer credentials, prompts/responses,
semantic-cache entries, usage history and evaluation records. Trust boundaries:
customer backend -> gateway -> configured model/embedding/verification providers;
operator -> YAML/environment/storage; browser -> read/inference/evaluation APIs.

Threats and controls:
- Cross-tenant cache reuse: tenant hash plus route/settings/system/scope/version;
  adversarial within-scope false matches remain possible. Disable unsafe caching.
- Stolen dashboard key: no persistent browser storage, optional expiring scoped keys;
  XSS and endpoint compromise still require defense in depth.
- Prompt/key leakage: generic upstream errors, metadata-only request logs; memory
  and provider egress still contain user text. Paid near-miss verification sends
  cached/current prompts and cached answers to the configured judge provider.
- Abuse: input validation, body size limit and durable local rate windows. An edge
  firewall and organization-wide distributed enforcement are not provided here.
- Supply chain: lockfile, tests, dependency audit and CodeQL workflows. Enable GitHub
  secret scanning/push protection and protected-branch review in repository settings.
- Lost storage: checksum-verified offline backup/restore tooling. Operators must
  supply encrypted off-host backups and prove a restore in their own environment.

Do not post secrets or exploit payloads in public issues. Use GitHub private
vulnerability reporting if enabled by the maintainer; a staffed security contact and
response targets must be established before customer onboarding. Review
[production readiness](docs/PRODUCTION_READINESS.md) for unresolved controls.
