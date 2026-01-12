# Agent Code Review Feedback

A GitHub Action that aggregates PR review comments into a structured format optimized for AI coding assistants (Claude Code, Cursor, ChatGPT Codex, etc.).

## The Problem

When using AI coding assistants to fix PR review feedback, you typically:
1. Make changes via an AI tool
2. Create a PR
3. Wait for reviewers (CodeRabbit, Greptile, humans) to comment
4. Manually copy comments into your AI tool
5. Repeat

This action automates step 4 by aggregating all review comments into:
- A **PR comment** (easy to copy/paste)
- A **file in the branch** (AI tools can read directly)

## Usage

Add this workflow to your repository:

```yaml
# .github/workflows/review-feedback.yml
name: Review Feedback

on:
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created, edited, deleted]

# Debounce: if multiple comments come in quickly, only run once
concurrency:
  group: review-feedback-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  aggregate:
    runs-on: ubuntu-latest
    # Don't run on empty reviews (just approvals without comments)
    if: |
      github.event_name == 'pull_request_review_comment' ||
      (github.event_name == 'pull_request_review' && github.event.review.body != '')

    steps:
      - uses: petitsamuel/agentcodereview@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## What It Does

When review comments are added to a PR:

1. **Fetches all review comments** (inline code comments + review bodies)
2. **Checks resolved status** via GraphQL API
3. **Generates structured markdown** grouped by file
4. **Posts/updates a PR comment** with the aggregated feedback
5. **Commits a feedback file** to the branch (optional)

When all comments are resolved, the feedback file is automatically deleted.

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `github-token` | GitHub token for API access | `${{ github.token }}` |
| `feedback-file` | Path for feedback file (empty to disable) | `.github/REVIEW_FEEDBACK.md` |
| `post-comment` | Post/update PR comment | `true` |
| `include-resolved` | Include resolved items (as checked) | `true` |

## Outputs

| Output | Description |
|--------|-------------|
| `open-count` | Number of open review comments |
| `resolved-count` | Number of resolved comments |
| `feedback-file` | Path to feedback file (if created) |

## Generated Feedback Format

```markdown
# PR #123 Review Feedback

> **For AI coding assistants:** Fix all unchecked items below.
>
> **PR:** [Add user authentication](https://github.com/...)
> **Last updated:** 2024-01-15T10:30:00Z

**Status:** 3 open issues | 1 resolved

---

## Open Issues

### `src/api/handler.go`

- [ ] **Line 45** · @coderabbitai

  > Missing error handling - this could panic if `user` is nil

- [ ] **Line 78** · @greptile

  > Consider using constants instead of magic strings

### `src/api/routes.go`

- [ ] **Line 12** · @alice

  > Should we add rate limiting here?

---

## Resolved

- [x] ~~`src/main.go:30` · @coderabbitai~~
```

## Using with AI Tools

### Claude Code / Cursor / VS Code

Just tell your AI tool:
> "Read .github/REVIEW_FEEDBACK.md and fix all the open issues"

### Claude Code (Web) / ChatGPT

Copy the feedback from the PR comment and paste it into your chat.

### Automated (Claude Code CLI)

```bash
# Fetch and fix in one command
gh pr view 123 --json comments --jq '.comments[] | select(.body | contains("AGENT_CODE_REVIEW"))' | \
  claude "Fix all the issues in this review feedback"
```

## License

MIT
