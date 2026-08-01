import { StringDecoder } from "node:string_decoder";
import { hashPassword, newPasswordSchema, normalizeEmail } from "@urmotiv/auth";
import {
  type AdminBootstrapAdministratorInput,
  type AdminBootstrapCompletionResult,
  type AdminBootstrapStateRecord,
  completeAdminBootstrap,
  createPostgresDatabase,
  type DatabaseHandle,
  readAdminBootstrapState,
} from "@urmotiv/database";

export const adminBootstrapStartupErrors = Object.freeze({
  required: "URMOTIV_ADMIN_BOOTSTRAP_REQUIRED",
  invalid: "URMOTIV_ADMIN_BOOTSTRAP_STATE_INVALID",
});

export const adminBootstrapCliResults = Object.freeze({
  success: "BOOTSTRAP_ADMIN_OK",
  usageError: "BOOTSTRAP_ADMIN_USAGE_ERROR",
  ttyRequired: "BOOTSTRAP_ADMIN_TTY_REQUIRED",
  postgresRequired: "BOOTSTRAP_ADMIN_POSTGRES_REQUIRED",
  inputAborted: "BOOTSTRAP_ADMIN_INPUT_ABORTED",
  inputMismatch: "BOOTSTRAP_ADMIN_INPUT_MISMATCH",
  inputInvalid: "BOOTSTRAP_ADMIN_INPUT_INVALID",
  unavailable: "BOOTSTRAP_ADMIN_UNAVAILABLE",
  outcomeUnknown: "OUTCOME_UNKNOWN",
});

export const adminBootstrapCliExitCodes = Object.freeze({
  success: 0,
  usageError: 2,
  ttyRequired: 3,
  postgresRequired: 4,
  inputAborted: 5,
  inputMismatch: 6,
  inputInvalid: 7,
  unavailable: 8,
  outcomeUnknown: 9,
});

export interface AdminBootstrapEnvironment {
  readonly DATABASE_URL?: string;
  readonly [name: string]: string | undefined;
}

export interface AdminBootstrapTtyInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode(enabled: boolean): this;
  on(event: "data", listener: (chunk: unknown) => void): this;
  once(event: "end", listener: () => void): this;
  once(event: "error", listener: () => void): this;
  removeListener(event: "data", listener: (chunk: unknown) => void): this;
  removeListener(event: "end", listener: () => void): this;
  removeListener(event: "error", listener: () => void): this;
  resume(): this;
  pause(): this;
}

export interface AdminBootstrapTtyOutput {
  readonly isTTY?: boolean;
  write(value: string): unknown;
}

export interface AdminBootstrapCredentials {
  readonly email: string;
  readonly emailConfirmation: string;
  readonly password: string;
  readonly passwordConfirmation: string;
}

interface AdminBootstrapCliDependencies {
  readonly createDatabase: (connectionString: string) => DatabaseHandle;
  readonly readState: (database: DatabaseHandle) => Promise<AdminBootstrapStateRecord>;
  readonly collectCredentials: (
    input: AdminBootstrapTtyInput,
    output: AdminBootstrapTtyOutput,
  ) => Promise<AdminBootstrapCredentials>;
  readonly hash: (password: string) => Promise<string>;
  readonly complete: (
    database: DatabaseHandle,
    input: AdminBootstrapAdministratorInput,
  ) => Promise<AdminBootstrapCompletionResult>;
}

export interface RunAdminBootstrapCliOptions {
  readonly args: readonly string[];
  readonly environment: AdminBootstrapEnvironment;
  readonly input: AdminBootstrapTtyInput;
  readonly output: AdminBootstrapTtyOutput;
  readonly dependencies?: Partial<AdminBootstrapCliDependencies>;
}

const defaultDependencies: AdminBootstrapCliDependencies = {
  createDatabase: (connectionString) =>
    createPostgresDatabase({
      connectionString,
      applicationName: "urmotiv-bootstrap-admin",
      maxConnections: 1,
      idleTimeoutMs: 0,
    }),
  readState: readAdminBootstrapState,
  collectCredentials: collectAdminBootstrapCredentials,
  hash: hashPassword,
  complete: completeAdminBootstrap,
};

export async function assertAdminBootstrapReadyForServer(database: DatabaseHandle): Promise<void> {
  let state: AdminBootstrapStateRecord;
  try {
    state = await readAdminBootstrapState(database);
  } catch {
    throw new Error(adminBootstrapStartupErrors.invalid);
  }
  if (state.status === "open") {
    throw new Error(adminBootstrapStartupErrors.required);
  }
  if (state.status !== "blocked" && state.status !== "completed") {
    throw new Error(adminBootstrapStartupErrors.invalid);
  }
}

export async function runAdminBootstrapCli(options: RunAdminBootstrapCliOptions): Promise<number> {
  if (options.args.length !== 0) {
    return writeCliResult(
      options.output,
      adminBootstrapCliResults.usageError,
      adminBootstrapCliExitCodes.usageError,
    );
  }
  if (!isRealTty(options.input, options.output)) {
    return writeCliResult(
      options.output,
      adminBootstrapCliResults.ttyRequired,
      adminBootstrapCliExitCodes.ttyRequired,
    );
  }

  const connectionString = options.environment.DATABASE_URL?.trim() ?? "";
  if (connectionString.length === 0) {
    return writeCliResult(
      options.output,
      adminBootstrapCliResults.postgresRequired,
      adminBootstrapCliExitCodes.postgresRequired,
    );
  }

  const dependencies = { ...defaultDependencies, ...options.dependencies };
  let database: DatabaseHandle | undefined;
  let result: { code: string; exitCode: number } = {
    code: adminBootstrapCliResults.outcomeUnknown,
    exitCode: adminBootstrapCliExitCodes.outcomeUnknown,
  };

  try {
    database = dependencies.createDatabase(connectionString);
    const state = await dependencies.readState(database);
    if (state.status !== "open") {
      result = {
        code: adminBootstrapCliResults.unavailable,
        exitCode: adminBootstrapCliExitCodes.unavailable,
      };
    } else {
      const credentials = await dependencies.collectCredentials(options.input, options.output);
      result = await initializeAdministrator(database, credentials, dependencies);
    }
  } catch (error) {
    if (error instanceof AdminBootstrapInputAbortedError) {
      result = {
        code: adminBootstrapCliResults.inputAborted,
        exitCode: adminBootstrapCliExitCodes.inputAborted,
      };
    }
  } finally {
    if (database !== undefined) {
      await database.close().catch(() => undefined);
    }
  }

  return writeCliResult(options.output, result.code, result.exitCode);
}

export async function collectAdminBootstrapCredentials(
  input: AdminBootstrapTtyInput,
  output: AdminBootstrapTtyOutput,
): Promise<AdminBootstrapCredentials> {
  if (!isRealTty(input, output)) {
    throw new AdminBootstrapInputAbortedError();
  }

  const email = await readHiddenTtyLine(input, output, "请输入首位管理员邮箱（不回显）：");
  const emailConfirmation = await readHiddenTtyLine(input, output, "请再次输入邮箱（不回显）：");
  const password = await readHiddenTtyLine(input, output, "请输入首位管理员密码（不回显）：");
  const passwordConfirmation = await readHiddenTtyLine(input, output, "请再次输入密码（不回显）：");
  return { email, emailConfirmation, password, passwordConfirmation };
}

export async function readHiddenTtyLine(
  input: AdminBootstrapTtyInput,
  output: AdminBootstrapTtyOutput,
  prompt = "",
): Promise<string> {
  if (!isRealTty(input, output)) {
    throw new AdminBootstrapInputAbortedError();
  }

  return new Promise<string>((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    const wasRaw = input.isRaw === true;
    let value = "";
    let escapeState: 0 | 1 | 2 = 0;
    let settled = false;

    const restore = (): void => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      try {
        input.setRawMode(wasRaw);
      } catch {
        // The fixed command result handles terminal failures without exposing details.
      }
      input.pause();
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      restore();
      try {
        output.write("\n");
      } catch {
        // The caller reports only a fixed result if its output stream is unavailable.
      }
      resolve(value);
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      restore();
      try {
        output.write("\n");
      } catch {
        // The caller reports only a fixed result if its output stream is unavailable.
      }
      reject(new AdminBootstrapInputAbortedError());
    };
    const onData = (chunk: unknown): void => {
      const bytes =
        typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
      for (const character of decoder.write(bytes)) {
        if (escapeState === 1) {
          escapeState = character === "[" || character === "O" ? 2 : 0;
          continue;
        }
        if (escapeState === 2) {
          if (character >= "@" && character <= "~") {
            escapeState = 0;
          }
          continue;
        }
        if (character === "\u001b") {
          escapeState = 1;
          continue;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003" || character === "\u0004") {
          abort();
          return;
        }
        if (character === "\b" || character === "\u007f") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (character >= " " && value.length <= 1_024) {
          value += character;
        }
      }
    };
    const onEnd = (): void => abort();
    const onError = (): void => abort();
    const onSignal = (): void => abort();

    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      input.setRawMode(true);
      input.resume();
      output.write(prompt);
    } catch {
      abort();
    }
  });
}

export class AdminBootstrapInputAbortedError extends Error {
  public constructor() {
    super(adminBootstrapCliResults.inputAborted);
  }
}

async function initializeAdministrator(
  database: DatabaseHandle,
  credentials: AdminBootstrapCredentials,
  dependencies: AdminBootstrapCliDependencies,
): Promise<{ code: string; exitCode: number }> {
  let normalizedEmail: string;
  let normalizedConfirmation: string;
  try {
    normalizedEmail = normalizeEmail(credentials.email);
    normalizedConfirmation = normalizeEmail(credentials.emailConfirmation);
  } catch {
    return {
      code: adminBootstrapCliResults.inputInvalid,
      exitCode: adminBootstrapCliExitCodes.inputInvalid,
    };
  }
  if (
    normalizedEmail !== normalizedConfirmation ||
    credentials.password !== credentials.passwordConfirmation
  ) {
    return {
      code: adminBootstrapCliResults.inputMismatch,
      exitCode: adminBootstrapCliExitCodes.inputMismatch,
    };
  }
  if (!newPasswordSchema.safeParse(credentials.password).success) {
    return {
      code: adminBootstrapCliResults.inputInvalid,
      exitCode: adminBootstrapCliExitCodes.inputInvalid,
    };
  }

  const passwordHash = await dependencies.hash(credentials.password);
  const completion = await dependencies.complete(database, {
    normalizedEmail,
    passwordHash,
  });
  if (completion !== "completed") {
    return {
      code: adminBootstrapCliResults.unavailable,
      exitCode: adminBootstrapCliExitCodes.unavailable,
    };
  }
  return {
    code: adminBootstrapCliResults.success,
    exitCode: adminBootstrapCliExitCodes.success,
  };
}

function isRealTty(input: AdminBootstrapTtyInput, output: AdminBootstrapTtyOutput): boolean {
  return input.isTTY === true && output.isTTY === true && typeof input.setRawMode === "function";
}

function writeCliResult(output: AdminBootstrapTtyOutput, code: string, exitCode: number): number {
  output.write(`${code}\n`);
  return exitCode;
}
