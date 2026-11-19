// @ts-check
/**
 * Keeps the organization project and the stage labels in step.
 *
 * Usage: GH_TOKEN=... node scripts/sync-project.mjs. Each run does three things:
 * 1. adds every open issue and pull request of the organization to the project;
 * 2. moves an item's Status from its pull requests, and leaves an item with no pull
 *    request where a person put it;
 * 3. puts the stage label of each item's Status on the issue or pull request and takes
 *    the other stage labels off.
 * The token needs read access to every repository, write access to issues and pull
 * requests for labels, and write access to the organization's projects. Nothing is
 * removed from the project.
 */

const GRAPHQL = "https://api.github.com/graphql";
const REST = "https://api.github.com";
const ORG = process.env.ORG ?? "BanksiaFoundation";
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER ?? "1");
const PAGE_SIZE = 50;
const LINKED_PRS = 20;
const LABELS_READ = 50;

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
  const response = await fetch(GRAPHQL, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors) {
    throw new Error(`GitHub answered ${response.status}: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

/**
 * @param {"POST" | "DELETE"} method
 * @param {string} path
 * @param {unknown} [body]
 */
async function rest(method, path, body) {
  const response = await fetch(`${REST}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, accept: "application/vnd.github+json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // A label that is already gone answers 404, which is the state we want.
  if (!response.ok && !(method === "DELETE" && response.status === 404)) {
    throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
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
  id number url state
  repository { nameWithOwner }
  labels(first: ${LABELS_READ}) { nodes { name } }`;

const ITEMS = `query($org: String!, $number: Int!, $after: String) {
  organization(login: $org) { projectV2(number: $number) {
    items(first: ${PAGE_SIZE}, after: $after) {
      nodes { id
        status: fieldValueByName(name: "Status") {
          ... on ProjectV2ItemFieldSingleSelectValue { name } }
        content {
          ... on Issue { ${CONTENT}
            closedByPullRequestsReferences(first: ${LINKED_PRS}, includeClosedPrs: true) {
              nodes { state isDraft } } }
          ... on PullRequest { ${CONTENT} isDraft } } }
      pageInfo { hasNextPage endCursor } } } } }`;

const PROJECT = `query($org: String!, $number: Int!) {
  organization(login: $org) { projectV2(number: $number) { id
    field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`;

// Issue search returns at most 1000 results for one query.
const OPEN = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
    nodes { ... on Issue { id url } ... on PullRequest { id url } }
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
    (/** @type {{ state: string }} */ pr) => pr.state === "OPEN",
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
      console.log(`unlabelled ${name} ${content.url}`);
    }
  }
  if (want && !have.includes(want)) {
    await rest("POST", path, { labels: [want] });
    console.log(`labelled ${want} ${content.url}`);
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
  if (!node.id || held.has(node.id)) continue;
  await graphql(ADD, { project: project.id, content: node.id });
  added += 1;
  console.log(`added ${node.url}`);
}

const items = added > 0 ? await all(ITEMS, { org: ORG, number: PROJECT_NUMBER }, pickItems) : before;
let moved = 0;
for (const item of items) {
  if (!item.content?.id) continue;
  const current = item.status?.name ?? TODO;
  const status = derivedStatus(item.content, current);
  if (status !== current) {
    const option = optionId.get(status);
    if (!option) throw new Error(`the Status field has no option named ${status}`);
    await graphql(SET_STATUS, { project: project.id, item: item.id, field: project.field.id, option });
    moved += 1;
    console.log(`moved ${current} -> ${status} ${item.content.url}`);
  }
  await setStageLabel(item.content, status);
}
console.log(`${added} added, ${moved} moved, ${items.length} items, ${open.length} open`);
