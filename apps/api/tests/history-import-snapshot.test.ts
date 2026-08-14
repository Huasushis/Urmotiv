import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureStorageInventory,
  restoreStorageDirectory,
  snapshotStorageDirectory,
} from "../src/history-migration/history-import-snapshot";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `urmotiv-history-storage-${randomUUID()}-`));
  temporaryDirectories.push(path);
  return path;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("history import storage snapshots", () => {
  it("验证快照、拒绝损坏恢复，并只在成功恢复后删除备份", async () => {
    const root = await temporaryDirectory();
    const storageRoot = join(root, "storage");
    const snapshotRoot = join(root, "snapshot");
    await privateDirectory(storageRoot);
    await writeFile(join(storageRoot, "baseline.bin"), Buffer.from("baseline"), { mode: 0o600 });
    const baseline = await captureStorageInventory(storageRoot);
    expect(await snapshotStorageDirectory(storageRoot, snapshotRoot)).toEqual(baseline);

    await writeFile(join(storageRoot, "mutated.bin"), Buffer.from("mutated"), { mode: 0o600 });
    await writeFile(join(snapshotRoot, "baseline.bin"), Buffer.from("corrupted"), { mode: 0o600 });
    await expect(restoreStorageDirectory(snapshotRoot, storageRoot, baseline)).rejects.toThrow();
    expect((await readFile(join(storageRoot, "mutated.bin"))).toString()).toBe("mutated");
    expect((await readFile(join(snapshotRoot, "baseline.bin"))).toString()).toBe("corrupted");

    await rm(snapshotRoot, { recursive: true, force: true });
    expect(await snapshotStorageDirectory(storageRoot, snapshotRoot)).toEqual(
      await captureStorageInventory(storageRoot),
    );
    const mutatedBaseline = await captureStorageInventory(storageRoot);
    await writeFile(join(storageRoot, "extra.bin"), Buffer.from("extra"), { mode: 0o600 });
    expect(await restoreStorageDirectory(snapshotRoot, storageRoot, mutatedBaseline)).toEqual(
      mutatedBaseline,
    );
    expect(await captureStorageInventory(storageRoot)).toEqual(mutatedBaseline);
    await expect(readFile(snapshotRoot)).rejects.toThrow();
  });
});
