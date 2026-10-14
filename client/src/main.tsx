import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const style = document.createElement('style');
style.textContent = `
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; background: #faf9f7; color: #1c1b19; }
  main { max-width: 820px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 20px; } h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #6b6862; margin-top: 28px; }
  .summary { margin: -6px 0 16px; color: #6b6862; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid #e6e3dd; margin-top: 16px; }
  .tab { margin: 0 0 -1px; padding: 6px 12px; border: 1px solid transparent; border-bottom: 0;
         border-radius: 6px 6px 0 0; background: transparent; color: #6b6862; }
  .tab[aria-selected="true"] { background: #fff; border-color: #e6e3dd; color: #1c1b19; font-weight: 600; }
  .badge { margin-left: 6px; padding: 0 7px; border-radius: 999px; background: #1c1b19; color: #faf9f7;
           font-size: 12px; font-variant-numeric: tabular-nums; }
  .notify-toggle { margin: -8px 0 8px; padding: 2px 8px; font-size: 12px; color: #6b6862; }
  .notify-status { margin: -10px 0 8px; font-size: 12px; color: #8a867f; }
  .empty { color: #6b6862; margin-top: 20px; }
  .banner { background: #fdf3d7; border: 1px solid #e8d9a0; color: #1c1b19; padding: 8px 12px; border-radius: 6px; }
  .cards { list-style: none; padding: 0; display: grid; gap: 10px; }
  .card { background: #fff; border: 1px solid #e6e3dd; border-radius: 8px; padding: 12px 14px; }
  .card-head { display: flex; align-items: center; gap: 8px; }
  .card-head a { color: inherit; text-decoration: none; font-weight: 600; flex: 1; }
  .card-head a:hover { text-decoration: underline; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .repo { color: #8a867f; font-weight: 400; }
  .age { color: #8a867f; font-variant-numeric: tabular-nums; }
  .receipts, .asks { margin: 8px 0 0; padding-left: 18px; color: #6b6862; font-size: 13px; }
  .asks { color: #1c1b19; }
  .title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .gear { margin: 0; padding: 2px 8px; font-size: 16px; line-height: 1.4; color: #6b6862; }
  .settings { width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 32px); border: 1px solid #d4d0c8;
              border-radius: 10px; padding: 16px 20px; background: #fff; color: #1c1b19; }
  .settings::backdrop { background: rgba(0, 0, 0, .4); }
  .settings h2 { margin-top: 0; }
  .settings h3 { font-size: 13px; margin: 12px 0 4px; }
  .settings fieldset { border: 1px solid #e6e3dd; border-radius: 8px; margin: 12px 0; padding: 8px 12px; }
  .settings legend { padding: 0 4px; font-size: 13px; color: #6b6862; }
  .settings .detected { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 8px; font-size: 13px; }
  .settings .detected dt { color: #6b6862; }
  .settings .detected dd { margin: 0; word-break: break-all; }
  .settings .choice { display: block; padding: 2px 0; }
  .settings .field { display: grid; gap: 4px; margin: 12px 0 4px; }
  .settings .field > span:first-child { font-size: 13px; color: #6b6862; }
  .settings input[type="text"], .settings select, .settings textarea { font: inherit; padding: 4px 6px; border-radius: 6px;
              border: 1px solid #d4d0c8; background: #fff; color: inherit; max-width: 100%; box-sizing: border-box; }
  .settings textarea { width: 100%; }
  .settings .repo-row { display: grid; gap: 4px; margin: 8px 0; }
  .settings .repo-name { font-weight: 600; font-size: 13px; }
  .settings .hint { color: #8a867f; font-size: 12px; margin: 2px 0; }
  .settings .field-error { color: #b3261e; font-size: 12px; margin: 2px 0; }
  .settings-buttons { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  .sessions-error { margin: -8px 0 8px; font-size: 12px; color: #8a867f; }
  .sessions, .start-session { margin-top: 10px; }
  .session-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .session { display: flex; align-items: center; gap: 8px; font-size: 13px; min-width: 0; flex-wrap: wrap; }
  .session-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; box-sizing: border-box; }
  .session-dot-busy { background: #c98a20; }
  .session-dot-waiting { background: #d64545; }
  .session-dot-idle { background: #8a867f; }
  .session-dot-ended { border: 1.5px solid #8a867f; }
  .session-name { flex: 1 1 12ch; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-status { color: #8a867f; font-size: 12px; }
  .session-actions { display: flex; gap: 6px; }
  .session-button { margin: 0; padding: 1px 7px; font-size: 12px; line-height: 1.5; border-radius: 6px;
                    border: 1px solid #d4d0c8; background: #fff; color: inherit; cursor: pointer; text-decoration: none; }
  .session-button:hover { border-color: #8a867f; }
  .session-button:focus-visible { outline: 2px solid #4a7bd0; outline-offset: 1px; }
  .session-button-primary { background: #1c1b19; color: #faf9f7; border-color: #1c1b19; }
  .session-button:disabled { opacity: .6; cursor: default; }
  .session-message { margin-left: 8px; font-size: 12px; color: #6b6862; white-space: pre-wrap; }
  .offscreen { position: fixed; top: 0; left: -9999px; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
                     clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .session-message p { margin: 0 0 4px; }
  .session-message code { font-size: 12px; user-select: all; }
  .settings .form-errors { color: #b3261e; font-size: 12px; margin: 8px 0; padding-left: 18px; }
  button { margin-top: 10px; font: inherit; padding: 5px 10px; border-radius: 6px;
           border: 1px solid #d4d0c8; background: #fff; cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    body { background: #171614; color: #ece9e3; }
    h2 { color: #9b968d; }
    .summary, .empty, .notify-toggle { color: #9b968d; }
    .notify-status { color: #8a867f; }
    .tabs { border-bottom-color: #35332e; }
    .tab { color: #9b968d; }
    .tab[aria-selected="true"] { background: #201f1c; border-color: #35332e; color: #ece9e3; }
    .badge { background: #ece9e3; color: #171614; }
    .card { background: #201f1c; border-color: #35332e; }
    .receipts { color: #9b968d; }
    /* The banner sets its own palette in both schemes: inheriting body's
       colour over a fixed cream background made it unreadable in dark mode. */
    .banner { background: #3a2f12; border-color: #5c4a1d; color: #f2e4bb; }
    .asks { color: #ece9e3; }
    button { background: #201f1c; color: inherit; border-color: #35332e; }
    .sessions-error, .session-status { color: #8a867f; }
    .gear { color: #9b968d; }
    .settings { background: #201f1c; color: #ece9e3; border-color: #35332e; }
    .settings fieldset { border-color: #35332e; }
    .settings legend, .settings .detected dt, .settings .field > span:first-child { color: #9b968d; }
    .settings input[type="text"], .settings select, .settings textarea { background: #171614; border-color: #35332e; }
    .settings .field-error, .settings .form-errors { color: #f2b8b5; }
    .session-message { color: #9b968d; }
    .session-dot-idle { background: #9b968d; }
    .session-dot-ended { border-color: #9b968d; }
    .session-button { background: #201f1c; border-color: #35332e; }
    .session-button:hover { border-color: #6b6862; }
    .session-button-primary { background: #ece9e3; color: #171614; border-color: #ece9e3; }
    .session-button:focus-visible { outline-color: #7fa6ea; }
  }
`;
document.head.append(style);

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
