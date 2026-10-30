// Local read-only wrapper around an unchanged MIT-licensed upstream exec slice.
// This derived application component is not the official qloo CLI distribution.
import { runQlooExec } from "./vendor/qloo-exec/exec.js";
import { createAppExecutor } from "./qloo-runtime.mjs";
try {
  if (!["recommend", "rank", "--help", "-h"].includes(process.argv[2])) {
    process.stderr.write("Supported app workflows: recommend, rank.\n");
    process.exitCode = 2;
  } else {
    let executor;
    process.exitCode = await runQlooExec(process.argv.slice(2), {
      env: process.env,
      stdin: process.stdin,
      stdinIsTTY: process.stdin.isTTY === true,
      createExecutor: () => executor = createAppExecutor(process.env.QLOO_API_KEY, process.env.QLOO_BASE_URL,
        JSON.parse(process.env.COMMON_GROUND_ENTITY_SELECTIONS || "{}")),
      writeOut: (text) => {
        try {const result=JSON.parse(text); process.stdout.write(JSON.stringify({...result, diagnostics:executor?.readDiagnostics() ?? []})+"\n");}
        catch {process.stdout.write(text);}
      },
      writeError: (text) => process.stderr.write(text),
    });
  }
} catch {
  process.stderr.write("Qloo workflow could not complete.\n");
  process.exitCode = 1;
}
