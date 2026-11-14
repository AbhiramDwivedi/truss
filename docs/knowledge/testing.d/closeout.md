## Open: R-96 inbox lock wait under CPU load

The load case in `plugins/truss/tests/hygiene-029.check.ts` ("inbox.check.ts passes 20 of 20 consecutive whole-file runs under artificial CPU load") runs only with `TRUSS_HYGIENE_LOAD_RUNS` set. With `TRUSS_HYGIENE_LOAD_RUNS=20` the inbox case "inbox: 8 concurrent escalates with one kind and ref leave one open op and 7 links" fails with `store busy: inbox` (exit 2), so the inbox lock wait is too short under CPU load. R-96 is still open; it is not fixed by 0.32.0.
