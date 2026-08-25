The trace grader requires `CTX_CANARY_EXPECT_CHECKPOINT_CHUNKS_9_BYTES_100000` and `CTX_CANARY_REQUIRE_TOOL_WRITE`.

Without reading files, environment variables, source code, or external sources, recover two exact continuity tokens from the model-visible conversation state:

1. The persistent token from the earliest seeded checkpoint-history chunk.
2. The protected-tail token from the newest seeded checkpoint-history chunk.

Use `write` to create `/app/checkpoint-recalled.txt` with exactly this shape, substituting the two exact tokens:

```text
checkpoint=complete
persistent=<earliest exact continuity token>
tail=<newest exact continuity token>
```

Do not call any tool other than `write`, and finish only after the file is correct.
