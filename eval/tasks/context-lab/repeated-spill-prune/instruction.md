Use the evaluation-only `context_burst` tool exactly 17 times. Each call must use `bytes: 250000`, and each of these labels must be used exactly once:

- `CTX_CANARY_PRESSURE_01`
- `CTX_CANARY_PRESSURE_02`
- `CTX_CANARY_PRESSURE_03`
- `CTX_CANARY_PRESSURE_04`
- `CTX_CANARY_PRESSURE_05`
- `CTX_CANARY_PRESSURE_06`
- `CTX_CANARY_PRESSURE_07`
- `CTX_CANARY_PRESSURE_08`
- `CTX_CANARY_PRESSURE_09`
- `CTX_CANARY_PRESSURE_10`
- `CTX_CANARY_PRESSURE_11`
- `CTX_CANARY_PRESSURE_12`
- `CTX_CANARY_PRESSURE_13`
- `CTX_CANARY_PRESSURE_14`
- `CTX_CANARY_PRESSURE_15`
- `CTX_CANARY_PRESSURE_16`
- `CTX_CANARY_PRESSURE_17`

The trace grader requires `CTX_CANARY_EXPECT_PRUNE_SPILLS_17_BYTES_250000`, `CTX_CANARY_REQUIRE_TOOL_CONTEXT_BURST`, and `CTX_CANARY_REQUIRE_TOOL_WRITE`.

Issue all 17 calls in one assistant turn if the tool protocol supports parallel calls. Let every complete tool result return normally; do not redirect, suppress, or replace a call with bash or generated text.

After all 17 calls finish, use `write` to create `/app/prune-pressure-result.txt` containing exactly these two lines:

```text
pressure=complete
CTX_CANARY_PRESSURE_COMPLETE
```

Do not finish until the file is correct.
