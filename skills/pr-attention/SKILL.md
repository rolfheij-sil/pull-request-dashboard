---
name: pr-attention
description: Use when the user asks what needs their attention, which pull requests are in their court, what to review or merge next, or wants to nudge the Claude Code sessions working on those PRs or start a session for a PR that has none. Reads the local PR dashboard.
---

# PR attention

Summarise what needs the user's attention from the local PR dashboard, and help act on it.
The dashboard is a local web app; its board is the source of truth for whose court each PR
is in and which Claude Code sessions are linked to it.

## 1. Fetch the board

Run `curl -s http://127.0.0.1:5174/api/board` (5174 is the dashboard's default `PORT`; use
the user's port if they gave one). Parse the JSON.

If the request fails or returns something that is not JSON, tell the user the dashboard
does not appear to be running and that it is started with `npm run dev` in the
pull-request-dashboard checkout. Stop there; do not guess at PR state.

If `stale` is true or `error` is set, say so in one line before the summary: the data may be
old.

Board shape, for reference: `items` are the user's own PRs, `reviewing` are other people's
PRs the user has reviewed or commented on. Each item has `repo`, `number`, `title`, `url`,
`author`, `bucket`, `receipts` (the evidence behind the bucket), `sessions` (linked Claude
Code sessions: `id`, `sessionId`, `name`, `status`, `state`, `kind`, `claudeAiUrl`), and
`canStartSession`. `sessionsError` is set when the session list could not be read; then
`sessions` is empty everywhere and that says nothing about whether sessions exist.

## 2. List what needs the user

Show the items in the user's court, grouped like the dashboard:

- Own PRs (`items`) in bucket `blocked-mechanically` (conflict or failing check),
  `needs-your-response`, or `ready-to-merge`.
- Others' PRs (`reviewing`) in bucket `review-needs-you` (waiting on the user's review).

For each, one line with `repo#number`, the title, and the URL, then its receipts (short),
then its linked sessions as `name (status)`, or "no session" when there are none. Say
"Nothing waiting on you" when all of these are empty.

Finish with one short line counting the rest (for example "3 waiting on reviewers, 1 draft,
2 you approved"), without listing them.

Keep the whole summary concise; it is a status check, not a report.

## 3. Nudge linked sessions

For each in-court item that has a live linked session (`status` is `busy`, `waiting` or
`idle`), draft a one-paragraph message to that session: what changed on its PR according to
the receipts, what is now expected of the session, and the PR link. Show every draft,
labelled with the session name and its PR.

Send a draft with the SendMessage tool only after the user approves that specific message,
or approves an explicitly named batch ("send all of these"). Never send anything
unprompted, and never send a message the user has not seen. If a session has no live
process, do not try to message it; offer to start a new one instead (step 4).

## 4. Dispatch new sessions

For each in-court item with no linked session and `canStartSession` true, offer to start a
session for it. Only after the user approves that PR (or a named batch), run:

```bash
curl -s -X POST -H 'x-pr-dashboard: 1' http://127.0.0.1:5174/api/pr/<owner>/<name>/<number>/start-session
```

and report the `output` it returns, or its `error`. The server accepts one start per PR per
minute and answers 429 inside that window; report that rather than retrying. Never start a
session without approval.
