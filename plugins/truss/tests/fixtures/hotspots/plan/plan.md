# Plan: three route kinds

Goal: add users, orders and billing routes to a small web service.

Four crews. Three of them each register their route in the one file `src/router.ts`, so that file is owned by three of the four crews.

The plan accepts serial merges on it. Stage 1 merges users-route, stage 2 merges orders-route and stage 3 merges billing-route, each one rebasing onto the router changes of the one before. The docs-pass crew runs in stage 1 beside users-route and touches only `docs/api.md`.

| Crew | Stage | Owns |
| --- | --- | --- |
| users-route | 1 | `src/router.ts`, `src/users/**` |
| orders-route | 2 | `src/router.ts`, `src/orders/**` |
| billing-route | 3 | `src/router.ts`, `src/billing/**` |
| docs-pass | 1 | `docs/api.md` |
