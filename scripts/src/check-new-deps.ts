// Fails when a change adds a dependency, or changes its version, to anything
// older than the newest release pnpm will install (its minimumReleaseAge
// cooldown, which npm-check-updates reads from pnpm-workspace.yaml). Only
// those dependencies are checked: keeping the rest current is Dependabot's
// job. To hold one back on purpose, add it to `reject` in the root
// .ncurc.cjs with a comment saying why.
//
// Usage: pnpm run check-new-deps [base revision]
// The base defaults to where HEAD branched from origin/master; CI passes
// HEAD^ (a pull request's merge commit, or the previous master commit).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogSpecs, changedNames, manifestSpecs, workspacePackages } from "./new-deps.ts";

const WORKSPACE_FILE = "pnpm-workspace.yaml";

function git(root: string, args: string[]): string {
  // Capture stderr too: a missing file is an expected failure of `git show`.
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

/** A file's contents at `revision`, or undefined if it didn't exist there. */
function atRevision(root: string, revision: string, path: string): string | undefined {
  try {
    return git(root, ["show", `${revision}:${path}`]);
  } catch {
    return undefined;
  }
}

function inWorkingTree(root: string, path: string): string | undefined {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** Runs npm-check-updates; true if every named dependency is current. */
function ncu(root: string, target: string[], names: string[]): boolean {
  const args = [
    ...target,
    "--configFilePath",
    root,
    "--filter",
    names.join(","),
    "--errorLevel",
    "2",
  ];
  // Run the binary itself, not through `pnpm exec`, which may install first.
  const result = spawnSync(join(root, "node_modules", ".bin", "ncu"), args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function main(): void {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const base = process.argv[2] ?? git(root, ["merge-base", "origin/master", "HEAD"]).trim();
  console.log(`Checking dependencies added or changed since ${base}`);

  const workspace = inWorkingTree(root, WORKSPACE_FILE);
  let ok = true;
  let checked = 0;
  for (const dir of [".", ...workspacePackages(workspace)]) {
    const manifest = join(dir, "package.json");
    const names = changedNames(
      manifestSpecs(atRevision(root, base, manifest)),
      manifestSpecs(inWorkingTree(root, manifest)),
    );
    if (names.length === 0) continue;
    checked += names.length;
    ok = ncu(root, ["--packageFile", manifest], names) && ok;
  }

  const catalogNames = changedNames(
    catalogSpecs(atRevision(root, base, WORKSPACE_FILE)),
    catalogSpecs(workspace),
  );
  if (catalogNames.length > 0) {
    checked += catalogNames.length;
    // --workspaces is how npm-check-updates reaches the catalogs. The
    // packages depend on catalog entries as "catalog:", which it skips.
    ok = ncu(root, ["--workspaces"], catalogNames) && ok;
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

main();
