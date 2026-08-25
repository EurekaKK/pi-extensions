Use the evaluation-only `context_burst` tool exactly once with:

The trace grader requires `CTX_CANARY_EXPECT_SPILL_BYTES_70000`, `CTX_CANARY_REQUIRE_TOOL_CONTEXT_BURST`, and `CTX_CANARY_REQUIRE_TOOL_WRITE`.

- `bytes`: `70000`
- `label`: `CTX_CANARY_LARGE_PAYLOAD`

Let the complete tool result return normally; do not redirect or suppress it. After the tool finishes, use `write` to create `/app/large-output-result.txt` containing exactly these two lines:

```text
burst=complete
CTX_CANARY_LARGE_PAYLOAD
```

Do not finish until the file is correct.
