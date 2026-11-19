// @ts-check
/**
 * Keeps the organization project and the stage labels in step.
 *
 * Usage: GH_TOKEN=... node scripts/sync-project.mjs. Each run does three things:
 * 1. adds every open issue and pull request of the organization to the project;
 * 2. moves an item's Status from its pull requests, and leaves an item with no pull
 *    request where a person put it;
 * 3. puts the stage label of each item's Status on the issue or pull request and takes
 *    the other stage labels off;
 * 4. turns a "Blocked by #N" or "Depends on OWNER/REPO#N" line in an issue body into a
 *    GitHub dependency, and marks an issue with an open blocker with the `blocked` label
 *    and the Blocked field.
 * The token needs read access to every repository, write access to issues and pull
 * requests for labels, and write access to the organization's projects. Nothing is
 * removed from the project.
 *
 * This repository is public, and so are its Actions logs. The script logs counts only,
 * never an issue, a pull request or a response body from a private repository. It acts
 * only on items opened by an owner, a member or a collaborator of the organization.
 */
import { organization } from "./organization.mjs";

const GRAPHQL = "https://api.github.com/graphql";
const REST = "https://api.github.com";
const ORG = organization();
const PROJECT_NUMBER = 1;
const REQUEST_TIMEOUT_MS = 30_000;
// Stops a run that would write more than a normal run does, such as after a bad change.
const MAX_WRITES = 500;
const TRUSTED_AUTHORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const PAGE_SIZE = 50;
const LINKED_PRS = 20;
const LABELS_READ = 50;
const BLOCKERS_READ = 50;
const BLOCKED_LABEL = "blocked";
const BLOCKED_OPTION = "Yes";
// A line such as "Blocked by #12" or "Depends on OWNER/REPO#12".
const DEPENDENCY_LINE = /^\s*[-*]?\s*(?:blocked by|depends on)\s+((?:[\w.-]+\/[\w.-]+)?#\d+)/gim;

const TODO = "Todo";
const IN_PROGRESS = "In progress";
const IN_REVIEW = "In review";
const DONE = "Done";

/** The label for each Status. Todo has none. @type {Record<string, string>} */
const STAGE_LABEL = { [IN_PROGRESS]: "in-progress", [IN_REVIEW]: "in-review", [DONE]: "done" };
const STAGE_LABELS = new Set(Object.values(STAGE_LABEL));

/** @returns {string} */
function token() {
  const value = process.env.GH_TOKEN;
  if (!value) throw new Error("GH_TOKEN is not set");
  return value;
}

/**
 * @param {string} query
 * @param {Record<string, unknown>} variables
 * @returns {Promise<any>}
 */
async function graphql(query, variables) {
  if (query.trimStart().startsWith("mutation")) countWrite();
  const response = await fetch(GRAPHQL, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // The error text can name private repositories, so only the status and error types go out.
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors || !body.data) {
    const types = (body.errors ?? []).map((/** @type {{ type?: string }} */ e) => e.type ?? "unknown");
    throw new Error(`GraphQL request answered ${response.status} ${types.join(",")}`);
  }
  return body.data;
}

let writes = 0;
const counts = { labels: 0, links: 0, failures: 0 };
function countWrite() {
  writes += 1;
  if (writes > MAX_WRITES) throw new Error(`stopped after ${MAX_WRITES} writes in one run`);
}

/**
 * @param {"POST" | "DELETE"} method
 * @param {string} path
 * @param {unknown} [body]
 */
async function rest(method, path, body) {
  countWrite();
  const response = await fetch(`${REST}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, accept: "application/vnd.github+json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // A label that is already gone answers 404, which is the state we want.
  if (!response.ok && !(method === "DELETE" && response.status === 404)) {
    throw new Error(`REST ${method} answered ${response.status}`);
  }
}

/**
 * Reads every page of a connection.
 *
 * @param {string} query must take `$after` and select `nodes` and `pageInfo`
 * @param {Record<string, unknown>} variables
 * @param {(data: any) => { nodes: any[], pageInfo: { hasNextPage: boolean, endCursor: string } }} pick
 * @returns {Promise<any[]>}
 */
async function all(query, variables, pick) {
  /** @type {any[]} */
  const nodes = [];
  /** @type {string | null} */
  let after = null;
  for (;;) {
    const page = pick(await graphql(query, { ...variables, after }));
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    after = page.pageInfo.endCursor;
  }
}

const CONTENT = `
  id number state authorAssociation
  repository { nameWithOwner }
  labels(first: ${LABELS_READ}) { nodes { name } }`;

const ITEMS = `query($org: String!, $number: Int!, $after: String) {
  organization(login: $org) { projectV2(number: $number) {
    items(first: ${PAGE_SIZE}, after: $after) {
      nodes { id
        status: fieldValueByName(name: "Status") {
          ... on ProjectV2ItemFieldSingleSelectValue { name } }
        blocked: fieldValueByName(name: "Blocked") {
          ... on ProjectV2ItemFieldSingleSelectValue { name } }
        content {
          ... on Issue { ${CONTENT}
            body
            blockedBy(first: ${BLOCKERS_READ}) { nodes { id state } }
            closedByPullRequestsReferences(first: ${LINKED_PRS}, includeClosedPrs: true) {
              nodes { state isDraft authorAssociation } } }
          ... on PullRequest { ${CONTENT} isDraft } } }
      pageInfo { hasNextPage endCursor } } } } }`;

const PROJECT = `query($org: String!, $number: Int!) {
  organization(login: $org) { projectV2(number: $number) { id
    field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
    blocked: field(name: "Blocked") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`;

const ISSUE_ID = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { id state } } }`;

const ADD_BLOCKER = `mutation($issue: ID!, $blocker: ID!) {
  addBlockedBy(input: { issueId: $issue, blockingIssueId: $blocker }) { issue { id } } }`;

const CLEAR_FIELD = `mutation($project: ID!, $item: ID!, $field: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) {
    projectV2Item { id } } }`;

// Issue search returns at most 1000 results for one query.
const OPEN = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
    nodes { ... on Issue { id authorAssociation } ... on PullRequest { id authorAssociation } }
    pageInfo { hasNextPage endCursor } } }`;

const ADD = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`;

const SET_STATUS = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field,
    value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`;

/**
 * The Status the pull requests of an item call for, or the current one when they call for none.
 *
 * @param {any} content an Issue or a PullRequest
 * @param {string} current
 * @returns {string}
 */
function derivedStatus(content, current) {
  if (content.state !== "OPEN") return DONE;
  if (content.isDraft === true) return IN_PROGRESS;
  if (content.isDraft === false) return IN_REVIEW;
  /** @type {{ state: string, isDraft: boolean }[]} */
  const open = content.closedByPullRequestsReferences.nodes.filter(
    (/** @type {{ state: string, authorAssociation: string }} */ pr) =>
      pr.state === "OPEN" && TRUSTED_AUTHORS.has(pr.authorAssociation),
  );
  if (open.some((pr) => !pr.isDraft)) return IN_REVIEW;
  if (open.length > 0) return IN_PROGRESS;
  return current === DONE ? TODO : current;
}

/**
 * @param {any} content
 * @param {string} status
 */
async function setStageLabel(content, status) {
  const want = STAGE_LABEL[status];
  /** @type {string[]} */
  const have = content.labels.nodes.map((/** @type {{ name: string }} */ label) => label.name);
  const path = `/repos/${content.repository.nameWithOwner}/issues/${content.number}/labels`;
  for (const name of have) {
    if (STAGE_LABELS.has(name) && name !== want) {
      await rest("DELETE", `${path}/${encodeURIComponent(name)}`);
      counts.labels += 1;
    }
  }
  if (want && !have.includes(want)) {
    await rest("POST", path, { labels: [want] });
    counts.labels += 1;
  }
}

const project = (await graphql(PROJECT, { org: ORG, number: PROJECT_NUMBER })).organization.projectV2;
/** @type {Map<string, string>} */
const optionId = new Map(project.field.options.map((/** @type {{ id: string, name: string }} */ o) => [o.name, o.id]));
const pickItems = (/** @type {any} */ data) => data.organization.projectV2.items;

const before = await all(ITEMS, { org: ORG, number: PROJECT_NUMBER }, pickItems);
const held = new Set(before.map((item) => item.content?.id).filter(Boolean));
const open = await all(OPEN, { q: `org:${ORG} is:open archived:false` }, (data) => data.search);
let added = 0;
for (const node of open) {
  if (!node.id || held.has(node.id) || !TRUSTED_AUTHORS.has(node.authorAssociation)) continue;
  await graphql(ADD, { project: project.id, content: node.id });
  added += 1;
}

/**
 * Adds the dependencies an issue body names and returns whether an open issue blocks it.
 *
 * @param {any} content an Issue
 * @returns {Promise<boolean>}
 */
async function syncBlockers(content) {
  /** @type {{ id: string, state: string }[]} */
  const blockers = [...content.blockedBy.nodes];
  const known = new Set(blockers.map((blocker) => blocker.id));
  const [owner, name] = content.repository.nameWithOwner.split("/");
  for (const match of String(content.body ?? "").matchAll(DEPENDENCY_LINE)) {
    const [repo, number] = match[1].split("#");
    const [refOwner, refName] = repo ? repo.split("/") : [owner, name];
    if (refOwner.toLowerCase() !== ORG.toLowerCase()) continue;
    // A wrong reference, such as a pull request number or a typo, skips that line only.
    try {
      const target = (await graphql(ISSUE_ID, { owner: refOwner, name: refName, number: Number(number) }))
        .repository?.issue;
      if (!target || known.has(target.id) || target.id === content.id) continue;
      await graphql(ADD_BLOCKER, { issue: content.id, blocker: target.id });
      known.add(target.id);
      blockers.push(target);
    } catch (error) {
      if (writes > MAX_WRITES) throw error;
      counts.failures += 1;
      continue;
    }
    counts.links += 1;
  }
  return blockers.some((blocker) => blocker.state === "OPEN");
}

/**
 * @param {any} item
 * @param {boolean} blocked
 */
async function setBlocked(item, blocked) {
  const content = item.content;
  /** @type {string[]} */
  const have = content.labels.nodes.map((/** @type {{ name: string }} */ label) => label.name);
  const path = `/repos/${content.repository.nameWithOwner}/issues/${content.number}/labels`;
  if (blocked && !have.includes(BLOCKED_LABEL)) {
    await rest("POST", path, { labels: [BLOCKED_LABEL] });
    counts.labels += 1;
  } else if (!blocked && have.includes(BLOCKED_LABEL)) {
    await rest("DELETE", `${path}/${BLOCKED_LABEL}`);
    counts.labels += 1;
  }
  if (!project.blocked) return;
  const isSet = item.blocked?.name === BLOCKED_OPTION;
  if (blocked && !isSet) {
    const option = project.blocked.options.find((/** @type {{ name: string }} */ o) => o.name === BLOCKED_OPTION);
    if (!option) throw new Error(`the Blocked field has no option named ${BLOCKED_OPTION}`);
    await graphql(SET_STATUS, { project: project.id, item: item.id, field: project.blocked.id, option: option.id });
  } else if (!blocked && isSet) {
    await graphql(CLEAR_FIELD, { project: project.id, item: item.id, field: project.blocked.id });
  }
}

const items = added > 0 ? await all(ITEMS, { org: ORG, number: PROJECT_NUMBER }, pickItems) : before;
let moved = 0;
for (const item of items) {
  if (!item.content?.id || !TRUSTED_AUTHORS.has(item.content.authorAssociation)) continue;
  const current = item.status?.name ?? TODO;
  const status = derivedStatus(item.content, current);
  const option = optionId.get(status);
  if (!option) throw new Error(`the Status field has no option named ${status}`);
  // One item that fails must not stop the others; the run still ends with an error.
  try {
    if (status !== current) {
      await graphql(SET_STATUS, { project: project.id, item: item.id, field: project.field.id, option });
      moved += 1;
    }
    await setStageLabel(item.content, status);
    if (item.content.blockedBy) await setBlocked(item, await syncBlockers(item.content));
  } catch (error) {
    if (writes > MAX_WRITES) throw error;
    counts.failures += 1;
  }
}
console.log(
  `${added} added, ${moved} moved, ${counts.labels} labels changed, ${counts.links} links added, ` +
    `${counts.failures} failed, ${items.length} items, ${open.length} open`,
);
if (counts.failures > 0) process.exitCode = 1;
