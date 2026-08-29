import { closeSync, constants, openSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  type AdminBootstrapEnvironment,
  AdminBootstrapInputAbortedError,
  type AdminBootstrapTtyInput,
  type AdminBootstrapTtyOutput,
  readHiddenTtyLine
} from "./bootstrap-admin";
import {
  type AdminBootstrapStateRecord,
  type AdminCredentialsRecoveryInput,
  type AdminCredentialsRecoveryResult,
  createPostgresDatabase,
  type DatabaseHandle,
  readAdminBootstrapState,
  recoverRootCredentials
} from "@urmotiv/database";
import { hashPassword } from "@urmotiv/auth";

export const rootCredentialsRecoveryCliResults = Object.freeze({
  success: "ROOT_CREDENTIALS_RECOVERY_OK",
  usageError: "ROOT_CREDENTIALS_RECOVERY_USAGE_ERROR",
  ttyRequired: "ROOT_CREDENTIALS_TTY_REQUIRED",
  postgresRequired: "ROOT_CREDENTIALS_POSTGRES_REQUIRED",
  inputAborted: "ROOT_CREDENTIALS_INPUT_ABORTED",
  inputMismatch: "ROOT_CREDENTIALS_CONFIRMATION_REQUIRED",
  secretWriteFailed: "ROOT_CREDENTIALS_SECRET_WRITE_FAILED",
  unavailable: "ROOT_CREDENTIALS_UNAVAILABLE",
  outcomeUnknown: "OUTCOME_UNKNOWN"
});

export const rootCredentialsRecoveryCliExitCodes = Object.freeze({
  success: 0,
  usageError: 2,
  ttyRequired: 3,
  postgresRequired: 4,
  inputAborted: 5,
  inputMismatch: 6,
  secretWriteFailed: 7,
  unavailable: 8,
  outcomeUnknown: 9
});

export interface RootCredentialsRecoverySecretWriter {
  writeCredentials(identifier: "root", password: string): void;
  close(): void;
}

export interface RootCredentialsRecoveryCliDependencies {
  readonly createDatabase: (connectionString: string) => DatabaseHandle;
  readonly readState: (database: DatabaseHandle) => Promise<AdminBootstrapStateRecord>;
  readonly collectConfirmations: (
    input: AdminBootstrapTtyInput,
    output: AdminBootstrapTtyOutput
  ) => Promise<void>;
  readonly generatePassword: () => string;
  readonly hash: (password: string) => Promise<string>;
  readonly recover: (
    database: DatabaseHandle,
    input: AdminCredentialsRecoveryInput
  ) => Promise<AdminCredentialsRecoveryResult>;
  readonly openSecretWriter: () => RootCredentialsRecoverySecretWriter;
}

export interface RunRootCredentialsRecoveryCliOptions {
  readonly args: readonly string[];
  readonly environment: AdminBootstrapEnvironment;
  readonly input: AdminBootstrapTtyInput;
  readonly output: AdminBootstrapTtyOutput;
  readonly dependencies?: Partial<RootCredentialsRecoveryCliDependencies>;
}

export function generateRootCredentialsRecoveryPassword(): string {
  return randomBytes(32).toString("base64url");
}

const defaultDependencies: RootCredentialsRecoveryCliDependencies = {
  createDatabase: (connectionString) =>
    createPostgresDatabase({
      connectionString,
      applicationName: "urmotiv-recover-root-credentials",
      maxConnections: 1,
      idleTimeoutMs: 0
    }),
  readState: readAdminBootstrapState,
  collectConfirmations: collectRootCredentialsRecoveryConfirmations,
  generatePassword: generateRootCredentialsRecoveryPassword,
  hash: hashPassword,
  recover: recoverRootCredentials,
  openSecretWriter: openRootCredentialsRecoveryTty
};

export async function runRootCredentialsRecoveryCli(
  options: RunRootCredentialsRecoveryCliOptions
): Promise<number> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  if (options.args.length !== 0) {
    return writeCliResult(
      options.output,
      rootCredentialsRecoveryCliResults.usageError,
      rootCredentialsRecoveryCliExitCodes.usageError
    );
  }
  if (!isRealTty(options.input, options.output)) {
    return writeCliResult(
      options.output,
      rootCredentialsRecoveryCliResults.ttyRequired,
      rootCredentialsRecoveryCliExitCodes.ttyRequired
    );
  }

  const connectionString = options.environment.DATABASE_URL?.trim() ?? "";
  if (connectionString.length === 0) {
    return writeCliResult(
      options.output,
      rootCredentialsRecoveryCliResults.postgresRequired,
      rootCredentialsRecoveryCliExitCodes.postgresRequired
    );
  }

  let database: DatabaseHandle | undefined;
  let result: { code: string; exitCode: number } = {
    code: rootCredentialsRecoveryCliResults.outcomeUnknown,
    exitCode: rootCredentialsRecoveryCliExitCodes.outcomeUnknown
  };
  try {
    database = dependencies.createDatabase(connectionString);
    const state = await dependencies.readState(database);
    if (state.status !== "completed") {
      result = {
        code: rootCredentialsRecoveryCliResults.unavailable,
        exitCode: rootCredentialsRecoveryCliExitCodes.unavailable
      };
    } else {
      await dependencies.collectConfirmations(options.input, options.output);
      const password = dependencies.generatePassword();
      const passwordHash = await dependencies.hash(password);
      let writer: RootCredentialsRecoverySecretWriter | undefined;
      try {
        writer = dependencies.openSecretWriter();
        writer.writeCredentials("root", password);
        writer.close();
        writer = undefined;
      } catch {
        try {
          writer?.close();
        } catch {
          // The safe result below must not expose a writer failure detail.
        }
        result = {
          code: rootCredentialsRecoveryCliResults.secretWriteFailed,
          exitCode: rootCredentialsRecoveryCliExitCodes.secretWriteFailed
        };
      }
      if (result.code === rootCredentialsRecoveryCliResults.outcomeUnknown) {
        const completion = await dependencies.recover(database, { passwordHash });
        result = completion !== "input_invalid" &&
          completion !== "not_completed" &&
          completion !== "busy" &&
          completion !== "candidate_invalid" &&
          completion.status === "completed"
          ? {
              code: rootCredentialsRecoveryCliResults.success,
              exitCode: rootCredentialsRecoveryCliExitCodes.success
            }
          : {
              code: rootCredentialsRecoveryCliResults.unavailable,
              exitCode: rootCredentialsRecoveryCliExitCodes.unavailable
            };
      }
    }
  } catch (error) {
    if (error instanceof AdminBootstrapInputAbortedError) {
      result = {
        code: rootCredentialsRecoveryCliResults.inputAborted,
        exitCode: rootCredentialsRecoveryCliExitCodes.inputAborted
      };
    } else if (error instanceof RootCredentialsRecoveryConfirmationError) {
      result = {
        code: rootCredentialsRecoveryCliResults.inputMismatch,
        exitCode: rootCredentialsRecoveryCliExitCodes.inputMismatch
      };
    } else {
      result = {
        code: rootCredentialsRecoveryCliResults.unavailable,
        exitCode: rootCredentialsRecoveryCliExitCodes.unavailable
      };
    }
  } finally {
    if (database !== undefined) {
      await database.close().catch(() => undefined);
    }
  }
  return writeCliResult(options.output, result.code, result.exitCode);
}

export async function collectRootCredentialsRecoveryConfirmations(
  input: AdminBootstrapTtyInput,
  output: AdminBootstrapTtyOutput
): Promise<void> {
  const first = await readHiddenTtyLine(
    input,
    output,
    "此操作只恢复固定 root 账号、撤销其现有会话并重置本地密码。请输入“确认”继续："
  );
  if (first !== "确认") throw new RootCredentialsRecoveryConfirmationError();
  const second = await readHiddenTtyLine(
    input,
    output,
    "请再次输入“确认”以执行一次性 root 恢复："
  );
  if (second !== "确认") throw new RootCredentialsRecoveryConfirmationError();
}

export class RootCredentialsRecoveryConfirmationError extends Error {
  public constructor() {
    super(rootCredentialsRecoveryCliResults.inputMismatch);
  }
}

function openRootCredentialsRecoveryTty(): RootCredentialsRecoverySecretWriter {
  const descriptor = openSync("/dev/tty", constants.O_WRONLY | constants.O_NOCTTY);
  let closed = false;
  return {
    writeCredentials(_identifier, password) {
      if (closed) throw new Error("ROOT_CREDENTIALS_RECOVERY_TTY_CLOSED");
      writeSync(descriptor, `root账号：root\n新密码：${password}\n`, undefined, "utf8");
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(descriptor);
      }
    }
  };
}

function isRealTty(input: AdminBootstrapTtyInput, output: AdminBootstrapTtyOutput): boolean {
  return input.isTTY === true && output.isTTY === true && typeof input.setRawMode === "function";
}

function writeCliResult(output: AdminBootstrapTtyOutput, code: string, exitCode: number): number {
  output.write(`${code}\n`);
  return exitCode;
}
