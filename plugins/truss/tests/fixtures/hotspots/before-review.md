## Plan review: three route kinds

I agree with all four extend verdicts. Each crew adds a new route inside its own module and registers it in the existing router. That is the textbook case of `extend` ("a new route"). I could not check this against `docs/architecture.md`, because the plan names that file but gives no copy. No client trigger applies: there is no new service, no stored data shape and no broken principle.

I do not agree with the plan as written. Every crew's acceptance test is the shell command `true`, and that alone should send the plan back. The stage split also costs wall time for no real gain. The docs crew is set up to write docs before the code exists.

### PM: acceptance tests are `true` on every crew
RECOMMEND: answer
Reason: Every crew in plan.json has `"acceptanceTest": "true"` and `"acceptanceTestProved": true`. That test passes before any code is written and after any code is written, so it can be gamed by doing nothing, and calling it "proved" is false.
Answer: Send the plan back to the design engineer. Each route crew needs a test that sends a request to its route (users, orders or billing) and checks the status and the response body against realistic data. That test must fail on the base branch and pass on the crew branch, and that red-then-green result is what "proved" has to mean. The docs crew needs a check that each route the code registers appears in `docs/api.md`, or the crew should be folded away, as the third item below says.

### PM: three serial stages exist only to share `src/router.ts`
RECOMMEND: answer
Reason: plan.md puts users, orders and billing in stages 1, 2 and 3 only because all three own `src/router.ts`. Their real work is in three separate folders: `src/users/**`, `src/orders/**` and `src/billing/**`. Under ADR-0043, crews that share a file merge in turn, so sharing a file is no reason to put them in separate stages.
Answer: Put all three route crews in one stage and let them merge in turn. Each crew rebases onto the router change merged before it. A one-line route registration rebases cheaply, so this costs little rework and removes two stage gates. There is a catch. `maxParallelCrews` is 1, so they would still run one after another unless that limit goes up. If the limit has to stay at 1, merge the three crews into a single crew that owns `src/router.ts` and all three module folders. Running three crews one at a time with three rebases on one file is the worst of both options.

### PM: docs-pass runs in stage 1, before orders and billing exist
RECOMMEND: answer
Reason: plan.md puts docs-pass in stage 1 beside users-route. At that point the orders and billing routes do not exist, so the crew would either document routes nobody has built or leave them out and go stale by stage 3. It also needs a second crew slot in stage 1, which `maxParallelCrews: 1` does not allow.
Answer: Drop docs-pass as its own crew. Each route crew should document its route in `docs/api.md` with the code in the same round. That means `docs/api.md` is shared like `src/router.ts`, and it merges in turn the same way. If the PM wants a separate docs crew anyway, it has to run in a stage after all three routes have merged.

Nothing in this plan carries a long-term cost the client would still pay after the run, so I have written no LONG-TERM-COST line.
