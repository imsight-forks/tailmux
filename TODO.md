# TODO

Replace Tailmux's custom tab management with Dockview.

## Current Focus

Phase 1 is to replace the current hand-rolled browser tab strip with Dockview so terminal tabs can be rearranged freely while the workspace still behaves like a single visible tab group.

This phase is about browser-level tab management only. It should not change tmux pane splitting inside a terminal session.

## Notes

- Current tab state lives in `public/app.js`.
- Current single-pane layout assumptions live in `public/styles.css` and `public/index.html`.
- The first Dockview pass should preserve terminal session continuity instead of rebuilding xterm or websocket state on tab moves.
- Multi-panel layouts, free docking between groups, and split views are future work after the tab/session boundary is stable.

## Dockview Integration

- add a Bun-managed frontend bundle for Dockview, xterm, and the fit addon
- replace the custom browser tab strip with a Dockview workspace container
- keep one visible workspace group for now while allowing drag-reorder within that group
- refactor tab state into session lifecycle state and workspace/layout state
- map each terminal session to a Dockview panel without recreating the session on tab move or activation
- derive active-session actions from the Dockview active panel instead of the current custom tab DOM
- relocate tmux tab actions into a persistent external toolbar
- preserve reconnect behavior for tmux-backed sessions
- define versioned layout/session persistence for restorable tabs
- add a reset-layout action for clearing persisted workspace state
- update styles to remove single-active-terminal assumptions

## Future Layout Ideas

- split 2-view and 4-view layouts
- multiple visible Dockview groups
- panel attach/detach between groups
- floating groups or pop-out windows if Dockview support is worth the added complexity
- richer saved workspace layouts once multi-panel behavior exists
- mobile-specific affordances if drag-and-drop is weak on touch devices
