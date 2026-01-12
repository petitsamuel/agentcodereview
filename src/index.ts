import * as core from '@actions/core'
import * as github from '@actions/github'

interface ReviewComment {
  id: number
  path: string
  line: number | null
  body: string
  user: string
  url: string
  createdAt: string
  isResolved: boolean
}

interface Review {
  id: number
  body: string
  user: string
  state: string
  url: string
  submittedAt: string
}

interface AggregatedFeedback {
  prNumber: number
  prTitle: string
  prUrl: string
  openComments: ReviewComment[]
  resolvedComments: ReviewComment[]
  reviews: Review[]
  updatedAt: string
}

function isIgnoredBotComment(body: string): boolean {
  const lowerBody = body.toLowerCase()
  // Ignore CodeRabbit rate limit warnings
  if (lowerBody.includes('rate limit') && lowerBody.includes('coderabbit')) {
    return true
  }
  return false
}

function parseGreptileComments(
  commentId: number,
  body: string,
  user: string,
  url: string,
  createdAt: string
): ReviewComment[] {
  const comments: ReviewComment[] = []

  // Match Greptile's structured format inside "Prompt To Fix With AI" blocks:
  // Path: <filepath>
  // Line: <line>:<line>
  // Comment:
  // <comment text>
  const promptBlockRegex = /<details><summary>Prompt To Fix With AI<\/summary>\s*`{3,5}markdown\s*([\s\S]*?)`{3,5}\s*<\/details>/gi

  let blockMatch
  while ((blockMatch = promptBlockRegex.exec(body)) !== null) {
    const blockContent = blockMatch[1]

    // Parse the structured content
    const pathMatch = blockContent.match(/Path:\s*(.+)/i)
    const lineMatch = blockContent.match(/Line:\s*(\d+)(?::\d+)?/i)
    const commentMatch = blockContent.match(/Comment:\s*([\s\S]*?)(?:How can I resolve|$)/i)

    if (pathMatch && commentMatch) {
      const path = pathMatch[1].trim()
      const line = lineMatch ? parseInt(lineMatch[1], 10) : null
      const commentText = commentMatch[1].trim()

      comments.push({
        id: commentId + comments.length, // Generate unique IDs
        path,
        line,
        body: commentText,
        user,
        url,
        createdAt,
        isResolved: false,
      })
    }
  }

  return comments
}

async function fetchGreptileCommentsFromIssueComments(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ReviewComment[]> {
  const { data: issueComments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  })

  const greptileComments: ReviewComment[] = []

  for (const comment of issueComments) {
    const user = comment.user?.login || 'unknown'
    // Check if this is a Greptile bot comment with structured feedback
    if (user === 'greptile-apps[bot]' && comment.body?.includes('Prompt To Fix With AI')) {
      const parsed = parseGreptileComments(
        comment.id,
        comment.body,
        user,
        comment.html_url,
        comment.created_at
      )
      greptileComments.push(...parsed)
    }
  }

  return greptileComments
}

async function fetchReviewComments(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ReviewComment[]> {
  const comments: ReviewComment[] = []

  // Fetch review comments (inline comments on code)
  const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })

  for (const comment of reviewComments) {
    // Check if comment is part of a resolved conversation
    // GitHub API doesn't directly expose this, but we can check via GraphQL
    comments.push({
      id: comment.id,
      path: comment.path,
      line: comment.line || comment.original_line || null,
      body: comment.body,
      user: comment.user?.login || 'unknown',
      url: comment.html_url,
      createdAt: comment.created_at,
      isResolved: false, // Will be updated via GraphQL if possible
    })
  }

  return comments
}

async function fetchResolvedStatus(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  comments: ReviewComment[]
): Promise<ReviewComment[]> {
  // Use GraphQL to get resolved status of review threads
  try {
    const query = `
      query($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                comments(first: 1) {
                  nodes {
                    databaseId
                  }
                }
              }
            }
          }
        }
      }
    `

    const result: any = await octokit.graphql(query, {
      owner,
      repo,
      prNumber,
    })

    const resolvedThreadIds = new Set<number>()
    const threads = result.repository.pullRequest.reviewThreads.nodes

    for (const thread of threads) {
      if (thread.isResolved && thread.comments.nodes.length > 0) {
        resolvedThreadIds.add(thread.comments.nodes[0].databaseId)
      }
    }

    // Update comments with resolved status
    return comments.map((comment) => ({
      ...comment,
      isResolved: resolvedThreadIds.has(comment.id),
    }))
  } catch (error) {
    core.warning(`Could not fetch resolved status via GraphQL: ${error}`)
    return comments
  }
}

async function fetchReviews(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<Review[]> {
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })

  return reviews
    .filter((review: { body?: string | null }) => review.body && review.body.trim() !== '')
    .map((review: { id: number; body?: string | null; user?: { login?: string } | null; state: string; html_url: string; submitted_at?: string | null }) => ({
      id: review.id,
      body: review.body || '',
      user: review.user?.login || 'unknown',
      state: review.state,
      url: review.html_url,
      submittedAt: review.submitted_at || '',
    }))
}

function generateMarkdown(feedback: AggregatedFeedback, includeResolved: boolean): string {
  const lines: string[] = []

  lines.push(`# PR #${feedback.prNumber} Review Feedback`)
  lines.push('')
  lines.push(`> **For AI coding assistants:** Fix all unchecked items below. Each item includes`)
  lines.push(`> the file path, line number, reviewer, and their feedback.`)
  lines.push('>')
  lines.push(`> **PR:** [${feedback.prTitle}](${feedback.prUrl})`)
  lines.push(`> **Last updated:** ${feedback.updatedAt}`)
  lines.push('')

  const openCount = feedback.openComments.length
  const resolvedCount = feedback.resolvedComments.length

  lines.push(`**Status:** ${openCount} open issue${openCount !== 1 ? 's' : ''}`)
  if (includeResolved && resolvedCount > 0) {
    lines.push(` | ${resolvedCount} resolved`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  // Group open comments by file
  if (openCount > 0) {
    lines.push('## Open Issues')
    lines.push('')

    const byFile = groupByFile(feedback.openComments)

    for (const [filePath, comments] of Object.entries(byFile)) {
      lines.push(`### \`${filePath}\``)
      lines.push('')

      for (const comment of comments) {
        const lineInfo = comment.line ? `Line ${comment.line}` : 'General'
        lines.push(`- [ ] **${lineInfo}** · @${comment.user}`)
        lines.push('')
        // Indent the comment body as a blockquote
        const bodyLines = comment.body.split('\n')
        for (const bodyLine of bodyLines) {
          lines.push(`  > ${bodyLine}`)
        }
        lines.push('')
      }
    }
  } else {
    lines.push('## No Open Issues')
    lines.push('')
    lines.push('All review comments have been resolved!')
    lines.push('')
  }

  // Include resolved comments if requested
  if (includeResolved && resolvedCount > 0) {
    lines.push('---')
    lines.push('')
    lines.push('## Resolved')
    lines.push('')

    for (const comment of feedback.resolvedComments) {
      const location = comment.line
        ? `\`${comment.path}:${comment.line}\``
        : `\`${comment.path}\``
      lines.push(`- [x] ~~${location} · @${comment.user}~~`)
    }
    lines.push('')
  }

  // Include review bodies (high-level feedback)
  const significantReviews = feedback.reviews.filter(
    (r: Review) => r.body.length > 20 && r.state !== 'PENDING'
  )

  if (significantReviews.length > 0) {
    lines.push('---')
    lines.push('')
    lines.push('## Review Summaries')
    lines.push('')

    for (const review of significantReviews) {
      const stateEmoji =
        review.state === 'APPROVED'
          ? ''
          : review.state === 'CHANGES_REQUESTED'
            ? ''
            : ''
      lines.push(`### ${stateEmoji} @${review.user} (${review.state.toLowerCase().replace('_', ' ')})`)
      lines.push('')
      const bodyLines = review.body.split('\n')
      for (const bodyLine of bodyLines) {
        lines.push(`> ${bodyLine}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function groupByFile(comments: ReviewComment[]): Record<string, ReviewComment[]> {
  const groups: Record<string, ReviewComment[]> = {}

  for (const comment of comments) {
    const path = comment.path || 'general'
    if (!groups[path]) {
      groups[path] = []
    }
    groups[path].push(comment)
  }

  // Sort comments within each file by line number
  for (const path of Object.keys(groups)) {
    groups[path].sort((a, b) => (a.line || 0) - (b.line || 0))
  }

  return groups
}

async function findExistingComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number | null> {
  const marker = '<!-- AGENT_CODE_REVIEW_FEEDBACK -->'

  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  })

  const existing = comments.find((c: { body?: string }) => c.body?.includes(marker))
  return existing?.id || null
}

async function postOrUpdateComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  markdown: string
): Promise<void> {
  const marker = '<!-- AGENT_CODE_REVIEW_FEEDBACK -->'
  const body = `${marker}\n${markdown}`

  const existingId = await findExistingComment(octokit, owner, repo, prNumber)

  if (existingId) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingId,
      body,
    })
    core.info(`Updated existing comment ${existingId}`)
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    })
    core.info('Created new comment')
  }
}

async function commitFeedbackFile(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  content: string,
  prNumber: number
): Promise<void> {
  // Check if file exists
  let sha: string | undefined

  try {
    const { data: existingFile } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: branch,
    })

    if ('sha' in existingFile) {
      sha = existingFile.sha
    }
  } catch (error: any) {
    if (error.status !== 404) {
      throw error
    }
    // File doesn't exist, that's fine
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: `chore: update review feedback for PR #${prNumber} [skip ci]`,
    content: Buffer.from(content).toString('base64'),
    branch,
    sha,
  })

  core.info(`Committed feedback file to ${filePath}`)
}

async function deleteFeedbackFile(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  prNumber: number
): Promise<void> {
  try {
    const { data: existingFile } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: branch,
    })

    if ('sha' in existingFile) {
      await octokit.rest.repos.deleteFile({
        owner,
        repo,
        path: filePath,
        message: `chore: remove review feedback (all resolved) for PR #${prNumber} [skip ci]`,
        sha: existingFile.sha,
        branch,
      })
      core.info(`Deleted feedback file ${filePath}`)
    }
  } catch (error: any) {
    if (error.status !== 404) {
      throw error
    }
    // File doesn't exist, nothing to delete
  }
}

async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true })
    const feedbackFilePath = core.getInput('feedback-file')
    const postComment = core.getInput('post-comment') === 'true'
    const includeResolved = core.getInput('include-resolved') === 'true'

    const octokit = github.getOctokit(token)
    const context = github.context

    // Get PR info
    const prNumber =
      context.payload.pull_request?.number ||
      context.payload.issue?.number

    if (!prNumber) {
      core.setFailed('Could not determine PR number from context')
      return
    }

    const owner = context.repo.owner
    const repo = context.repo.repo

    // Fetch PR details
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    })

    const branch = pr.head.ref

    core.info(`Processing PR #${prNumber}: ${pr.title}`)

    // Fetch all review data
    let comments = await fetchReviewComments(octokit, owner, repo, prNumber)
    comments = await fetchResolvedStatus(octokit, owner, repo, prNumber, comments)
    const reviews = await fetchReviews(octokit, owner, repo, prNumber)

    // Fetch structured comments from Greptile bot issue comments
    const greptileComments = await fetchGreptileCommentsFromIssueComments(octokit, owner, repo, prNumber)
    if (greptileComments.length > 0) {
      core.info(`Found ${greptileComments.length} Greptile comments from issue comments`)
    }

    // Merge Greptile comments with review comments
    comments = [...comments, ...greptileComments]

    // Filter out ignored bot comments (e.g., CodeRabbit rate limit warnings)
    comments = comments.filter((c) => !isIgnoredBotComment(c.body))
    const filteredReviews = reviews.filter((r) => !isIgnoredBotComment(r.body))

    const openComments = comments.filter((c) => !c.isResolved)
    const resolvedComments = comments.filter((c) => c.isResolved)

    const feedback: AggregatedFeedback = {
      prNumber,
      prTitle: pr.title,
      prUrl: pr.html_url,
      openComments,
      resolvedComments,
      reviews: filteredReviews,
      updatedAt: new Date().toISOString(),
    }

    core.info(`Found ${openComments.length} open, ${resolvedComments.length} resolved comments`)

    // Generate markdown
    const markdown = generateMarkdown(feedback, includeResolved)

    // Post/update PR comment
    if (postComment) {
      await postOrUpdateComment(octokit, owner, repo, prNumber, markdown)
    }

    // Commit feedback file
    if (feedbackFilePath) {
      if (openComments.length === 0) {
        // No open comments - delete the file if it exists
        await deleteFeedbackFile(octokit, owner, repo, branch, feedbackFilePath, prNumber)
      } else {
        await commitFeedbackFile(octokit, owner, repo, branch, feedbackFilePath, markdown, prNumber)
      }
    }

    // Set outputs
    core.setOutput('open-count', openComments.length)
    core.setOutput('resolved-count', resolvedComments.length)
    core.setOutput('feedback-file', feedbackFilePath)

    core.info('Done!')
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('An unknown error occurred')
    }
  }
}

run()
