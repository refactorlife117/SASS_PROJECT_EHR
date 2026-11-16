---
description: Run the tester agent to write and run tests for an area
argument-hint: '[area or path]'
---

Use the **tester** subagent to write and run tests for: $ARGUMENTS

If no area was given, cover the current phase's required tests (see CLAUDE.md and docs/phases.md) plus anything changed. Report the pass/fail counts, any application bugs found (not fixed), and the required behaviors that are still uncovered.
