"""retro's per-run "refusals" counts, from the hooks' refusal lines (P24: counts only, never a body).
Everything is built in a tempdir; names are invented.
Run: python -m unittest discover -s tests
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "scripts", "retro.py"))
NR = "not recorded"
DECISIONS = ("# Decisions\n## Run 2026-10-27T09:00:00Z | first\n- 09:05 | a | b | checker: none | followed\n"
             "## Run 2026-10-28T09:00:00Z | second\n- 09:05 | a | b | checker: none | followed\n")
SPAWN = ('{"v":1,"ts":"2026-10-27T09:01:00.000Z","event":"spawn","crew":"c","agent":"c","agentId":"e0",'
         '"type":"x","model":"opus","effort":"high","by":"main"}\n')


def refusal(ts, source="worktree-guard", tool="Bash", category="is too complex to verify that it stays inside the worktree",
            program="cat", shape=("heredoc",)):
    ev = {"v": 1, "ts": ts, "event": "refusal", "crew": "c", "agent": "c-builder", "tool": tool, "source": source,
          "category": category, "program": program, "shape": list(shape)}
    return json.dumps(ev) + "\n"


class RetroRefusals(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="retrorefusals-")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def runs(self, events):
        sess = os.path.join(self.tmp, "s")
        os.makedirs(sess, exist_ok=True)
        with open(os.path.join(sess, "decisions.md"), "w", encoding="utf-8") as f:
            f.write(DECISIONS)
        with open(os.path.join(sess, "events.jsonl"), "w", encoding="utf-8") as f:
            f.write(events)
        r = subprocess.run([sys.executable, "-I", SCRIPT, sess], capture_output=True, text=True,
                           encoding="utf-8", timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)["runs"]

    def test_counts_by_source_tool_category_program_and_shape_per_run(self):
        a, b = self.runs(SPAWN
                         + refusal("2026-10-27T10:00:00.000Z")
                         + refusal("2026-10-27T10:01:00.000Z", shape=("heredoc", "compound"), program="mkdir")
                         + refusal("2026-10-27T10:02:00.000Z", source="classifier", tool="Write", category="no verdict",
                                   program=None, shape=())
                         + refusal("2026-10-28T10:00:00.000Z", source="truss", tool="Workflow",
                                   category="truss agents run in a Workflow only from the plugin's plan.js and stage.js",
                                   program=None, shape=()))
        self.assertEqual(a["refusals"], {
            "total": 3,
            "bySource": {"worktree-guard": 2, "classifier": 1},
            "byTool": {"Bash": 2, "Write": 1},
            "byCategory": {"worktree-guard: is too complex to verify that it stays inside the worktree": 2,
                           "classifier: no verdict": 1},
            "byProgram": {"cat": 1, "mkdir": 1},
            "byShape": {"heredoc": 2, "compound": 1},
        })
        self.assertEqual(b["refusals"]["total"], 1)
        self.assertEqual(b["refusals"]["bySource"], {"truss": 1})
        self.assertEqual(b["refusals"]["byProgram"], {})

    def test_no_refusal_line_is_not_recorded_never_zero(self):
        for run in self.runs(SPAWN):
            self.assertEqual(run["refusals"], NR)

    def test_a_run_with_none_beside_one_with_some_is_zero(self):
        a, b = self.runs(SPAWN + refusal("2026-10-28T10:00:00.000Z"))
        self.assertEqual(a["refusals"]["total"], 0)
        self.assertEqual(b["refusals"]["total"], 1)

    def test_odd_fields_count_as_unset_and_never_break_the_count(self):
        bad = {"v": 1, "ts": "2026-10-27T10:00:00.000Z", "event": "refusal", "crew": "c", "agent": "x",
               "tool": "Bash", "source": 7, "program": "", "shape": "heredoc"}
        a, _ = self.runs(SPAWN + json.dumps(bad) + "\n")
        self.assertEqual(a["refusals"]["bySource"], {"unset": 1})
        self.assertEqual(a["refusals"]["byCategory"], {"unset: unset": 1})
        self.assertEqual(a["refusals"]["byProgram"], {"unset": 1})
        self.assertEqual(a["refusals"]["byShape"], {})

    def test_no_text_beyond_the_line_fields_is_printed(self):
        line = json.loads(refusal("2026-10-27T10:00:00.000Z"))
        line["command"] = "cat > x <<'EOF' TOPSECRET"
        sess_runs = self.runs(SPAWN + json.dumps(line) + "\n")
        self.assertNotIn("TOPSECRET", json.dumps(sess_runs))


if __name__ == "__main__":
    unittest.main()
