# Security policy

## Reporting a vulnerability

Report security vulnerabilities **privately** through GitHub's private vulnerability
reporting for this repository:

<https://github.com/rfairburn/pi-review-gate/security/advisories/new>

Do not open public issues or pull requests describing a vulnerability. Public reports of
security problems are redirected to the private route above.

## Scope

In scope: the `pi-review-gate` extension and its shipped surfaces — the review gate and
transmission path, reviewer and executor adapters, delegated execution and landing, web
egress (`WebSearch`, `WebFetch`, `BrowserExtract`, bounded browser), the `ApplyPatch`
engine, background shell tools, and the launcher scripts.

Out of scope: upstream [pi](https://github.com/badlogic/pi-mono) and third-party harness
CLIs (Codex, Claude, generic programs) — report those to their maintainers. A
vulnerability in a dependency maintained by its own project stays in scope when it
affects `pi-review-gate`: report it here as well so the impact on this package is
tracked and coordinated with the upstream maintainer.

## Support and response

`pi-review-gate` is a pre-1.0 project under active development. We make no commitments
about how quickly a report will be triaged or fixed: reports are handled as maintainer
capacity allows, and there is no paid support channel. While a vulnerability is
embargoed, coordination stays private through the advisory route above; once disclosure
is safe, a sanitized public issue is filed and the fix lands through the normal reviewed
workflow described in [CONTRIBUTING.md](CONTRIBUTING.md). Ordinary (non-security) pull
requests keep that workflow's linked-issue policy unchanged.

## General guidance

- The security model, trust boundaries, and fail-closed semantics are documented in
  [docs/security-model.md](docs/security-model.md), which ships with the npm package and
  is also available in this repository.
