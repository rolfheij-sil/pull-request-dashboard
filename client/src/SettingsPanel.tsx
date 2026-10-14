import { useEffect, useRef, useState, type FormEvent } from 'react';
import { fetchSetup, redetectSetup, saveSetup, SetupSaveError, type SetupResponse } from './api';
import {
  buildPatch, draftFrom, platformLabel, primaryActionChoices, type SettingsDraft,
} from './sessions';

const PLACEHOLDERS = '{url} {title} {repo} {number} {author}';

function FieldError({ message }: { message: string | undefined }) {
  return message === undefined ? null : <p className="field-error" role="alert">{message}</p>;
}

/** The settings dialog: what was detected, and the few choices the page may save. */
export function SettingsPanel({ open, repos, onClose, onSaved }: {
  open: boolean;
  /** Lowercased `owner/name` of every repo on the board. */
  repos: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const adopt = (next: SetupResponse) => {
    setSetup(next);
    setDraft(draftFrom(next));
  };

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      element.showModal();
      setErrors({});
      setStatus(null);
      fetchSetup().then(adopt).catch(() => setStatus('Could not load the settings.'));
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (setup === null || draft === null) return;
    setBusy(true);
    setErrors({});
    setStatus(null);
    try {
      adopt(await saveSetup(buildPatch(setup, draft, repos)));
      setStatus('Saved.');
      onSaved();
    } catch (error) {
      if (error instanceof SetupSaveError) setErrors(error.errors);
      else setStatus('Could not save the settings.');
    } finally {
      setBusy(false);
    }
  };

  const redetect = async () => {
    setBusy(true);
    setStatus(null);
    try {
      adopt(await redetectSetup());
      setStatus('Detected again.');
      onSaved();
    } catch {
      setStatus('Could not detect again.');
    } finally {
      setBusy(false);
    }
  };

  const locked = (field: string) => setup?.lockedByConfig.includes(field) ?? false;
  const hasTerminal = setup !== null
    && (setup.detected.terminals.length > 0 || setup.effective.openTerminalSource === 'config');

  return (
    <dialog
      ref={dialog}
      className="settings"
      aria-labelledby="settings-title"
      onClose={onClose}
    >
      <form onSubmit={(event) => void save(event)}>
        <h2 id="settings-title">Claude Code sessions</h2>

        {(setup === null || draft === null) ? (
          <p>{status ?? 'Loading…'}</p>
        ) : (
          <>
            <section aria-labelledby="settings-detected">
              <h3 id="settings-detected">Detected on this machine</h3>
              <dl className="detected">
                <dt>Platform</dt>
                <dd>{platformLabel(setup.detected.platform, setup.detected.wslDistro)}</dd>
                <dt>Claude Code</dt>
                <dd>
                  {setup.detected.claude.path === null
                    ? `Not found — ${setup.detected.claude.reason ?? 'unknown reason'}`
                    : `${setup.detected.claude.path}${setup.detected.claude.version === null ? '' : ` (${setup.detected.claude.version})`}`}
                </dd>
                {setup.detected.claude.candidates.length > 1 && (
                  <>
                    <dt />
                    <dd className="hint">
                      Also found, not used:{' '}
                      {setup.detected.claude.candidates
                        .filter((c) => c.path !== setup.detected.claude.path)
                        .map((c) => `${c.path} (${c.version})`).join('; ')}
                    </dd>
                  </>
                )}
                <dt>Terminals</dt>
                <dd>
                  {setup.detected.terminals.length === 0
                    ? 'None found'
                    : setup.detected.terminals.map((t) => t.label).join(', ')}
                </dd>
                <dt>Desktop app</dt>
                <dd>{setup.detected.desktopResume ? 'Available' : 'Not available on this platform'}</dd>
              </dl>
              <button type="button" className="session-button" disabled={busy} onClick={() => void redetect()}>
                Re-detect
              </button>
            </section>

            <fieldset>
              <legend>Main button on a session</legend>
              {primaryActionChoices(hasTerminal, setup.detected.desktopResume).map((choice) => (
                <label key={choice.id} className="choice">
                  <input
                    type="radio"
                    name="primaryAction"
                    value={choice.id}
                    checked={draft.primaryAction === choice.id}
                    disabled={choice.disabledReason !== null}
                    onChange={() => setDraft({ ...draft, primaryAction: choice.id })}
                  />
                  {' '}{choice.label}
                  {choice.disabledReason !== null && (
                    <span className="hint"> — {choice.disabledReason}</span>
                  )}
                </label>
              ))}
              <FieldError message={errors.primaryAction} />
            </fieldset>

            <label className="field">
              <span>Terminal</span>
              {locked('terminalPreset') ? (
                <span className="hint">Set in config.json</span>
              ) : (
                <select
                  value={draft.terminalPreset}
                  disabled={setup.detected.terminals.length === 0}
                  onChange={(event) => setDraft({ ...draft, terminalPreset: event.target.value })}
                >
                  {setup.detected.terminals.length === 0 && <option value="">None detected</option>}
                  {setup.detected.terminals.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              )}
            </label>
            <FieldError message={errors.terminalPreset} />

            <fieldset>
              <legend>Repo folders (for Start session)</legend>
              {repos.length === 0 && <p className="hint">No PRs on the board yet.</p>}
              {repos.map((repo) => {
                const candidates = setup.detected.repoClones[repo] ?? [];
                const isLocked = locked(`repoPaths.${repo}`);
                return (
                  <div key={repo} className="repo-row">
                    <span className="repo-name">{repo}</span>
                    {isLocked && <span className="hint">Set in config.json</span>}
                    {!isLocked && candidates.length > 0 && (
                      <select
                        aria-label={`Detected folders for ${repo}`}
                        value=""
                        onChange={(event) => {
                          if (event.target.value !== '') {
                            setDraft({ ...draft, repoPaths: { ...draft.repoPaths, [repo]: event.target.value } });
                          }
                        }}
                      >
                        <option value="">Pick a detected folder…</option>
                        {candidates.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
                      </select>
                    )}
                    <input
                      type="text"
                      aria-label={`Folder for ${repo}`}
                      placeholder="/path/to/clone"
                      value={draft.repoPaths[repo] ?? ''}
                      readOnly={isLocked}
                      onChange={(event) => setDraft({
                        ...draft, repoPaths: { ...draft.repoPaths, [repo]: event.target.value },
                      })}
                    />
                    <FieldError message={errors[`repoPaths.${repo}`]} />
                  </div>
                );
              })}
              <FieldError message={errors.repoPaths} />
            </fieldset>

            <label className="field">
              <span>Start prompt</span>
              {locked('startPrompt') && <span className="hint">Set in config.json</span>}
              <textarea
                rows={3}
                maxLength={2000}
                value={draft.startPrompt}
                readOnly={locked('startPrompt')}
                aria-describedby="settings-placeholders"
                onChange={(event) => setDraft({ ...draft, startPrompt: event.target.value })}
              />
            </label>
            <p id="settings-placeholders" className="hint">Placeholders: {PLACEHOLDERS}</p>
            <FieldError message={errors.startPrompt} />
            <FieldError message={errors.body} />

            {status !== null && <p className="hint" role="status">{status}</p>}
          </>
        )}

        <div className="settings-buttons">
          <button type="submit" className="session-button session-button-primary" disabled={busy || setup === null}>
            Save
          </button>
          <button type="button" className="session-button" onClick={onClose}>Close</button>
        </div>
      </form>
    </dialog>
  );
}
