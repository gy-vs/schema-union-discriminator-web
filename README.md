# Schema Evolution Studio

Local workbench for schema revisions, with bidirectional compatibility checking
for discriminated unions.

Run `npm install`, then `npm run dev`.

## Compatibility model

`POST /api/compare` takes `{oldSchema, newSchema, policy}` and returns three
**independent** results — they are never folded into one boolean:

- `backward`: a new consumer must read every old instance (`old ⊆ new`)
- `forward`: an old consumer must read every new instance (`new ⊆ old`)
- `full`: compatible in both directions

Each direction reports:

- `compatible` — boolean
- `findings` — every structural difference that witnesses incompatibility
- `counterexample` — the **minimal** instance proving the difference, the JSON
  `path`, the `unionPath` actually traversed (list of
  `{discriminator, branch}` hops, also populated for nested unions), and a
  `proof` containing both validators' verdicts and error lists. Candidates are
  run through the real old/new validators (and shrunk) before being reported.

Union nodes explicitly model the contract:

```json
{
  "kind": "union",
  "discriminator": "type",
  "branches": {"circle": {"kind": "object", "fields": {"type": {"kind": "literal", "value": "circle"}}}},
  "onUnknown": {"mode": "reject"}
}
```

Unknown-branch strategy (`onUnknown`, overridden by the request-level `policy`
when omitted):

- `{"mode": "reject"}` — closed union
- `{"mode": "passthrough"}` — open union, unknown values accepted
- `{"mode": "default", "branch": "other"}` — unknown values validated against a
  named default branch

Covered evolution cases: add/remove branches, discriminator value reuse
(same value, changed payload), fields becoming optional/required, nested
unions, default branches, open unions, and branch/field mapping order changes
(order is irrelevant, thanks to canonical key serialization).

Results are cached per direction; cache keys hash
`{oldSchema, newSchema, direction, policy}` with canonical key order.

Tests: `npm test`.
