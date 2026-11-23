import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogSpecs, changedNames, manifestSpecs, workspacePackages } from "../src/new-deps.ts";

const manifest = (sections: Record<string, Record<string, string>>): string =>
  JSON.stringify(sections);

const specMap = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("manifestSpecs", () => {
  it("reads installed sections and skips peerDependencies", () => {
    const specs = manifestSpecs(
      manifest({
        dependencies: { hono: "^4.13.19" },
        devDependencies: { typescript: "catalog:" },
        optionalDependencies: { fsevents: "2.3.3" },
        peerDependencies: { react: ">=18" },
      }),
    );
    assert.deepEqual(
      specs,
      new Map([
        ["hono", "^4.13.19"],
        ["typescript", "catalog:"],
        ["fsevents", "2.3.3"],
      ]),
    );
  });

  it("is empty for a missing file or one without dependencies", () => {
    assert.equal(manifestSpecs(undefined).size, 0);
    assert.equal(manifestSpecs('{"name": "x"}').size, 0);
    assert.equal(manifestSpecs("[]").size, 0);
  });

  it("ignores non-string specs", () => {
    assert.equal(manifestSpecs('{"dependencies": {"x": 1}}').size, 0);
  });
});

describe("catalogSpecs", () => {
  it("reads the default catalog and keys named catalogs by name", () => {
    const specs = catalogSpecs(
      [
        "catalog:",
        "  typescript: 7.0.2",
        "catalogs:",
        "  legacy:",
        '    "@types/node": ^22.0.0',
      ].join("\n"),
    );
    assert.deepEqual(
      specs,
      new Map([
        ["typescript", "7.0.2"],
        ["legacy:@types/node", "^22.0.0"],
      ]),
    );
  });

  it("is empty without a file or catalog", () => {
    assert.equal(catalogSpecs(undefined).size, 0);
    assert.equal(catalogSpecs("packages:\n  - web\n").size, 0);
    assert.equal(catalogSpecs("just a string").size, 0);
  });
});

describe("workspacePackages", () => {
  it("lists plain package paths", () => {
    assert.deepEqual(workspacePackages("packages:\n  - web\n  - device/emulator\n"), [
      "web",
      "device/emulator",
    ]);
  });

  it("is empty without a packages list", () => {
    assert.deepEqual(workspacePackages(undefined), []);
    assert.deepEqual(workspacePackages("catalog: {}\n"), []);
  });

  it("rejects globs, which the check can't expand", () => {
    assert.throws(
      () => workspacePackages("packages:\n  - packages/*\n"),
      /only plain package paths/,
    );
  });
});

describe("changedNames", () => {
  it("finds added and changed dependencies, sorted", () => {
    const base = specMap({ hono: "^4.13.19", react: "^19.3.1", gone: "1.0.0" });
    const head = specMap({ react: "^19.3.2", hono: "^4.13.19", added: "^1.0.0" });
    assert.deepEqual(changedNames(base, head), ["added", "react"]);
  });

  it("skips specs that aren't registry versions", () => {
    const head = specMap({
      a: "catalog:",
      b: "workspace:*",
      c: "link:../c",
      d: "file:d.tgz",
      e: "npm:other@1",
      f: "git+https://example.com/f.git",
      g: "github:owner/g",
    });
    assert.deepEqual(changedNames(new Map(), head), []);
  });

  it("reports a named catalog's entry by its package name, once", () => {
    const head = specMap({ "@types/node": "^26.6.6", "legacy:@types/node": "^22.0.0" });
    assert.deepEqual(changedNames(new Map(), head), ["@types/node"]);
  });
});
