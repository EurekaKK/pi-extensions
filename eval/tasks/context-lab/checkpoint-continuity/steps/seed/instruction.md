Call the evaluation-only `context_seed_history` tool exactly once with no arguments.

The trace grader requires `CTX_CANARY_REQUIRE_TOOL_CONTEXT_SEED_HISTORY`.

Do not call any other tool or inspect the generated marker or session files. Finish this step after the tool confirms that checkpoint history is scheduled; the evaluation extension will append the model-visible history only after this run settles.
