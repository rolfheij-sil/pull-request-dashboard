import { fillTemplate } from './template.js';

export const DEFAULT_START_PROMPT =
  'Look at {url} ({title}). Tell me what it needs from me next.';

const SESSION_NAME_TITLE_CHARS = 60;

export interface StartTarget {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
}

export interface StartPreview {
  /** The name the new session gets. */
  name: string;
  /** The first prompt the new session receives. */
  prompt: string;
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** What "Start session" would create for a PR: the session's name and its first prompt. */
export function startPreview(item: StartTarget, startPrompt: string | undefined): StartPreview {
  const repoName = item.repo.split('/')[1] ?? item.repo;
  return {
    name: `${repoName} #${item.number} ${truncate(item.title, SESSION_NAME_TITLE_CHARS)}`,
    prompt: fillTemplate(startPrompt ?? DEFAULT_START_PROMPT, {
      url: item.url,
      title: item.title,
      repo: item.repo,
      number: String(item.number),
      author: item.author,
    }),
  };
}
