# .github

Shared files for every repository of this organization.

| Path | What it does |
|---|---|
| `ISSUE_TEMPLATE/` | The issue forms: bug, feature and task. Blank issues are off. |
| `pull_request_template.md` | The pull request body: Summary, then Notes for reviewers and Related work when they have content. |
| `labels.yml` | The labels every repository carries. |
| `scripts/sync-labels.py` | Creates or updates those labels. It deletes none. |

GitHub uses the templates for every repository that has no template of its own. Labels do not spread this way: run `scripts/sync-labels.py` after you change `labels.yml`, or pass one repository, such as `scripts/sync-labels.py OWNER/REPO`.
