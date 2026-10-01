# review-loop default rubric

## Dimension definitions & boundaries

Each dimension measures ONE thing; the `*Not:*` clause hands the overlap to its
most-confused neighbor so a finding lands in exactly one dimension.

- **Correctness** — produces the specified result for every stated input/state
  AND serves the stated GOAL/intent, not just the literal letter; invariants hold;
  every failure mode is explicitly named (its *recovery* is scored under
  Reliability); architectural & design rules are followed; spec ↔ code ↔ tests
  agree. *Not:* behavior under failure/retry/partial state (→ Reliability).
- **Safety** — no actor or untrusted input can drive it into an unauthorized,
  destructive, or irreversible state; controls at the access boundary, secrets
  contained, dangerous/irreversible ops gated; meets applicable cybersecurity
  standards and regulatory/compliance obligations; names anti-patterns that create
  business or legal risk (data-handling, confidentiality, IP, licensing). *Not:*
  accidental failure (→ Reliability); a wrong-but-benign result (→ Correctness).
- **Reliability** — stays correct across failure, partial/corrupt state, retries,
  restarts, and false external assumptions; recovery defined, no data loss; errors
  carry actionable, stable diagnostic codes + context so a failure can be debugged
  and recovered, not guessed. *Not:* wrong logic on a good path (→ Correctness).
- **Observability** — from emitted signals alone you could diagnose a prod failure
  and know what ran; every failure path emits a structured, correlated,
  content-disciplined event; quantitative AND qualitative metrics exist where
  drift matters, so an obs layer can measure it over time; failures surface **hard
  and loud** — never silently swallowed. *Not:* whether the logic is right — a
  defined-but-never-emitted signal is still an Observability gap; trust in the
  evidence itself (→ Verifiability).
- **Verifiability** — the strength of evidence behind every quality claim:
  every load-bearing behavior has a mechanical check PROVEN able to fail
  (sabotage-tested: broken on purpose, went red, restored green); tests exercise
  the production call path, not an injection shortcut the real call site doesn't
  perform; no vacuous assertion counts as coverage. A green gate that has never
  been red is an unverified claim, not evidence. *Not:* whether the logic is
  right (→ Correctness) or whether runtime signals are emitted (→ Observability)
  — this is whether the REVIEW can trust its inputs without a human spot-check.
- **Efficiency** — no work or spend the task doesn't require: nothing done twice,
  eagerly, or redundantly (duplicate fetches, recomputation, accidental
  client+server duplication), and cost is proportionate to the outcome — known
  operating/capital expenditure (per-call $, infra tier, storage) is justified.
  *Not:* how heavy the necessary work is on the hot path (→ Performance); the
  cost of absorbing future change (→ Maintainability); a parallel implementation
  of a capability that exists elsewhere in the system (→ Coherence).
- **Performance** — cost of the necessary work as the USER perceives it on hot
  paths: latency, round-trips, query shape (N+1), payload/bundle size, memory;
  bounds (cache/pagination) stated; no regression vs the prior milestone; retry/
  backoff is bounded — no aggressive retries that amplify load (thundering herd).
  *Not:* doing unnecessary work (→ Efficiency).
- **Simplicity** — the least-complex design that meets the outcome: no speculative
  generality, no abstraction without a first real consumer, no incidental
  complexity (overloaded fields, dead params). *Not:* correctness or speed — this
  is structural cost to a reader TODAY; whether the design absorbs the next
  change (→ Maintainability).
- **Maintainability** — the cost of the NEXT change: a competent engineer or a
  context-poor agent can locate, understand, and safely extend this without
  holding the whole system in their head. Extension points are explicit and
  **mechanically gated** (adding the Nth collection/route/provider touches a
  bounded set, and a test fails when one touchpoint is missed); cross-module
  dependencies are one-directional and named; the public interface states its
  stability and deprecation contract; tests pin behavior, not internals, so a
  refactor does not rewrite the suite. *Not:* whether today's design is minimal
  (→ Simplicity) or whether work is wasted outright (→ Efficiency) — this is
  whether the design absorbs change that has NOT happened yet.
- **Coherence** — the artifact fits the system it lands in: it reuses the
  established helper, pattern, or convention rather than introducing a parallel
  one; no second implementation of an existing capability; naming, idiom, and
  error-code vocabulary match the neighboring subsystems. *Not:* internal
  structure of this artifact (→ Simplicity), duplicated work within it
  (→ Efficiency), or absorbing future change (→ Maintainability) — this is
  drift ACROSS artifacts produced by different sessions/agents.
- **Usability** — for the humans who operate or consume it (end users AND
  operators): affordances, failure UX, and a11y present and humane. *Not:*
  internal code ergonomics (→ Simplicity).

