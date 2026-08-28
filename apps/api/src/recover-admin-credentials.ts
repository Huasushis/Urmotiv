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
  recoverAdminCredentials
} from "@urmotiv/database";
import { hashPassword } from "@urmotiv/auth";

export const adminCredentialsRecoveryCliResults = Object.freeze({
  success: "RECOVER_ADMIN_CREDENTIALS_OK",
  usageError: "RECOVER_ADMIN_CREDENTIALS_USAGE_ERROR",
  ttyRequired: "RECOVER_ADMIN_CREDENTIALS_TTY_REQUIRED",
  postgresRequired: "RECOVER_ADMIN_CREDENTIALS_POSTGRES_REQUIRED",
  inputAborted: "RECOVER_ADMIN_CREDENTIALS_INPUT_ABORTED",
  inputMismatch: "RECOVER_ADMIN_CREDENTIALS_CONFIRMATION_REQUIRED",
  unavailable: "RECOVER_ADMIN_CREDENTIALS_UNAVAILABLE",
  outcomeUnknown: "OUTCOME_UNKNOWN"
});

export const adminCredentialsRecoveryCliExitCodes = Object.freeze({
  success: 0,
  usageError: 2,
  ttyRequired: 3,
  postgresRequired: 4,
  inputAborted: 5,
  inputMismatch: 6,
  unavailable: 8,
  outcomeUnknown: 9
});

export interface AdminCredentialsRecoverySecretWriter {
  writeCredentials(userId: string, password: string): void;
  close(): void;
}

interface AdminCredentialsRecoveryCliDependencies {
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
  readonly openSecretWriter: () => AdminCredentialsRecoverySecretWriter;
}

export interface RunAdminCredentialsRecoveryCliOptions {
  readonly args: readonly string[];
  readonly environment: AdminBootstrapEnvironment;
  readonly input: AdminBootstrapTtyInput;
  readonly output: AdminBootstrapTtyOutput;
  readonly dependencies?: Partial<AdminCredentialsRecoveryCliDependencies>;
}

/** Generates 256 bits of printable password entropy without using an account input. */
export function generateAdminCredentialsRecoveryPassword(): string {
  return randomBytes(32).toString("base64url");
}

const defaultDependencies: AdminCredentialsRecoveryCliDependencies = {
  createDatabase: (connectionString) =>
    createPostgresDatabase({
      connectionString,
      applicationName: "urmotiv-recover-admin-credentials",
      maxConnections: 1,
      idleTimeoutMs: 0
    }),
  readState: readAdminBootstrapState,
  collectConfirmations: collectAdminCredentialsRecoveryConfirmations,
  generatePassword: generateAdminCredentialsRecoveryPassword,
  hash: hashPassword,
  recover: recoverAdminCredentials,
  openSecretWriter: openAdminCredentialsRecoveryTty
};

export async function runAdminCredentialsRecoveryCli(
  options: RunAdminCredentialsRecoveryCliOptions
): Promise<number> {
  if (options.args.length !== 0) {
    return writeCliResult(
      options.output,
      adminCredentialsRecoveryCliResults.usageError,
      adminCredentialsRecoveryCliExitCodes.usageError
    );
  }
  if (!isRealTty(options.input, options.output)) {
    return writeCliResult(
      options.output,
      adminCredentialsRecoveryCliResults.ttyRequired,
      adminCredentialsRecoveryCliExitCodes.ttyRequired
    );
  }

  const connectionString = options.environment.DATABASE_URL?.trim() ?? "";
  if (connectionString.length === 0) {
    return writeCliResult(
      options.output,
      adminCredentialsRecoveryCliResults.postgresRequired,
      adminCredentialsRecoveryCliExitCodes.postgresRequired
    );
  }

  const dependencies = { ...defaultDependencies, ...options.dependencies };
  let database: DatabaseHandle | undefined;
  let secretWriter: AdminCredentialsRecoverySecretWriter | undefined;
  let result: { code: string; exitCode: number } = {
    code: adminCredentialsRecoveryCliResults.outcomeUnknown,
    exitCode: adminCredentialsRecoveryCliExitCodes.outcomeUnknown
  };

  try {
    database = dependencies.createDatabase(connectionString);
    const state = await dependencies.readState(database);
    if (state.status !== "completed") {
      result = {
        code: adminCredentialsRecoveryCliResults.unavailable,
        exitCode: adminCredentialsRecoveryCliExitCodes.unavailable
      };
    } else {
      await dependencies.collectConfirmations(options.input, options.output);
      secretWriter = dependencies.openSecretWriter();
      const password = dependencies.generatePassword();
      const passwordHash = await dependencies.hash(password);
      const completion = await dependencies.recover(database, { passwordHash });
      if (typeof completion === "object" && completion.status === "completed") {
        secretWriter.writeCredentials(completion.userId, password);
        result = {
          code: adminCredentialsRecoveryCliResults.success,
          exitCode: adminCredentialsRecoveryCliExitCodes.success
        };
      } else if (completion === "input_invalid") {
        result = {
          code: adminCredentialsRecoveryCliResults.unavailable,
          exitCode: adminCredentialsRecoveryCliExitCodes.unavailable
        };
      } else {
        result = {
          code: adminCredentialsRecoveryCliResults.unavailable,
          exitCode: adminCredentialsRecoveryCliExitCodes.unavailable
        };
      }
    }
  } catch (error) {
    if (error instanceof AdminBootstrapInputAbortedError) {
      result = {
        code: adminCredentialsRecoveryCliResults.inputAborted,
        exitCode: adminCredentialsRecoveryCliExitCodes.inputAborted
      };
    } else if (error instanceof AdminCredentialsRecoveryConfirmationError) {
      result = {
        code: adminCredentialsRecoveryCliResults.inputMismatch,
        exitCode: adminCredentialsRecoveryCliExitCodes.inputMismatch
      };
    }
  } finally {
    secretWriter?.close();
    if (database !== undefined) {
      await database.close().catch(() => undefined);
    }
  }

  return writeCliResult(options.output, result.code, result.exitCode);
}

export async function collectAdminCredentialsRecoveryConfirmations(
  input: AdminBootstrapTtyInput,
  output: AdminBootstrapTtyOutput
): Promise<void> {
  const first = await readHiddenTtyLine(
    input,
    output,
    "此操作将撤销管理员现有会话并重置密码。请输入“确认”继续："
  );
  if (first !== "确认") {
    throw new AdminCredentialsRecoveryConfirmationError();
  }
  const second = await readHiddenTtyLine(
    input,
    output,
    "请再次输入“确认”以执行一次性恢复："
  );
  if (second !== "确认") {
    throw new AdminCredentialsRecoveryConfirmationError();
  }
}

export class AdminCredentialsRecoveryConfirmationError extends Error {
  public constructor() {
    super(adminCredentialsRecoveryCliResults.inputMismatch);
  }
}

function openAdminCredentialsRecoveryTty(): AdminCredentialsRecoverySecretWriter {
  const descriptor = openSync("/dev/tty", constants.O_WRONLY | constants.O_NOCTTY);
  let closed = false;
  return {
    writeCredentials(userId, password) {
      if (closed) {
        throw new Error("RECOVER_ADMIN_CREDENTIALS_TTY_CLOSED");
      }
      const message = `管理员账号编号：${userId}\n新密码：${password}\n`;
      writeSync(descriptor, message, undefined, "utf8");
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
