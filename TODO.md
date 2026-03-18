# TODO

Tailmux now uses Dockview for browser-level terminal layout.

## Implemented Dockview Integration

- Bun-managed frontend bundle for Dockview, xterm, and the fit addon
- Dockview workspace container replacing the custom browser tab strip
- drag-reorder within a group and drag-to-split across multiple visible groups
- one live terminal session mapped to one Dockview panel without recreating xterm or websocket state during layout moves
- active-session routing derived from the focused Dockview pane instead of custom tab DOM state
- tmux tab actions relocated into the persistent external toolbar
- versioned persisted workspace layout with tmux-backed restore and reset-layout support
- focused-pane styling and split-aware workspace summary updates

## Current Notes

- Browser-level layout state still lives primarily in `public/app.js`.
- Styling for focused panes and Dockview groups lives in `public/styles.css`.
- This work changes browser-level arrangement only; tmux pane splitting inside a terminal session is still separate.
- The dashboard remains a flat management surface even when multiple groups are visible.

## Future Layout Ideas

- floating groups or pop-out windows if Dockview support is worth the added complexity
- duplicate views of one live terminal session if that becomes worth the ownership complexity
- richer saved workspace features beyond the current tmux-backed restore model
- explicit split commands or presets beyond drag-and-drop
- mobile-specific affordances if drag-and-drop remains weak on touch devices
