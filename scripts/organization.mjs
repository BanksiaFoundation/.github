// @ts-check
/**
 * Finds the organization the scripts act on: the owner of this repository. In GitHub
 * Actions it is GITHUB_REPOSITORY_OWNER, and on a computer the owner of the `origin`
 * remote. There is no setting to point the scripts at another organization.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A GitHub login: letters, digits and single inner hyphens, at most 39 characters.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// The owner in an https or ssh remote URL of github.com.
const REMOTE_OWNER = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\//;

/** @returns {string | undefined} */
function remoteOwner() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return REMOTE_OWNER.exec(url.trim())?.[1];
  } catch {
    return undefined;
  }
}

/** @returns {string} */
export function organization() {
  const name = process.env.GITHUB_ACTIONS === "true" ? process.env.GITHUB_REPOSITORY_OWNER : remoteOwner();
  if (!name || !LOGIN.test(name)) {
    throw new Error(`cannot find the organization: got ${JSON.stringify(name)}`);
  }
  return name;
}
