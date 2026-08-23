import { describe, expect, it } from "vitest";
import { parseCommand } from "../scripts/migrate-hist";

describe("recover-active CLI", () => {
  it("parses the bound output, run tag, and source identity", () => {
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
        "--run-tag",
        "run-001",
        "--source-id",
        "source-000001",
      ]),
    ).toEqual({
      phase: "recover-active",
      privateRootDirectory: "/private",
      materializedDirectory: "/private/materialized",
      metadataFile: "/private/metadata.private.json",
      outputDirectory: "/private/prepared",
      operationTag: "run-001",
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
        "--run-tag",
        "run-001",
      ]),
    ).toThrow(/--source-id/);
  });
});
