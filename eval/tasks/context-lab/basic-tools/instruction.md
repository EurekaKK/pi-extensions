Remember the exact token `CTX_CANARY_BASIC_ALPHA` while completing this task.

The trace grader requires these exact tool markers: `CTX_CANARY_REQUIRE_TOOL_WRITE`, `CTX_CANARY_REQUIRE_TOOL_READ`, `CTX_CANARY_REQUIRE_TOOL_EDIT`, and `CTX_CANARY_REQUIRE_TOOL_BASH`.

Exercise Pi's four built-in coding tools with a small, verifiable workflow:

1. Use `write` to create `/app/context-result.txt` containing `phase=initial`.
2. Use `read` to inspect that file.
3. Use `edit` to replace `phase=initial` with `phase=final` and add a second line containing the exact canary token.
4. Use `bash` to verify both lines.

Do not finish until the file is correct.
