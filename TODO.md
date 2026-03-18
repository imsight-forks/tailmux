# TODO

Replace Tailmux's custom tab management with Dockview.

## Goal

Move from the current hand-rolled single-active-tab UI to a Dockview-based layout system that supports:

- dockable terminal groups
- split 2-view and 4-view layouts
- draggable tab reordering
- panel attach/detach between groups
- saved and restored layouts

## Notes

- Current tab state lives in `public/app.js`.
- Current single-pane layout assumptions live in `public/styles.css` and `public/index.html`.
- This should replace the browser-level tab manager, not tmux pane splitting inside a terminal session.

## Initial Tasks

- audit current tab lifecycle and websocket ownership per terminal
- choose Dockview integration style: vanilla TypeScript/JavaScript or framework migration
- refactor terminal container to support multiple visible panels at once
- map each terminal session to a Dockview panel
- preserve reconnect behavior for tmux-backed sessions
- define layout persistence format
- update styles to remove single-active-terminal assumptions
