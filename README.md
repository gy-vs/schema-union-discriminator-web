# Schema Evolution Studio — Discriminated Union Compatibility

Local workbench for schema revisions, with bidirectional discriminated-union
compatibility analysis.

Run `npm install`, then `npm run dev` (server on :4174, Vite on :4173).

## Compatibility model

Compatibility is computed from **both** producer/consumer directions; the
three verdicts are reported independently (never folded into one boolean):

- **向后兼容 (backward)** — new (v2) producers → old (v1) consumers.
  Adding a discriminator branch to a *closed* union is **not** backward
  compatible: an old consumer rejects the new tag (`unknown_discriminator_value`).
- **向前兼容 (forward)** — old (v1) producers → new (v2) consumers.
- **完全兼容 (full)** — backward ∧ forward.

Unions explicitly model the discriminator **field**, both branch **value
sets**, and the **unknown-branch strategy** (`fail` / `passthrough` /
`default`). Renaming the discriminator field is caught directly instead of
being hidden by per-branch payload checks.

Every failure carries a **minimal counterexample** plus the **union path**
(`at` / discriminator / value / explicit|default|open / both strategies) and
is proven by running the instance through both validators: producer accepts,
consumer rejects (with the validator errors included).

`POST /api/compat/compare` cache keys include direction **and** policy, e.g.
`compat:backward:fail:<canonical v1>::<canonical v2>`.

Covered scenarios (`src/shared/presets.ts`): branch add/remove, discriminator
value reuse, field optionality, nested unions, default branches, open unions,
open-producer vs explicit-branch, and mapping-order changes.

## Tests

`npm test` — engine scenarios, validator-proof counterexamples, HTTP API and
cache-key separation across directions/policies.
