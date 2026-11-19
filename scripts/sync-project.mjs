// @ts-check
/**
 * Adds every open issue and pull request of the organization to its project.
 *
 * Usage: GH_TOKEN=... node scripts/sync-project.mjs. The token needs read access to the
 * issues and pull requests of every repository and write access to the organization's
 * projects. Items already in the project stay as they are, and nothing is removed.
 */

const API = "https://api.github.com/graphql";
const ORG = process.env.ORG ?? "BanksiaFoundation";
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER ?? "1");
const PAGE_SIZE = 100;

/**
 * @param {string} query
 * @param {Record<string, unknown>} variables
 * @returns {Promise<any>}
 */
async function graphql(query, variables) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GH_TOKEN is not set");
  const response = await fetch(API, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors) {
    throw new Error(`GitHub answered ${response.status}: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
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

const PROJECT = `query($org: String!, $number: Int!, $after: String) {
  organization(login: $org) { projectV2(number: $number) { id
    items(first: ${PAGE_SIZE}, after: $after) {
      nodes { content { ... on Issue { id } ... on PullRequest { id } } }
      pageInfo { hasNextPage endCursor } } } } }`;

// Issue search returns at most 1000 results for one query.
const OPEN = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
    nodes { ... on Issue { id url } ... on PullRequest { id url } }
    pageInfo { hasNextPage endCursor } } }`;

const ADD = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`;

const head = await graphql(PROJECT, { org: ORG, number: PROJECT_NUMBER, after: null });
const projectId = head.organization.projectV2.id;
const items = await all(PROJECT, { org: ORG, number: PROJECT_NUMBER },
  (data) => data.organization.projectV2.items);
const held = new Set(items.map((item) => item.content?.id).filter(Boolean));
const open = await all(OPEN, { q: `org:${ORG} is:open archived:false` }, (data) => data.search);

let added = 0;
for (const node of open) {
  if (!node.id || held.has(node.id)) continue;
  await graphql(ADD, { project: projectId, content: node.id });
  added += 1;
  console.log(`added ${node.url}`);
}
console.log(`${added} added, ${open.length} open, ${held.size} already in the project`);
