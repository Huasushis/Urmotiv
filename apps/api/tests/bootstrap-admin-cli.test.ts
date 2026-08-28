import { EventEmitter } from "node:events";
import type { DatabaseHandle } from "@urmotiv/database";
import { describe, expect, it, vi } from "vitest";
import {
  type AdminBootstrapCredentials,
  AdminBootstrapInputAbortedError,
  type AdminBootstrapTtyOutput,
  adminBootstrapCliExitCodes,
  adminBootstrapCliResults,
  collectAdminBootstrapCredentials,
  readHiddenTtyLine,
  runAdminBootstrapCli
} from "../src/bootstrap-admin";
import {
  adminCredentialsRecoveryCliExitCodes,
  adminCredentialsRecoveryCliResults,
  generateAdminCredentialsRecoveryPassword,
  runAdminCredentialsRecoveryCli
} from "../src/recover-admin-credentials";

const syntheticPassword = "synthetic-long-password";
const syntheticHash = "$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGljc2FsdA$c3ludGhldGljaGFzaA";
const credentials: AdminBootstrapCredentials = Object.freeze({
  email: "Administrator@Example.test",
  emailConfirmation: "administrator@example.test",
  password: syntheticPassword,
  passwordConfirmation: syntheticPassword,
});

describe("bootstrap administrator CLI", () => {
  it("creates one administrator from TTY input and prints only a fixed success code", async () => {
    const database = createFakeDatabase();
    const output = new FakeTtyOutput();
    const createDatabase = vi.fn(() => database.handle);
    const collectCredentials = vi.fn(async () => credentials);
    const hash = vi.fn(async () => syntheticHash);
    const complete = vi.fn(async () => "completed" as const);

    await expect(
      runAdminBootstrapCli({
        args: [],
        environment: {
          DATABASE_URL: "postgres://synthetic.invalid/urmotiv",
          URMOTIV_BOOTSTRAP_EMAIL: "must-not-be-read@example.invalid",
          URMOTIV_BOOTSTRAP_PASSWORD: "must-not-be-read",
        },
        input: new FakeTtyInput(),
        output,
        dependencies: {
          createDatabase,
          readState: async () => ({
            status: "open",
            openedAt: new Date(0).toISOString(),
            completedAt: null,
          }),
          collectCredentials,
          hash,
          complete,
        },
      }),
    ).resolves.toBe(adminBootstrapCliExitCodes.success);

    expect(createDatabase).toHaveBeenCalledTimes(1);
    expect(collectCredentials).toHaveBeenCalledTimes(1);
    expect(hash).toHaveBeenCalledWith(syntheticPassword);
    expect(complete).toHaveBeenCalledWith(database.handle, {
      normalizedEmail: "administrator@example.test",
      passwordHash: syntheticHash,
    });
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(output.text).toBe(`${adminBootstrapCliResults.success}\n`);
    expect(output.text).not.toContain(credentials.email);
    expect(output.text).not.toContain(syntheticPassword);
    expect(output.text).not.toContain(syntheticHash);
    expect(output.text).not.toContain("synthetic.invalid");
  });

  it("rejects arguments, non-TTY input or output, and missing PostgreSQL configuration before connecting", async () => {
    const cases = [
      {
        args: ["--email", "hidden@example.invalid"],
        input: new FakeTtyInput(),
        environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
        code: adminBootstrapCliResults.usageError,
        exitCode: adminBootstrapCliExitCodes.usageError,
      },
      {
        args: [],
        input: new FakeTtyInput(false),
        environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
        code: adminBootstrapCliResults.ttyRequired,
        exitCode: adminBootstrapCliExitCodes.ttyRequired,
      },
      {
        args: [],
        input: new FakeTtyInput(),
        environment: { URMOTIV_PGLITE_PATH: ".data/forbidden" },
        code: adminBootstrapCliResults.postgresRequired,
        exitCode: adminBootstrapCliExitCodes.postgresRequired,
      },
    ] as const;

    for (const item of cases) {
      const output = new FakeTtyOutput();
      const createDatabase = vi.fn(() => createFakeDatabase().handle);
      await expect(
        runAdminBootstrapCli({
          args: item.args,
          environment: item.environment,
          input: item.input,
          output,
          dependencies: { createDatabase },
        }),
      ).resolves.toBe(item.exitCode);
      expect(output.text).toBe(`${item.code}\n`);
      expect(output.text).not.toContain("hidden@example.invalid");
      expect(createDatabase).not.toHaveBeenCalled();
    }

    const output = new FakeTtyOutput(undefined, false);
    const createDatabase = vi.fn(() => createFakeDatabase().handle);
    await expect(
      runAdminBootstrapCli({
        args: [],
        environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
        input: new FakeTtyInput(),
        output,
        dependencies: { createDatabase },
      }),
    ).resolves.toBe(adminBootstrapCliExitCodes.ttyRequired);
    expect(output.text).toBe(`${adminBootstrapCliResults.ttyRequired}\n`);
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("does not prompt when the marker is blocked or completed and always closes the connection", async () => {
    for (const status of ["blocked", "completed"] as const) {
      const database = createFakeDatabase();
      const output = new FakeTtyOutput();
      const collectCredentials = vi.fn(async () => credentials);
      await expect(
        runAdminBootstrapCli({
          args: [],
          environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
          input: new FakeTtyInput(),
          output,
          dependencies: {
            createDatabase: () => database.handle,
            readState: async () => ({ status, openedAt: null, completedAt: null }),
            collectCredentials,
          },
        }),
      ).resolves.toBe(adminBootstrapCliExitCodes.unavailable);
      expect(collectCredentials).not.toHaveBeenCalled();
      expect(database.close).toHaveBeenCalledTimes(1);
      expect(output.text).toBe(`${adminBootstrapCliResults.unavailable}\n`);
    }
  });

  it("returns fixed mismatch and invalid-input results without hashing or writing", async () => {
    const cases: Array<{
      supplied: AdminBootstrapCredentials;
      result: string;
      exitCode: number;
    }> = [
      {
        supplied: { ...credentials, emailConfirmation: "different@example.test" },
        result: adminBootstrapCliResults.inputMismatch,
        exitCode: adminBootstrapCliExitCodes.inputMismatch,
      },
      {
        supplied: { ...credentials, passwordConfirmation: "different-long-password" },
        result: adminBootstrapCliResults.inputMismatch,
        exitCode: adminBootstrapCliExitCodes.inputMismatch,
      },
      {
        supplied: { ...credentials, email: "not-an-email", emailConfirmation: "not-an-email" },
        result: adminBootstrapCliResults.inputInvalid,
        exitCode: adminBootstrapCliExitCodes.inputInvalid,
      },
      {
        supplied: { ...credentials, password: "short", passwordConfirmation: "short" },
        result: adminBootstrapCliResults.inputInvalid,
        exitCode: adminBootstrapCliExitCodes.inputInvalid,
      },
    ];

    for (const item of cases) {
      const database = createFakeDatabase();
      const output = new FakeTtyOutput();
      const hash = vi.fn(async () => syntheticHash);
      const complete = vi.fn(async () => "completed" as const);
      await expect(
        runAdminBootstrapCli({
          args: [],
          environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
          input: new FakeTtyInput(),
          output,
          dependencies: {
            createDatabase: () => database.handle,
            readState: async () => ({
              status: "open",
              openedAt: new Date(0).toISOString(),
              completedAt: null,
            }),
            collectCredentials: async () => item.supplied,
            hash,
            complete,
          },
        }),
      ).resolves.toBe(item.exitCode);
      expect(hash).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(database.close).toHaveBeenCalledTimes(1);
      expect(output.text).toBe(`${item.result}\n`);
    }
  });

  it("maps aborts and every database uncertainty to fixed results without retrying", async () => {
    const abortDatabase = createFakeDatabase();
    const abortOutput = new FakeTtyOutput();
    await expect(
      runAdminBootstrapCli({
        args: [],
        environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
        input: new FakeTtyInput(),
        output: abortOutput,
        dependencies: {
          createDatabase: () => abortDatabase.handle,
          readState: async () => ({
            status: "open",
            openedAt: new Date(0).toISOString(),
            completedAt: null,
          }),
          collectCredentials: async () => {
            throw new AdminBootstrapInputAbortedError();
          },
        },
      }),
    ).resolves.toBe(adminBootstrapCliExitCodes.inputAborted);
    expect(abortDatabase.close).toHaveBeenCalledTimes(1);
    expect(abortOutput.text).toBe(`${adminBootstrapCliResults.inputAborted}\n`);

    for (const phase of ["connect", "read", "complete"] as const) {
      const database = createFakeDatabase();
      const output = new FakeTtyOutput();
      const complete = vi.fn(async () => {
        throw new Error(`private ${phase} detail`);
      });
      const createDatabase = vi.fn(() => {
        if (phase === "connect") throw new Error("private connection detail");
        return database.handle;
      });
      const readState = vi.fn(async () => {
        if (phase === "read") throw new Error("private database detail");
        return { status: "open" as const, openedAt: new Date(0).toISOString(), completedAt: null };
      });

      await expect(
        runAdminBootstrapCli({
          args: [],
          environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
          input: new FakeTtyInput(),
          output,
          dependencies: {
            createDatabase,
            readState,
            collectCredentials: async () => credentials,
            hash: async () => syntheticHash,
            complete,
          },
        }),
      ).resolves.toBe(adminBootstrapCliExitCodes.outcomeUnknown);
      expect(complete).toHaveBeenCalledTimes(phase === "complete" ? 1 : 0);
      expect(database.close).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
      expect(output.text).toBe(`${adminBootstrapCliResults.outcomeUnknown}\n`);
      expect(output.text).not.toContain("private");
    }
  });

  it("maps a changed final precondition to a fixed unavailable result", async () => {
    const database = createFakeDatabase();
    const output = new FakeTtyOutput();
    await expect(
      runAdminBootstrapCli({
        args: [],
        environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
        input: new FakeTtyInput(),
        output,
        dependencies: {
          createDatabase: () => database.handle,
          readState: async () => ({
            status: "open",
            openedAt: new Date(0).toISOString(),
            completedAt: null,
          }),
          collectCredentials: async () => credentials,
          hash: async () => syntheticHash,
          complete: async () => "baseline_mismatch",
        },
      }),
    ).resolves.toBe(adminBootstrapCliExitCodes.unavailable);
    expect(output.text).toBe(`${adminBootstrapCliResults.unavailable}\n`);
    expect(database.close).toHaveBeenCalledTimes(1);
  });
});

describe("administrator credential recovery CLI", () => {
  it("requires two confirmations, hashes a generated password, and writes credentials only to the secret TTY", async () => {
    const database = createFakeDatabase();
    const output = new FakeTtyOutput();
    const password = "synthetic-recovery-password";
    const secretWriter = {
      calls: [] as Array<{ accountIdentifier: string; password: string }>,
      writeCredentials(accountIdentifier: string, value: string): void {
        this.calls.push({ accountIdentifier, password: value });
      },
      close: vi.fn()
    };
    const hash = vi.fn(async (value: string) => {
      expect(value).toBe(password);
      return syntheticHash;
    });
    const recover = vi.fn(async () => ({
      status: "completed",
      userId: "42",
      accountIdentifier: "administrator@example.test"
    }) as const);

    await expect(
      runAdminCredentialsRecoveryCli({
        args: [],
        environment: {
          DATABASE_URL: "postgres://synthetic.invalid/urmotiv",
          RECOVERY_PASSWORD: "must-not-be-read"
        },
        input: new FakeTtyInput(true, ["确认", "确认"]),
        output,
        dependencies: {
          createDatabase: () => database.handle,
          readState: async () => ({
            status: "completed",
            openedAt: new Date(0).toISOString(),
            completedAt: new Date(1).toISOString()
          }),
          generatePassword: () => password,
          hash,
          recover,
          openSecretWriter: () => secretWriter
        }
      })
    ).resolves.toBe(adminCredentialsRecoveryCliExitCodes.success);

    expect(hash).toHaveBeenCalledWith(password);
    expect(recover).toHaveBeenCalledWith(database.handle, { passwordHash: syntheticHash });
    expect(secretWriter.calls).toEqual([
      { accountIdentifier: "administrator@example.test", password }
    ]);
    expect(secretWriter.close).toHaveBeenCalledTimes(1);
    expect(output.text).toBe(
      `此操作将撤销管理员现有会话并重置密码。请输入“确认”继续：\n请再次输入“确认”以执行一次性恢复：\n${adminCredentialsRecoveryCliResults.success}\n`
    );
    expect(output.text).not.toContain(password);
    expect(output.text).not.toContain("42");
    expect(output.text).not.toContain("administrator@example.test");
    expect(output.text).not.toContain(syntheticHash);
  });

  it("rejects arguments, non-TTY calls, incomplete bootstrap, and a missing confirmation before hashing", async () => {
    const cases = [
      {
        args: ["--email", "must-not-be-read@example.invalid"],
        input: new FakeTtyInput(),
        state: "completed" as const,
        result: adminCredentialsRecoveryCliResults.usageError,
        exitCode: adminCredentialsRecoveryCliExitCodes.usageError
      },
      {
        args: [],
        input: new FakeTtyInput(false),
        state: "completed" as const,
        result: adminCredentialsRecoveryCliResults.ttyRequired,
        exitCode: adminCredentialsRecoveryCliExitCodes.ttyRequired
      },
      {
        args: [],
        input: new FakeTtyInput(),
        state: "blocked" as const,
        result: adminCredentialsRecoveryCliResults.unavailable,
        exitCode: adminCredentialsRecoveryCliExitCodes.unavailable
      }
    ];
    for (const item of cases) {
      const output = new FakeTtyOutput();
      const createDatabase = vi.fn(() => createFakeDatabase().handle);
      const hash = vi.fn(async () => syntheticHash);
      await expect(
        runAdminCredentialsRecoveryCli({
          args: item.args,
          environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
          input: item.input,
          output,
          dependencies: {
            createDatabase,
            readState: async () => ({
              status: item.state,
              openedAt: null,
              completedAt: null
            }),
            hash
          }
        })
      ).resolves.toBe(item.exitCode);
      expect(output.text).toBe(`${item.result}\n`);
      expect(hash).not.toHaveBeenCalled();
      if (item.args.length !== 0 || item.input.isTTY !== true) {
        expect(createDatabase).not.toHaveBeenCalled();
      }
    }

    const database = createFakeDatabase();
    const output = new FakeTtyOutput();
    const hash = vi.fn(async () => syntheticHash);
    const recover = vi.fn(async () => ({
      status: "completed",
      userId: "42",
      accountIdentifier: "administrator@example.test"
    }) as const);
    await expect(
      runAdminCredentialsRecoveryCli({
        args: [],
        environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
        input: new FakeTtyInput(true, ["否"]),
        output,
        dependencies: {
          createDatabase: () => database.handle,
          readState: async () => ({
            status: "completed",
            openedAt: new Date(0).toISOString(),
            completedAt: new Date(1).toISOString()
          }),
          hash,
          recover
        }
      })
    ).resolves.toBe(adminCredentialsRecoveryCliExitCodes.inputMismatch);
    expect(hash).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(output.text).toContain(adminCredentialsRecoveryCliResults.inputMismatch);
  });

  it("generates 256-bit base64url passwords and never exposes a writer failure", async () => {
    const first = generateAdminCredentialsRecoveryPassword();
    const second = generateAdminCredentialsRecoveryPassword();
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(Buffer.from(second, "base64url")).toHaveLength(32);
    expect(first).not.toBe(second);

    const database = createFakeDatabase();
    const output = new FakeTtyOutput();
    const secret = "synthetic-secret-not-output";
    await expect(
      runAdminCredentialsRecoveryCli({
        args: [],
        environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
        input: new FakeTtyInput(true, ["确认", "确认"]),
        output,
        dependencies: {
          createDatabase: () => database.handle,
          readState: async () => ({
            status: "completed",
            openedAt: new Date(0).toISOString(),
            completedAt: new Date(1).toISOString()
          }),
          generatePassword: () => secret,
          hash: async () => syntheticHash,
          recover: async () => ({
            status: "completed",
            userId: "42",
            accountIdentifier: "administrator@example.test"
          }) as const,
          openSecretWriter: () => ({
            writeCredentials: () => {
              throw new Error("synthetic private writer detail");
            },
            close: vi.fn()
          })
        }
      })
    ).resolves.toBe(adminCredentialsRecoveryCliExitCodes.outcomeUnknown);
    expect(output.text).toBe(
      `此操作将撤销管理员现有会话并重置密码。请输入“确认”继续：\n请再次输入“确认”以执行一次性恢复：\n${adminCredentialsRecoveryCliResults.outcomeUnknown}\n`
    );
    expect(output.text).not.toContain(secret);
  });
});

describe("bootstrap TTY reader", () => {
  it("reads a hidden value without writing any input bytes and restores terminal mode", async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput(() => input.isRaw);
    const reading = readHiddenTtyLine(input, output, "fixed prompt");

    input.emit("data", Buffer.from(syntheticPassword, "utf8"));
    input.emit("data", Buffer.from("\r", "utf8"));

    await expect(reading).resolves.toBe(syntheticPassword);
    expect(output.text).toBe("fixed prompt\n");
    expect(output.text).not.toContain(syntheticPassword);
    expect(output.writes[0]).toEqual({ value: "fixed prompt", inputWasRaw: true });
    expect(input.rawModes).toEqual([true, false]);
    expect(input.paused).toBe(true);
  });

  it("handles editing and aborts on terminal EOF while restoring terminal mode", async () => {
    const editedInput = new FakeTtyInput();
    const editedOutput = new FakeTtyOutput();
    const edited = readHiddenTtyLine(editedInput, editedOutput);
    editedInput.emit("data", Buffer.from("abc\u007fd\r", "utf8"));
    await expect(edited).resolves.toBe("abd");

    const abortedInput = new FakeTtyInput();
    const abortedOutput = new FakeTtyOutput();
    const aborted = readHiddenTtyLine(abortedInput, abortedOutput);
    abortedInput.emit("end");
    await expect(aborted).rejects.toBeInstanceOf(AdminBootstrapInputAbortedError);
    expect(abortedInput.rawModes).toEqual([true, false]);
    expect(abortedOutput.text).toBe("\n");
  });

  it("aborts on Ctrl-C, Ctrl-D, and process signals while cleaning up the terminal", async () => {
    const abortCases = [
      { kind: "data" as const, value: "\u0003" },
      { kind: "data" as const, value: "\u0004" },
      { kind: "signal" as const, value: "SIGINT" as const },
      { kind: "signal" as const, value: "SIGTERM" as const },
    ];

    for (const abortCase of abortCases) {
      const input = new FakeTtyInput();
      const output = new FakeTtyOutput();
      const sigintListeners = process.listenerCount("SIGINT");
      const sigtermListeners = process.listenerCount("SIGTERM");
      const reading = readHiddenTtyLine(input, output, "fixed prompt");

      expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners + 1);
      if (abortCase.kind === "data") {
        input.emit("data", Buffer.from(abortCase.value, "utf8"));
      } else {
        const signalListeners = process.listeners(abortCase.value);
        const registeredListener = signalListeners[signalListeners.length - 1];
        expect(registeredListener).toBeTypeOf("function");
        registeredListener?.(abortCase.value);
      }

      await expect(reading).rejects.toBeInstanceOf(AdminBootstrapInputAbortedError);
      expect(input.rawModes).toEqual([true, false]);
      expect(input.paused).toBe(true);
      expect(output.text).toBe("fixed prompt\n");
      expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    }
  });

  it("collects two hidden emails and two hidden passwords without echoing any value", async () => {
    const values = [
      credentials.email,
      credentials.emailConfirmation,
      credentials.password,
      credentials.passwordConfirmation,
    ];
    const input = new FakeTtyInput(true, values);
    const output = new FakeTtyOutput();

    await expect(collectAdminBootstrapCredentials(input, output)).resolves.toEqual(credentials);
    for (const value of values) {
      expect(output.text).not.toContain(value);
    }
    expect(input.rawModes).toEqual([true, false, true, false, true, false, true, false]);
  });
});

class FakeTtyInput extends EventEmitter {
  public readonly isTTY: boolean;
  public isRaw = false;
  public paused = false;
  public readonly rawModes: boolean[] = [];
  private readonly queuedLines: string[];

  public constructor(isTTY = true, queuedLines: readonly string[] = []) {
    super();
    this.isTTY = isTTY;
    this.queuedLines = [...queuedLines];
  }

  public setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    this.rawModes.push(enabled);
    if (enabled) {
      const next = this.queuedLines.shift();
      if (next !== undefined) {
        queueMicrotask(() => {
          this.emit("data", Buffer.from(`${next}\r`, "utf8"));
        });
      }
    }
    return this;
  }

  public resume(): this {
    this.paused = false;
    return this;
  }

  public pause(): this {
    this.paused = true;
    return this;
  }
}

class FakeTtyOutput implements AdminBootstrapTtyOutput {
  public text = "";
  public readonly writes: Array<{ value: string; inputWasRaw: boolean | undefined }> = [];

  public constructor(
    private readonly readInputRaw?: () => boolean,
    public readonly isTTY = true,
  ) {}

  public write(value: string): boolean {
    this.text += value;
    this.writes.push({ value, inputWasRaw: this.readInputRaw?.() });
    return true;
  }
}

function createFakeDatabase(): {
  handle: DatabaseHandle;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn(async () => undefined);
  const handle = { close } as unknown as DatabaseHandle;
  return { handle, close };
}
