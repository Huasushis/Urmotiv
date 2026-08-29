import { hashPassword } from "@urmotiv/auth";
import { corePermissions, type PermissionGrant } from "@urmotiv/contracts";
import type { AdminBootstrapStateRecord, DatabaseHandle } from "@urmotiv/database";
import type { AdminBootstrapTtyInput, AdminBootstrapTtyOutput } from "../src/bootstrap-admin";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { createDemoUsers, demoTags } from "../src/demo-data";
import { InMemoryDataStore } from "../src/repository";
import {
  rootCredentialsRecoveryCliExitCodes,
  rootCredentialsRecoveryCliResults,
  runRootCredentialsRecoveryCli
} from "../src/recover-root-credentials";

const syntheticHash = "$argon2id$v=19$m=19456,t=2,p=1$c3lvdGhldGljc2FsdA$c3ludGhldGljaGFzaA";

class FakeOutput implements AdminBootstrapTtyOutput {
  public readonly isTTY = true;
  public text = "";
  public write(value: string): void {
    this.text += value;
  }
}

function fakeInput(isTTY = true): AdminBootstrapTtyInput {
  return {
    isTTY,
    setRawMode() { return this; },
    on() { return this; },
    once() { return this; },
    removeListener() { return this; },
    resume() { return this; },
    pause() { return this; }
  };
}

function fakeDatabase(): { handle: DatabaseHandle; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => undefined);
  return {
    close,
    handle: { close, kind: "postgres" } as unknown as DatabaseHandle
  };
}

function completedState(): AdminBootstrapStateRecord {
  return { status: "completed", openedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString() };
}
function rootUser(): {
  id: string;
  nickname: string;
  accountType: "human";
  disabled: false;
  roles: string[];
  grants: PermissionGrant[];
  isRoot: true;
} {
  return {
    id: "0",
    nickname: "root",
    accountType: "human",
    disabled: false,
    roles: ["root"],
    grants: corePermissions.map((permission) => ({ permission, effect: "allow", scope: "global" })),
    isRoot: true
  };
}

describe("root local login", () => {
  it("authenticates only the fixed root username and returns no credential material", async () => {
    const password = "synthetic-root-login-password";
    const digest = await hashPassword(password);
    const app = await createApp({
      store: new InMemoryDataStore([rootUser(), ...createDemoUsers()], demoTags, { rootPasswordHash: digest }),
      allowedOrigins: ["https://urmotiv.example.test"],
      secureCookies: true
    });
    try {
      const success = await app.inject({
        method: "POST",
        url: "/api/v1/auth/root-login",
        headers: { origin: "https://urmotiv.example.test" },
        payload: { identifier: "root", password }
      });
      expect(success.statusCode).toBe(200);
      expect(success.json().user.id).toBe("0");
      expect(success.json().identity).toEqual({
        actor: { id: "0", nickname: "root" },
        effective: { id: "0", nickname: "root" },
        switched: false
      });
      expect(success.json()).not.toHaveProperty("password");
      expect(success.json()).not.toHaveProperty("token");

      const failure = await app.inject({
        method: "POST",
        url: "/api/v1/auth/root-login",
        headers: { origin: "https://urmotiv.example.test" },
        payload: { identifier: "root", password: "wrong-root-password" }
      });
      expect(failure.statusCode).toBe(401);
      expect(failure.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});


describe("root credential recovery CLI", () => {
  it("rejects non-TTY before database, random, hash, or secret-writer access", async () => {
    const output = new FakeOutput();
    const database = fakeDatabase();
    const createDatabase = vi.fn(() => database.handle);
    const generatePassword = vi.fn(() => "must-not-generate");
    const hash = vi.fn(async () => syntheticHash);
    const recover = vi.fn(async () => "not_completed" as const);
    const openSecretWriter = vi.fn();
    await expect(runRootCredentialsRecoveryCli({
      args: [],
      environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
      input: fakeInput(false),
      output,
      dependencies: { createDatabase, generatePassword, hash, recover, openSecretWriter }
    })).resolves.toBe(rootCredentialsRecoveryCliExitCodes.ttyRequired);
    expect(output.text).toBe(`${rootCredentialsRecoveryCliResults.ttyRequired}\n`);
    expect(createDatabase).not.toHaveBeenCalled();
    expect(generatePassword).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(openSecretWriter).not.toHaveBeenCalled();
  });

  it("accepts no target selector and writes the generated root credential only to TTY", async () => {
    const output = new FakeOutput();
    const database = fakeDatabase();
    const writes: Array<{ identifier: string; password: string }> = [];
    const writer = { writeCredentials: vi.fn((identifier: string, password: string) => writes.push({ identifier, password })), close: vi.fn() };
    const password = "synthetic-root-secret";
    const recover = vi.fn(async () => ({ status: "completed", userId: "0", accountIdentifier: "root" }) as const);
    await expect(runRootCredentialsRecoveryCli({
      args: [],
      environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv", ROOT_PASSWORD: "must-not-read" },
      input: fakeInput(),
      output,
      dependencies: {
        createDatabase: () => database.handle,
        readState: async () => completedState(),
        collectConfirmations: async () => undefined,
        generatePassword: () => password,
        hash: async (value: string) => { expect(value).toBe(password); return syntheticHash; },
        recover,
        openSecretWriter: () => writer
      }
    })).resolves.toBe(rootCredentialsRecoveryCliExitCodes.success);
    expect(recover).toHaveBeenCalledWith(database.handle, { passwordHash: syntheticHash });
    expect(writes).toEqual([{ identifier: "root", password }]);
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(output.text).toBe(`${rootCredentialsRecoveryCliResults.success}\n`);
    expect(output.text).not.toContain(password);
    expect(output.text).not.toContain(syntheticHash);
    expect(output.text).not.toContain("must-not-read");
  });

  it("does not mutate credentials when secret TTY writing fails", async () => {
    const output = new FakeOutput();
    const database = fakeDatabase();
    const recover = vi.fn(async () => ({ status: "completed", userId: "0", accountIdentifier: "root" }) as const);
    const writer = {
      writeCredentials: vi.fn(() => { throw new Error("synthetic writer failure"); }),
      close: vi.fn()
    };
    await expect(runRootCredentialsRecoveryCli({
      args: [],
      environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
      input: fakeInput(),
      output,
      dependencies: {
        createDatabase: () => database.handle,
        readState: async () => completedState(),
        collectConfirmations: async () => undefined,
        generatePassword: () => "synthetic-secret",
        hash: async () => syntheticHash,
        recover,
        openSecretWriter: () => writer
      }
    })).resolves.toBe(rootCredentialsRecoveryCliExitCodes.secretWriteFailed);
    expect(recover).not.toHaveBeenCalled();
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(output.text).toBe(`${rootCredentialsRecoveryCliResults.secretWriteFailed}\n`);
    expect(output.text).not.toContain("synthetic-secret");
  });

  it("maps database failures to a safe result after the TTY secret boundary", async () => {
    const output = new FakeOutput();
    const database = fakeDatabase();
    const writer = { writeCredentials: vi.fn(), close: vi.fn() };
    await expect(runRootCredentialsRecoveryCli({
      args: [],
      environment: { DATABASE_URL: "postgres://synthetic.invalid/urmotiv" },
      input: fakeInput(),
      output,
      dependencies: {
        createDatabase: () => database.handle,
        readState: async () => completedState(),
        collectConfirmations: async () => undefined,
        generatePassword: () => "synthetic-secret",
        hash: async () => syntheticHash,
        recover: async () => { throw new Error("synthetic database failure"); },
        openSecretWriter: () => writer
      }
    })).resolves.toBe(rootCredentialsRecoveryCliExitCodes.unavailable);
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(output.text).toBe(`${rootCredentialsRecoveryCliResults.unavailable}\n`);
    expect(output.text).not.toContain("synthetic-secret");
  });
});
