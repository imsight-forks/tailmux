# Tailmux - Remote Terminal Access

Browser-based terminal emulator with tmux integration, multi-tab support, and mobile optimization.

## Quick Start

```bash
bun install
bun run start
```

If you prefer npm instead:

```bash
npm install
npm start
```

Visit `http://localhost:3000` to open Tailmux.

`bun run start` now builds the bundled browser assets under `public/build/` and then launches `node server.js`. Do not force Bun's runtime with `bun --bun run start`; `node-pty` is a native addon and currently expects the Node.js runtime ABI.

If you need Tailmux to keep running after you disconnect, use a real process supervisor such as `systemd`, `pm2`, Docker, or a detached `tmux` session. In some environments, bare detached launches such as `nohup npm start &` or `nohup node server.js &` can exit immediately even though the same command works in the foreground. Tailmux itself does not require tmux to host the web server, but tmux is a reliable way to keep the process alive when you do not have `systemd` available. For example:

```bash
tmux new-session -d -s tailmux \
  'cd /path/to/tailmux && HOST=127.0.0.1 PORT=3000 node server.js'
```

## Features

- **Full terminal emulation** using xterm.js
- **Dockview workspace tabs** - Drag tabs to reorder them, move them between groups, or split the browser workspace vertically and horizontally
- **tmux integration** - Create or attach to persistent tmux sessions
- **Session dashboard** - Manage all tabs from one interface
- **Mobile optimized** - Virtual keyboard and tmux control panel
- **Workspace restore** - tmux-backed split layouts restore after reload; plain shell tabs are intentionally skipped

## Deployment

### Docker

```bash
docker build -t tailmux:latest .
docker run --rm -it -p 3000:3000 tailmux:latest
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `MAX_TERMINALS` | `10` | Maximum concurrent terminals |
| `WS_HEARTBEAT_INTERVAL` | `30000` | WebSocket ping interval (ms) |
| `TERMINAL_IDLE_TIMEOUT_MS` | `0` | Idle timeout (0 = disabled) |
| `ALLOWED_ORIGINS` | _(empty)_ | Comma-separated list of allowed WebSocket origins |
| `TAILMUX_TOKEN` | _(empty)_ | Shared token required for WebSocket access |

### TrueNAS SCALE

Use the compose file in `deploy/truenas.yml`:

1. Open **Apps → Custom App → Install via YAML**
2. Paste contents and update the volume path
3. Publish via Tailscale: `tailscale serve tcp 3000 --name tailmux`

### Bare Metal (systemd)

See the systemd service configuration in the [deployment section below](#systemd-service-configuration).

## Security

**⚠️ Important:** Tailmux does **not** require authentication unless you set `TAILMUX_TOKEN`. Without it, anyone who can reach port 3000 can access a shell.

### Recommended Setup

1. **Use Tailscale or VPN** - Never expose directly to the internet
2. **Run as dedicated user** - Create a limited-privilege user for the service
3. **Enable Tailscale ACLs** - Restrict which tailnet users can access the service
4. **Set `TAILMUX_TOKEN`** - Require a shared token for WebSocket + API access
5. **Add reverse proxy auth** - Use nginx/Caddy with OAuth if needed

### Tailscale Integration

```bash
# Bind Tailmux to localhost, then publish via Tailscale:
HOST=127.0.0.1 TAILMUX_TOKEN=your-token-here bun run start
tailscale serve tcp 3000 --name tailmux
```

Connect with the token once to store it in your browser:

```bash
https://tailmux.<tailnet>.ts.net/?token=your-token-here
```

The token is saved in `localStorage` (key `tailmux_token`). Clear it in the browser if you need to rotate it.

API requests include the token as an `Authorization: Bearer` header when set.

Users on your tailnet can access via the MagicDNS name.

## Installation

### Docker
tmux is pre-installed in the Docker image.

### Bare Metal
Install Node.js 20+ and tmux. Bun is preferred as the package manager/script runner, but Node.js is still required at runtime:

```bash
# macOS
brew install tmux

# Debian/Ubuntu
sudo apt install -y nodejs npm tmux

# RHEL/Fedora
sudo dnf install -y nodejs npm tmux
```

Install Bun and use:

```bash
bun install
bun run start
```

This still launches Tailmux through `node server.js` after running the Bun frontend build. npm remains available as a fallback.

## Usage

Open `http://localhost:3000` in your browser. You'll see options to:
- **Attach to existing tmux session** (if any are running)
- **Create new tmux session** (persistent, survives disconnects)
- **Start regular shell** (non-persistent)

### Interface

- **Tabs and splits**: Click `+` to create new tabs, drag tabs within a group to rearrange them, drag onto another group's left/right/top/bottom edge to create a split, and drag a single-tab group back into another header to collapse it
- **Dashboard**: Grid icon shows a flat session list, session statistics, and reset-layout control
- **Mobile**: Keyboard icon for virtual keys, tmux icon for command panel
- **Scrolling**: Two-finger swipe, scroll buttons, or tmux copy mode

Tailmux now treats Dockview groups as visible panes. Global toolbar actions always target the focused pane, and the toolbar summary shows which session currently owns those actions.

Tab drag and split creation are desktop-first in this phase. Mobile keeps the keyboard and tmux controls, but touch drag-and-drop quality will depend on the browser.

Current limitations:

- Floating or pop-out groups are intentionally disabled
- The dashboard stays flat even when tabs are distributed across multiple visible groups
- Only tmux-backed tabs (`tmux` / `attach`) restore after reload; `new` shell tabs do not

## systemd Service Configuration

For bare-metal Linux deployments:

1. **Create dedicated user:**
   ```bash
   sudo useradd --system --home /opt/tailmux --shell /usr/sbin/nologin tailmux
   sudo mkdir -p /opt/tailmux
   sudo chown tailmux:tailmux /opt/tailmux
   ```

2. **Deploy application:**
   ```bash
   sudo -u tailmux git clone https://github.com/adamcowan/tailmux.git /opt/tailmux
   cd /opt/tailmux
   sudo -u tailmux bun install
   ```

   Optional fallback if Bun is unavailable for the service user:

   ```bash
   sudo -u tailmux npm install --omit=dev
   ```

3. **Create `/etc/systemd/system/tailmux.service`:**
   ```ini
   [Unit]
   Description=Tailmux remote terminal gateway
   After=network.target

   [Service]
   User=tailmux
   Group=tailmux
   WorkingDirectory=/opt/tailmux
   Environment=PORT=3000
   Environment=MAX_TERMINALS=20
   ExecStart=/usr/bin/node /opt/tailmux/server.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

4. **Enable service:**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now tailmux.service
   ```

## License

MIT - See [LICENSE](LICENSE) file for details.
