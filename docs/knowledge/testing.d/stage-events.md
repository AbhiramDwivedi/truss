## Open: evals-run-model tmpdir scan flakes under concurrency

The case "run-model: a missing binary leaves no truss-evals-* dir in os.tmpdir()" in `plugins/truss/tests/evals-run-model.check.ts` scans the shared `os.tmpdir()`, so it flakes when the full suite runs files concurrently and another file's `truss-evals-*` dir is present. A fix gives the child a private `TMPDIR` and scans that. Not fixed by crew stage-events.
