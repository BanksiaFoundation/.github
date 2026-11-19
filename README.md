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

GitHub uses the templates for every repository that has no template of its own. Labels do not spread this way: run `node scripts/sync-labels.mjs` after you change `labels.json`, or pass one repository, such as `node scripts/sync-labels.mjs OWNER/REPO`.

The scripts are plain JavaScript for Node 24 with JSDoc types and `// @ts-check`. They need no install and no build.

## The project sync

Status follows the pull requests: a closed issue or a merged or closed pull request is Done, an open pull request in review is In review, a draft pull request is In progress, and an item with no pull request stays where a person put it. A reopened issue on Done goes back to Todo. Each item then carries one stage label: `in-progress`, `in-review` or `done`. Todo carries none.

The workflow needs a GitHub App installed on every repository of the organization, with these permissions: Issues read and write, Pull requests read and write, Organization projects read and write. Store its client id as the variable `PROJECT_APP_CLIENT_ID` and its private key as the secret `PROJECT_APP_PRIVATE_KEY` in this repository.
