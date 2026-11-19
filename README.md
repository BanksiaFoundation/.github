# .github

Shared files for every repository of this organization.

| Path | What it does |
|---|---|
| `ISSUE_TEMPLATE/` | The issue forms: bug, feature and task. Blank issues are off. |
| `pull_request_template.md` | The pull request body: Summary, then Notes for reviewers and Related work when they have content. |
| `labels.json` | The labels every repository carries. |
| `scripts/sync-labels.mjs` | Creates or updates those labels. It deletes none. |
| `scripts/sync-project.mjs` | Adds every open issue and pull request of the organization to its project, moves Status from linked pull requests, and sets the stage labels. It removes no item. |
| `.github/workflows/sync-project.yml` | Runs the project sync every 15 minutes. |

GitHub uses the templates for every repository that has no template of its own. Labels do not spread this way: run `node scripts/sync-labels.mjs` after you change `labels.json`.

The scripts are plain JavaScript for Node 24 with JSDoc types and `// @ts-check`. They need no install and no build.

## The project sync

Status follows the pull requests: a closed issue or a merged or closed pull request is Done, an open pull request in review is In review, a draft pull request is In progress, and an item with no pull request stays where a person put it. A reopened issue on Done goes back to Todo. Each item then carries one stage label: `in-progress`, `in-review` or `done`. Todo carries none.

Dependencies use GitHub's own "blocked by" links, set in an issue's sidebar. A line in an issue body such as `Blocked by #12` or `Depends on OWNER/REPO#12` makes the sync add the link when the repository belongs to this organization, and the sync removes none. An issue with an open blocker gets the `blocked` label and `Yes` in the Blocked field, and both clear when the last blocker closes. The Blocked view lists them.

The workflow needs a GitHub App installed on every repository of the organization, with these permissions: Issues read and write, Pull requests read and write, Organization projects read and write. Store its client id as the variable `PROJECT_APP_CLIENT_ID` and its private key as the secret `PROJECT_APP_PRIVATE_KEY` in this repository.

## Safety

This repository is public, and so are its Actions logs. The scripts take no arguments and no settings: they act on the organization that owns this repository, found from `GITHUB_REPOSITORY_OWNER` in Actions and from the `origin` remote on a computer. The sync logs counts only, never an issue, a pull request or a response body from a private repository. It acts only on items opened by an owner, a member or a collaborator, which leaves out issues from strangers on public repositories and pull requests from bots. It stops a run after 500 writes, and each request times out after 30 seconds. The workflow runs on a schedule or a manual start only, never on a pull request, so code from a fork never runs with the App key.
