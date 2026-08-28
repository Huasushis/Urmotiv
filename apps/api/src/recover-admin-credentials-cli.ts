import {
  adminCredentialsRecoveryCliExitCodes,
  adminCredentialsRecoveryCliResults,
  runAdminCredentialsRecoveryCli
} from "./recover-admin-credentials";
import type { AdminBootstrapTtyInput } from "./bootstrap-admin";

try {
  process.exitCode = await runAdminCredentialsRecoveryCli({
    args: process.argv.slice(2),
    environment: process.env,
    input: process.stdin as AdminBootstrapTtyInput,
    output: process.stdout
  });
} catch {
  process.exitCode = adminCredentialsRecoveryCliExitCodes.outcomeUnknown;
  process.stdout.write(`${adminCredentialsRecoveryCliResults.outcomeUnknown}\n`);
}
