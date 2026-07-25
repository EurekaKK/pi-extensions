import { runGuardianProcess } from "./guardian-runtime.js";
try {
    process.exit(await runGuardianProcess());
}
catch {
    if (process.connected)
        process.disconnect();
    process.exit(1);
}
