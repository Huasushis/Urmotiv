import {
  type AdminBootstrapTtyInput,
  adminBootstrapCliExitCodes,
  adminBootstrapCliResults,
  runAdminBootstrapCli,
} from "./bootstrap-admin";

try {
  process.exitCode = await runAdminBootstrapCli({
    args: process.argv.slice(2),
    environment: process.env,
    input: process.stdin as AdminBootstrapTtyInput,
    output: process.stdout,
  });
} catch {
  process.exitCode = adminBootstrapCliExitCodes.outcomeUnknown;
  process.stdout.write(`${adminBootstrapCliResults.outcomeUnknown}\n`);
}
