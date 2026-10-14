const PR_FIELDS = `
  number
  title
  url
  isDraft
  author { login }
  updatedAt
  mergeable
  mergeStateStatus
  reviews(last: 100) {
    nodes { id state submittedAt bodyText lastEditedAt author { login } }
  }
  comments(last: 100) { nodes { createdAt author { login } } }
  reviewThreads(last: 100) {
    nodes {
      isResolved
      comments(last: 1) { nodes { createdAt author { login } } }
    }
  }
  commits(last: 50) {
    nodes {
      commit {
        oid
        committedDate
        messageHeadline
        parents { totalCount }
        author { user { login } email }
      }
    }
  }
  headRefOid
  headRefName
  isCrossRepository
  statusCheckRollup: commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            }
          }
        }
      }
    }
  }
`;

export const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${PR_FIELDS} }
  }
}`;

export const LIST_QUERY = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;
