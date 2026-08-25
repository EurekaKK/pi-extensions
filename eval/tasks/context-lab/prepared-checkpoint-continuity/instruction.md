Call the evaluation-only `context_seed_history` tool exactly once with no arguments.

The trace grader requires `CTX_CANARY_REQUIRE_TOOL_CONTEXT_SEED_HISTORY`.

Do not call any other tool or inspect generated marker/session files. Finish after the tool confirms that checkpoint history is scheduled. The evaluation driver will wait for the background candidate to become ready, then submit the continuity follow-up in this same Pi process.
