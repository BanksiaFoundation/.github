// @ts-check
/**
 * Creates or updates the labels in labels.json on the repositories of the organization.
 *
 * Usage: node scripts/sync-labels.mjs. It syncs every repository of the organization that
 * is not archived, and deletes no label. It needs the GitHub CLI, logged in with write
 * access to the repositories.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { organization } from "./organization.mjs";

const ORG = organization();
const REPO_LIMIT = "1000";
// GitHub's limits for a label.
const MAX_NAME = 50;
const MAX_DESCRIPTION = 100;
const COLOR = /^[0-9a-f]{6}$/i;

/** @typedef {{ name: string, color: string, description: string }} Label */

/** @returns {Label[]} */
function labels() {
  /** @type {Label[]} */
  const list = JSON.parse(readFileSync(new URL("../labels.json", import.meta.url), "utf8"));
  for (const label of list) {
    const valid =
      typeof label.name === "string" && label.name.length > 0 && label.name.length <= MAX_NAME &&
      !label.name.startsWith("-") && COLOR.test(label.color) &&
      typeof label.description === "string" && label.description.length <= MAX_DESCRIPTION;
    if (!valid) throw new Error(`labels.json has an invalid label: ${JSON.stringify(label)}`);
  }
  return list;
}

/** @returns {string[]} */
function repos() {
  const out = execFileSync(
    "gh",
    ["repo", "list", ORG, "--limit", REPO_LIMIT, "--no-archived", "--json", "name"],
    { encoding: "utf8" },
  );
  /** @type {{ name: string }[]} */
  const list = JSON.parse(out);
  return list.map((repo) => `${ORG}/${repo.name}`);
}

let failed = 0;
for (const repo of repos()) {
  for (const label of labels()) {
    try {
      execFileSync(
        "gh",
        ["label", "create", label.name, "--repo", repo, "--force",
          "--color", label.color, "--description", label.description],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (error) {
      failed += 1;
      console.error(`${repo}: ${label.name}: ${String(error)}`);
    }
  }
  console.log(`${repo}: synced`);
}
process.exitCode = failed > 0 ? 1 : 0;
