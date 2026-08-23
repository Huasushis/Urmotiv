import { describe, expect, it } from "vitest";
import { parseCommand } from "../scripts/migrate-hist";

describe("recover-active CLI", () => {
  it("parses the bound output and source identity without a caller run identity", () => {
    expect(
      parseCommand([
        "recover-active",
        "--private-root",
        "/private",
        "--materialized",
        "/private/materialized",
        "--metadata",
        "/private/metadata.private.json",
        "--out",
        "/private/prepared",
        "--source-id",
        "source-000001",
      ]),
    ).toEqual({
      phase: "recover-active",
      privateRootDirectory: "/private",
      materializedDirectory: "/private/materialized",
      metadataFile: "/private/metadata.private.json",
      outputDirectory: "/private/prepared",
      sourceId: "source-000001",
    });
  });

  it("refuses a recovery command without an explicit source identity", () => {
    expect(() =>
      parseCommand([
        "recover-active",
        "--private-root",
        "/private",
        "--materialized",
        "/private/materialized",
        "--metadata",
        "/private/metadata.private.json",
        "--out",
        "/private/prepared",
      ]),
    ).toThrow(/--source-id/);
  });

  it("refuses a caller-supplied run tag", () => {
    expect(() =>
      parseCommand([
        "recover-active",
        "--private-root",
        "/private",
        "--materialized",
        "/private/materialized",
        "--metadata",
        "/private/metadata.private.json",
        "--out",
        "/private/prepared",
        "--source-id",
        "source-000001",
        "--run-tag",
        "untrusted-run",
      ]),
    ).toThrow(/不接受调用方 run 标签/);
  });
});
