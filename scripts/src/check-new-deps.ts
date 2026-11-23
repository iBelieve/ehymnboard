// Fails when a change adds a dependency, or changes its version, to anything
// older than the newest release pnpm will install (its minimumReleaseAge
// cooldown, which npm-check-updates reads from pnpm-workspace.yaml). Only
// those dependencies are checked: keeping the rest current is Dependabot's
// job. To hold one back on purpose, add it to `reject` in the root
// .ncurc.cjs with a comment saying why.
//
// Usage: pnpm run check-new-deps [base revision]
// The base defaults to where HEAD branched from origin/master. CI runs it on
// pull requests with HEAD^, the first parent of the PR's merge commit.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  catalogSpecs,
  changedNames,
  isRecord,
  manifestSpecs,
  workspacePackages,
  type Specs,
} from "./new-deps.ts";

const WORKSPACE_FILE = "pnpm-workspace.yaml";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** Resolves `revision` to a commit, or fails: an unknown base must not make every dependency look new. */
function resolveCommit(root: string, revision: string): string {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Unknown base revision ${revision} (in a shallow clone, fetch it first)`);
  }
  return result.stdout.trim();
}

/** A file's contents at `commit`, or undefined if it didn't exist there. */
function atRevision(root: string, commit: string, path: string): string | undefined {
  const exists = spawnSync("git", ["cat-file", "-e", `${commit}:${path}`], { cwd: root });
  return exists.status === 0 ? git(root, ["show", `${commit}:${path}`]) : undefined;
}

function inWorkingTree(root: string, path: string): string | undefined {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** Parses a manifest, naming the file and revision if it isn't valid. */
function specsOf(
  parse: (text: string | undefined) => Specs,
  text: string | undefined,
  where: string,
): Specs {
  try {
    return parse(text);
  } catch (error) {
    throw new Error(`Can't parse ${where}`, { cause: error });
  }
}

// Run the binary itself, not through `pnpm exec`, which may install first.
const ncuBinary = (root: string): string => join(root, "node_modules", ".bin", "ncu");

/** Runs npm-check-updates on one package.json; true if every named dependency is current. */
function checkManifest(root: string, manifest: string, names: string[]): boolean {
  const args = ["--packageFile", manifest, "--configFilePath", root, "--filter", names.join(",")];
  const result = spawnSync(ncuBinary(root), [...args, "--errorLevel", "2"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

/**
 * Checks catalog entries; true if every named one is current.
 * npm-check-updates reaches the catalogs only through --workspaces, which also
 * checks each package.json for these names, so only its results for
 * pnpm-workspace.yaml count: a package's own pin of the same name is
 * unchanged here.
 */
function checkCatalog(root: string, names: string[], current: Specs): boolean {
  const args = ["--workspaces", "--configFilePath", root, "--filter", names.join(",")];
  const result = spawnSync(ncuBinary(root), [...args, "--jsonUpgraded"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm-check-updates failed: ${result.stdout}`);
  const upgrades: unknown = JSON.parse(result.stdout);
  const catalog = isRecord(upgrades) ? upgrades[WORKSPACE_FILE] : undefined;
  const outdated = isRecord(catalog) ? Object.entries(catalog) : [];
  console.log(`Checking ${WORKSPACE_FILE} catalog entries: ${names.join(", ")}`);
  for (const [name, latest] of outdated) {
    console.log(` ${name}  ${current.get(name) ?? ""}  →  ${String(latest)}`);
  }
  return outdated.length === 0;
}

function main(): void {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const requested = process.argv[2] ?? git(root, ["merge-base", "origin/master", "HEAD"]).trim();
  const base = resolveCommit(root, requested);
  console.log(`Checking dependencies added or changed since ${requested} (${base})`);

  const workspace = inWorkingTree(root, WORKSPACE_FILE);
  let ok = true;
  let checked = 0;
  for (const dir of [".", ...workspacePackages(workspace)]) {
    // A git path, so always with forward slashes.
    const manifest = posix.join(dir, "package.json");
    const names = changedNames(
      specsOf(manifestSpecs, atRevision(root, base, manifest), `${manifest} at ${requested}`),
      specsOf(manifestSpecs, inWorkingTree(root, manifest), manifest),
    );
    if (names.length === 0) continue;
    checked += names.length;
    ok = checkManifest(root, manifest, names) && ok;
  }

  const catalog = specsOf(catalogSpecs, workspace, WORKSPACE_FILE);
  const catalogNames = changedNames(
    specsOf(
      catalogSpecs,
      atRevision(root, base, WORKSPACE_FILE),
      `${WORKSPACE_FILE} at ${requested}`,
    ),
    catalog,
  );
  if (catalogNames.length > 0) {
    checked += catalogNames.length;
    ok = checkCatalog(root, catalogNames, catalog) && ok;
  }

  if (checked === 0) {
    console.log("No dependencies were added or changed.");
  } else if (!ok) {
    console.error(
      "\nA dependency added or changed here isn't the newest release. Update it, or if it's held back on purpose, add it to `reject` in .ncurc.cjs with a comment saying why.",
    );
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
