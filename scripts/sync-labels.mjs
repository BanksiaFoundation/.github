// @ts-check
/**
 * Creates or updates the labels in labels.json on the repositories of the organization.
 *
 * Usage: node scripts/sync-labels.mjs [OWNER/REPO ...]. With no repository it syncs every
 * repository of the organization that is not archived. It deletes no label. It needs the
 * GitHub CLI, logged in with write access to the repositories.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ORG = "BanksiaFoundation";
const REPO_LIMIT = "1000";

/** @typedef {{ name: string, color: string, description: string }} Label */

/** @returns {Label[]} */
function labels() {
  return JSON.parse(readFileSync(new URL("../labels.json", import.meta.url), "utf8"));
}

/**
 * @param {string[]} args
 * @returns {string[]}
 */
function repos(args) {
  if (args.length > 0) return args;
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
for (const repo of repos(process.argv.slice(2))) {
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
