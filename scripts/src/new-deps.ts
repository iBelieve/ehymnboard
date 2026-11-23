// Finds the dependencies a change adds, or whose version it changes, by
// comparing the manifests before and after it: each package.json and the
// catalogs in pnpm-workspace.yaml. Pure functions over file contents, so the
// tests need neither git nor the registry.

import { parse } from "yaml";

/** Dependency name to version spec. */
export type Specs = Map<string, string>;

// Sections of package.json whose versions get installed. peerDependencies are
// left out: they're deliberately wide ranges, not what we install.
const MANIFEST_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addStrings(specs: Specs, section: unknown): void {
  if (!isRecord(section)) return;
  for (const [name, spec] of Object.entries(section)) {
    if (typeof spec === "string") specs.set(name, spec);
  }
}

/** The version specs in a package.json; empty when the file doesn't exist. */
export function manifestSpecs(text: string | undefined): Specs {
  const specs: Specs = new Map();
  if (text === undefined) return specs;
  const manifest: unknown = JSON.parse(text);
  if (!isRecord(manifest)) return specs;
  for (const section of MANIFEST_SECTIONS) addStrings(specs, manifest[section]);
  return specs;
}

function parseWorkspace(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  const workspace: unknown = parse(text);
  return isRecord(workspace) ? workspace : {};
}

/**
 * The version specs in pnpm-workspace.yaml's default catalog and named
 * catalogs. A name in more than one catalog is keyed by catalog, so a change
 * to any of them counts.
 */
export function catalogSpecs(text: string | undefined): Specs {
  const workspace = parseWorkspace(text);
  const specs: Specs = new Map();
  addStrings(specs, workspace["catalog"]);
  const named = workspace["catalogs"];
  if (isRecord(named)) {
    for (const [catalog, entries] of Object.entries(named)) {
      const scoped: Specs = new Map();
      addStrings(scoped, entries);
      for (const [name, spec] of scoped) specs.set(`${catalog}:${name}`, spec);
    }
  }
  return specs;
}

/** The workspace's package directories, relative to the root. */
export function workspacePackages(text: string | undefined): string[] {
  const packages = parseWorkspace(text)["packages"];
  if (!Array.isArray(packages)) return [];
  return packages.map((entry) => {
    if (typeof entry !== "string" || /[*?{}[\]!]/.test(entry)) {
      throw new Error(
        `pnpm-workspace.yaml: only plain package paths are supported, not ${String(entry)}`,
      );
    }
    return entry;
  });
}

// Specs that don't name a registry version, such as "catalog:",
// "workspace:*", "link:../x", "file:x.tgz", "npm:other@1" or a git URL. The
// catalog's own entries are checked where they're defined.
function isRegistrySpec(spec: string): boolean {
  return !/^[a-z][a-z+]*:/i.test(spec);
}

/**
 * The names of dependencies that `head` adds or changes the version of,
 * sorted. Removed dependencies and non-registry specs are left out. Catalog
 * keys of the form "catalog:name" come back as the bare package name.
 */
export function changedNames(base: Specs, head: Specs): string[] {
  const names = new Set<string>();
  for (const [key, spec] of head) {
    if (base.get(key) === spec || !isRegistrySpec(spec)) continue;
    names.add(key.slice(key.indexOf(":") + 1));
  }
  return [...names].toSorted();
}
