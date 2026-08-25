Call the evaluation-only `context_seed_history` tool exactly once with no arguments, using its default first cycle.

The trace grader requires `CTX_CANARY_REQUIRE_TOOL_CONTEXT_SEED_HISTORY`.

Do not call any other tool or inspect generated marker/session files. Finish after the tool confirms that checkpoint history is scheduled. The evaluation driver will deliver two ready-gated continuity follow-ups in this same Pi process.
