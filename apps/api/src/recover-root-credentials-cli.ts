import { runRootCredentialsRecoveryCli } from "./recover-root-credentials";

const exitCode = await runRootCredentialsRecoveryCli({
  args: process.argv.slice(2),
  environment: process.env,
  input: process.stdin,
  output: process.stdout
});

process.exitCode = exitCode;
