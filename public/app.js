import 'dockview-core/dist/styles/dockview.css';
import 'xterm/css/xterm.css';
import './styles.css';

import { createDockview } from 'dockview-core';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

const sessions = new Map();
let nextSessionId = 1;
let activeSessionId = null;
let sessionMode = 'new';
let workspace = null;
let toastContainer = null;
let saveLayoutTimer = null;
let workspaceLayoutTimer = null;
let isRestoringWorkspace = false;
let persistenceSuppressed = false;

const dom = {};

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 500;
const RECONNECT_MAX_DELAY = 5000;

const SESSION_CACHE_TTL = 5000;
let cachedSessions = null;
let cachedSessionsTimestamp = 0;
let sessionFetchPromise = null;

const DEFAULT_TOAST_DURATION = 4000;
const WORKSPACE_STORAGE_KEY = 'tailmux_workspace_v1';
const WORKSPACE_STATE_VERSION = 2;
const WORKSPACE_SAVE_DELAY = 120;

const TMUX_SESSION_MODES = new Set(['tmux', 'attach']);
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}`;

const TOKEN_STORAGE_KEY = 'tailmux_token';
const urlToken = new URLSearchParams(window.location.search).get('token');
if (urlToken) {
  localStorage.setItem(TOKEN_STORAGE_KEY, urlToken);
  const cleanedUrl = new URL(window.location.href);
  cleanedUrl.searchParams.delete('token');
  window.history.replaceState({}, document.title, cleanedUrl.toString());
}
const authToken = urlToken || localStorage.getItem(TOKEN_STORAGE_KEY) || '';

function cacheDomReferences() {
  dom.dockview = document.getElementById('dockview');
  dom.terminalContainer = document.getElementById('terminal-container');
  dom.toastContainer = document.getElementById('toast-container');
  dom.sessionSelector = document.getElementById('session-selector');
  dom.sessionSelectorCloseBtn = document.getElementById('session-selector-close-btn');
  dom.newShellOption = document.getElementById('new-shell-option');
  dom.newTmuxOption = document.getElementById('new-tmux-option');
  dom.newSessionForm = document.getElementById('new-session-form');
  dom.sessionNameInput = document.getElementById('session-name');
  dom.createSessionBtn = document.getElementById('create-session-btn');
  dom.cancelSessionBtn = document.getElementById('cancel-session-btn');
  dom.existingSessions = document.getElementById('existing-sessions');
  dom.tmuxWarning = document.getElementById('tmux-warning');
  dom.dashboard = document.getElementById('dashboard');
  dom.dashboardBtn = document.getElementById('dashboard-btn');
  dom.dashboardCloseBtn = document.getElementById('dashboard-close-btn');
  dom.dashboardNewTerminalBtn = document.getElementById('dashboard-new-terminal-btn');
  dom.dashboardCloseAllBtn = document.getElementById('dashboard-close-all-btn');
  dom.dashboardResetLayoutBtn = document.getElementById('dashboard-reset-layout-btn');
  dom.dashboardTabsList = document.getElementById('dashboard-tabs-list');
  dom.statActive = document.getElementById('stat-active');
  dom.statTabs = document.getElementById('stat-tabs');
  dom.statTmux = document.getElementById('stat-tmux');
  dom.newTabBtn = document.getElementById('new-tab-btn');
  dom.keyboardBtn = document.getElementById('keyboard-btn');
  dom.tmuxBtn = document.getElementById('tmux-btn');
  dom.virtualKeyboard = document.getElementById('virtual-keyboard');
  dom.tmuxPanel = document.getElementById('tmux-panel');
  dom.tmuxNewWindowBtn = document.getElementById('tmux-new-window-btn');
  dom.tmuxRenameBtn = document.getElementById('tmux-rename-btn');
  dom.workspaceActiveSession = document.getElementById('workspace-active-session');
}

function dismissToast(toast) {
  if (!toast) {
    return;
  }

  const timeoutId = toast.dataset.timeoutId;
  if (timeoutId) {
    clearTimeout(Number(timeoutId));
    delete toast.dataset.timeoutId;
  }

  toast.classList.remove('visible');
  toast.classList.add('hiding');
  setTimeout(() => {
    if (toast.parentElement) {
      toast.parentElement.removeChild(toast);
    }
  }, 200);
}

function showToast(message, variant = 'info', options = {}) {
  if (!toastContainer) {
    return null;
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${variant}`;
  toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  toastContainer.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  const duration = typeof options.duration === 'number' ? options.duration : DEFAULT_TOAST_DURATION;
  if (duration > 0) {
    const timeoutId = window.setTimeout(() => dismissToast(toast), duration);
    toast.dataset.timeoutId = timeoutId.toString();
  }

  toast.addEventListener('click', () => dismissToast(toast));
  return toast;
}

function invalidateSessionCache() {
  cachedSessions = null;
  cachedSessionsTimestamp = 0;
}

async function fetchSessions(force = false) {
  const now = Date.now();

  if (!force && cachedSessions && (now - cachedSessionsTimestamp) < SESSION_CACHE_TTL) {
    return cachedSessions;
  }

  if (!force && sessionFetchPromise) {
    return sessionFetchPromise;
  }

  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  const request = fetch('/api/sessions', { headers })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      cachedSessions = data;
      cachedSessionsTimestamp = Date.now();
      return data;
    })
    .catch((err) => {
      console.error('Failed to fetch sessions:', err);
      throw err;
    })
    .finally(() => {
      sessionFetchPromise = null;
    });

  if (!force) {
    sessionFetchPromise = request;
  }

  return request;
}

function isTmuxMode(mode) {
  return TMUX_SESSION_MODES.has(mode);
}

function isSessionRestorable(session) {
  return isTmuxMode(session.mode);
}

function syncSessionCounter(sessionId) {
  const match = /^session-(\d+)$/.exec(sessionId);
  if (!match) {
    return;
  }
  const numericId = Number(match[1]);
  if (Number.isFinite(numericId) && numericId >= nextSessionId) {
    nextSessionId = numericId + 1;
  }
}

function generateSessionId() {
  return `session-${nextSessionId++}`;
}

function getActiveSession() {
  return activeSessionId ? sessions.get(activeSessionId) || null : null;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function collectPanelIdsFromLayoutNode(node, ids = [], seen = new Set()) {
  if (!node || typeof node !== 'object') {
    return ids;
  }

  if (node.type === 'leaf') {
    const sourcePanels = Array.isArray(node.data?.panels)
      ? node.data.panels
      : Array.isArray(node.data?.views)
        ? node.data.views
        : [];

    sourcePanels.forEach((panelId) => {
      if (!seen.has(panelId)) {
        seen.add(panelId);
        ids.push(panelId);
      }
    });

    return ids;
  }

  if (node.type === 'branch' && Array.isArray(node.data)) {
    node.data.forEach((child) => collectPanelIdsFromLayoutNode(child, ids, seen));
  }

  return ids;
}

function getOrderedSessionIdsFromLayout(layout) {
  if (!layout?.grid?.root) {
    return [];
  }

  return collectPanelIdsFromLayoutNode(layout.grid.root).filter((panelId) => sessions.has(panelId));
}

function getOrderedSessionIds() {
  const orderedIds = workspace ? getOrderedSessionIdsFromLayout(workspace.toJSON()) : [];
  const seen = new Set(orderedIds);

  Array.from(sessions.keys()).forEach((sessionId) => {
    if (!seen.has(sessionId)) {
      orderedIds.push(sessionId);
      seen.add(sessionId);
    }
  });

  return orderedIds;
}

function getPanelParams(session) {
  return {
    sessionId: session.id,
    sessionLabel: session.sessionLabel,
    mode: session.mode,
    connected: session.connected
  };
}

function buildRestoreDescriptor(session) {
  return {
    id: session.id,
    mode: session.mode,
    sessionName: session.sessionName,
    sessionLabel: session.sessionLabel,
    restorable: isSessionRestorable(session)
  };
}

function buildWorkspaceState() {
  if (!workspace || sessions.size === 0) {
    return null;
  }

  const orderedSessionIds = getOrderedSessionIds();
  const descriptors = orderedSessionIds
    .map((sessionId) => getSession(sessionId))
    .filter(Boolean)
    .map((session) => buildRestoreDescriptor(session));

  return {
    version: WORKSPACE_STATE_VERSION,
    activeSessionId,
    orderedSessionIds,
    layout: workspace.toJSON(),
    sessions: descriptors
  };
}

function clearPersistedWorkspaceState() {
  localStorage.removeItem(WORKSPACE_STORAGE_KEY);
}

function persistWorkspaceState() {
  if (isRestoringWorkspace || persistenceSuppressed) {
    return;
  }

  const state = buildWorkspaceState();
  if (!state) {
    clearPersistedWorkspaceState();
    return;
  }

  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Failed to persist workspace state:', err);
  }
}

function scheduleWorkspaceSave() {
  if (isRestoringWorkspace || persistenceSuppressed) {
    return;
  }

  if (saveLayoutTimer) {
    clearTimeout(saveLayoutTimer);
  }

  saveLayoutTimer = window.setTimeout(() => {
    saveLayoutTimer = null;
    persistWorkspaceState();
  }, WORKSPACE_SAVE_DELAY);
}

function getFirstLeafGroupId(node) {
  if (!node || typeof node !== 'object') {
    return undefined;
  }

  if (node.type === 'leaf') {
    return node.data?.id;
  }

  if (node.type === 'branch' && Array.isArray(node.data)) {
    for (const child of node.data) {
      const found = getFirstLeafGroupId(child);
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

function getLeafGroupIds(node, ids = []) {
  if (!node || typeof node !== 'object') {
    return ids;
  }

  if (node.type === 'leaf') {
    if (node.data?.id) {
      ids.push(node.data.id);
    }
    return ids;
  }

  if (node.type === 'branch' && Array.isArray(node.data)) {
    node.data.forEach((child) => getLeafGroupIds(child, ids));
  }

  return ids;
}

function filterLayoutNode(node, allowedIds) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  if (node.type === 'leaf') {
    const sourcePanels = Array.isArray(node.data?.panels)
      ? node.data.panels
      : Array.isArray(node.data?.views)
        ? node.data.views
        : [];
    const panels = sourcePanels.filter((panelId) => allowedIds.has(panelId));
    if (panels.length === 0) {
      return null;
    }

    const activePanel = panels.includes(node.data?.activePanel)
      ? node.data.activePanel
      : panels.includes(node.data?.activeView)
        ? node.data.activeView
        : panels[0];

    return {
      ...node,
      data: {
        ...node.data,
        panels,
        views: panels,
        activePanel,
        activeView: activePanel
      }
    };
  }

  if (node.type === 'branch' && Array.isArray(node.data)) {
    const children = node.data
      .map((child) => filterLayoutNode(child, allowedIds))
      .filter(Boolean);

    if (children.length === 0) {
      return null;
    }

    return {
      ...node,
      data: children
    };
  }

  return node;
}

function buildFilteredLayout(layout, allowedIds) {
  if (!layout || typeof layout !== 'object') {
    return null;
  }

  const panels = {};
  allowedIds.forEach((panelId) => {
    if (layout.panels?.[panelId]) {
      panels[panelId] = layout.panels[panelId];
    }
  });

  if (Object.keys(panels).length === 0) {
    return null;
  }

  const root = filterLayoutNode(layout.grid?.root, allowedIds);
  if (!root) {
    return null;
  }

  const retainedGroupIds = getLeafGroupIds(root);
  const activeGroup = retainedGroupIds.includes(layout.activeGroup)
    ? layout.activeGroup
    : retainedGroupIds[0] || getFirstLeafGroupId(root);

  return {
    ...layout,
    panels,
    activeGroup,
    floatingGroups: [],
    popoutGroups: [],
    grid: {
      ...layout.grid,
      root
    }
  };
}

function formatSkippedRestoreMessage(skippedDescriptors) {
  const count = skippedDescriptors.length;
  if (count === 1) {
    const label = skippedDescriptors[0].sessionLabel || 'shell';
    return `Skipped restoring shell tab "${label}" because plain shell sessions do not survive reloads.`;
  }

  return `Skipped restoring ${count} shell tabs because plain shell sessions do not survive reloads.`;
}

function syncFocusedPaneState() {
  workspace?.groups?.forEach((group) => {
    group.element.classList.remove('tailmux-group-has-active-pane');
  });

  sessions.forEach((session, sessionId) => {
    const isActivePane = sessionId === activeSessionId;
    session.root.classList.toggle('active-pane', isActivePane);
    session.root.parentElement?.classList.toggle('active-pane', isActivePane);

    if (session.panel?.group?.element) {
      session.panel.group.element.classList.toggle('tailmux-group-has-active-pane', isActivePane);
    }
  });
}

function updateWorkspaceSummary() {
  const session = getActiveSession();
  if (!dom.workspaceActiveSession) {
    return;
  }

  if (!session) {
    dom.workspaceActiveSession.textContent = 'No focused pane';
    return;
  }

  const status = session.connected ? 'connected' : 'disconnected';
  const orderedIds = getOrderedSessionIds();
  const paneIndex = orderedIds.indexOf(session.id);
  const positionText = paneIndex >= 0 ? ` · pane ${paneIndex + 1}/${orderedIds.length}` : '';
  const visiblePaneCount = workspace?.groups?.length || 1;
  const groupText = visiblePaneCount > 1 ? ` · ${visiblePaneCount} visible panes` : '';

  dom.workspaceActiveSession.textContent = `${session.sessionLabel} · ${session.mode} · ${status}${positionText}${groupText}`;
}

function updateTmuxToolbarButtons() {
  const session = getActiveSession();
  const isTmuxActive = Boolean(
    session &&
    isTmuxMode(session.mode) &&
    session.connected &&
    session.socket &&
    session.socket.readyState === WebSocket.OPEN
  );

  [dom.tmuxNewWindowBtn, dom.tmuxRenameBtn].forEach((button) => {
    if (!button) {
      return;
    }

    button.disabled = !isTmuxActive;
    button.classList.toggle('disabled', !isTmuxActive);
  });
}

function updateSessionPanelState(session) {
  const panel = workspace?.getPanel(session.id);
  if (!panel) {
    return;
  }

  session.panel = panel;
  panel.api.setTitle(session.sessionLabel);
  panel.api.setRenderer('always');
  panel.api.updateParameters(getPanelParams(session));
}

function setActiveSession(sessionId) {
  activeSessionId = sessionId || null;
  syncFocusedPaneState();
  updateWorkspaceSummary();
  updateTmuxToolbarButtons();
  updateDashboard();
}

function requestSessionActivation(sessionId, options = {}) {
  const session = getSession(sessionId);
  if (!session) {
    return;
  }

  const { focusTerminal = false } = options;
  const panel = workspace?.getPanel(sessionId);
  if (panel && !panel.api.isActive) {
    panel.api.setActive();
  }

  setActiveSession(sessionId);

  if (focusTerminal) {
    focusSession(sessionId);
  }
}

function focusSession(sessionId) {
  const session = getSession(sessionId);
  if (!session || !session.termOpened) {
    return;
  }

  try {
    session.term.focus();
  } catch (err) {
    console.error('Failed to focus terminal:', err);
  }
}

function fitSession(sessionId) {
  const session = getSession(sessionId);
  if (!session || !session.termOpened) {
    return;
  }

  try {
    session.fitAddon.fit();
  } catch (err) {
    return;
  }

  if (session.socket && session.socket.readyState === WebSocket.OPEN) {
    session.socket.send(JSON.stringify({
      type: 'resize',
      cols: session.term.cols,
      rows: session.term.rows
    }));
  }
}

function scheduleFitSession(sessionId, delay = 0) {
  const session = getSession(sessionId);
  if (!session) {
    return;
  }

  if (session.fitTimer) {
    clearTimeout(session.fitTimer);
  }

  session.fitTimer = window.setTimeout(() => {
    session.fitTimer = null;
    requestAnimationFrame(() => fitSession(sessionId));
  }, delay);
}

function layoutWorkspaceNow(force = false) {
  if (!workspace || !dom.dockview) {
    return;
  }

  const width = dom.dockview.clientWidth;
  const height = dom.dockview.clientHeight;
  workspace.layout(width, height, force);
}

function scheduleWorkspaceLayout(delay = 0, force = false) {
  if (!workspace || !dom.dockview) {
    return;
  }

  if (workspaceLayoutTimer) {
    clearTimeout(workspaceLayoutTimer);
  }

  workspaceLayoutTimer = window.setTimeout(() => {
    workspaceLayoutTimer = null;
    requestAnimationFrame(() => layoutWorkspaceNow(force));
  }, delay);
}

function setupMobileDetection() {
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  if (isMobile) {
    document.body.classList.add('mobile');
  }
}

function createWatermarkComponent() {
  const element = document.createElement('div');
  element.className = 'tailmux-watermark';

  return {
    element,
    init() {
      const title = document.createElement('div');
      title.className = 'tailmux-watermark-title';
      title.textContent = 'Open a terminal to start';

      const copy = document.createElement('div');
      copy.className = 'tailmux-watermark-copy';
      copy.textContent = 'Dockview now manages browser tabs here. Use the plus button to open a shell or tmux session.';

      element.replaceChildren(title, copy);
    }
  };
}

function createTabComponent() {
  const element = document.createElement('div');
  element.className = 'tailmux-dockview-tab';

  const status = document.createElement('span');
  status.className = 'tailmux-dockview-tab-status';

  const label = document.createElement('span');
  label.className = 'tailmux-dockview-tab-label';

  const close = document.createElement('button');
  close.className = 'tailmux-dockview-tab-close';
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close tab');

  element.append(status, label, close);

  const disposables = [];
  let panelApi = null;

  function render(api) {
    if (!api) {
      return;
    }
    const params = api.getParameters();
    label.textContent = api.title || params.sessionLabel || 'Terminal';
    status.classList.toggle('disconnected', !params.connected);
  }

  return {
    element,
    init(params) {
      panelApi = params.api;
      render(params.api);

      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeSession(params.api.id);
      });

      disposables.push(params.api.onDidParametersChange(() => render(params.api)));
      disposables.push(params.api.onDidTitleChange(() => render(params.api)));
    },
    update() {
      render(panelApi);
    },
    dispose() {
      disposables.forEach((disposable) => disposable?.dispose?.());
    }
  };
}

function createTerminalComponent() {
  const element = document.createElement('div');
  element.className = 'tailmux-panel-host';

  const disposables = [];
  let currentSessionId = null;
  let panelApi = null;

  function attachSessionById(sessionId) {
    currentSessionId = sessionId;

    const session = getSession(sessionId);
    if (!session) {
      element.replaceChildren();
      element.classList.remove('active-pane');
      return;
    }

    if (session.root.parentElement !== element) {
      element.replaceChildren(session.root);
    }

    element.classList.toggle('active-pane', sessionId === activeSessionId);
    scheduleFitSession(sessionId);
  }

  return {
    element,
    init(params) {
      panelApi = params.api;
      attachSessionById(params.api.getParameters().sessionId);
      disposables.push(params.api.onDidParametersChange((event) => {
        attachSessionById(event.sessionId || params.api.getParameters().sessionId);
      }));
    },
    update(event) {
      const nextSessionId = event?.params?.sessionId || panelApi?.getParameters().sessionId;
      attachSessionById(nextSessionId);
    },
    layout() {
      if (currentSessionId) {
        scheduleFitSession(currentSessionId);
      }
    },
    focus() {
      if (currentSessionId) {
        const session = getSession(currentSessionId);
        element.classList.toggle('active-pane', currentSessionId === activeSessionId);
        session?.root?.classList.toggle('active-pane', currentSessionId === activeSessionId);
      }
    },
    dispose() {
      disposables.forEach((disposable) => disposable?.dispose?.());
    }
  };
}

function initializeWorkspace() {
  workspace = createDockview(dom.dockview, {
    className: 'dockview-theme-dark tailmux-dockview',
    defaultTabComponent: 'tailmux-terminal-tab',
    defaultRenderer: 'always',
    disableFloatingGroups: true,
    createWatermarkComponent,
    createTabComponent,
    createComponent: (options) => {
      if (options.name === 'tailmux-terminal') {
        return createTerminalComponent();
      }

      return createWatermarkComponent();
    }
  });

  workspace.onDidActivePanelChange((panel) => {
    setActiveSession(panel?.id);
  });

  workspace.onDidMovePanel(() => {
    scheduleWorkspaceSave();
    updateDashboard();
    updateWorkspaceSummary();
    scheduleWorkspaceLayout();
  });

  workspace.onDidLayoutChange(() => {
    scheduleWorkspaceSave();
    updateDashboard();
    updateWorkspaceSummary();
  });

  workspace.onDidLayoutFromJSON(() => {
    updateDashboard();
    updateWorkspaceSummary();
    scheduleWorkspaceLayout();
  });
}

function setupTerminalScrolling(terminalDiv, term, sessionId) {
  let touchStartY = 0;
  let touchStartTime = 0;
  let isScrolling = false;
  let scrollVelocity = 0;

  terminalDiv.addEventListener('touchstart', (event) => {
    if (event.touches.length === 2) {
      isScrolling = true;
      touchStartY = event.touches[0].clientY;
      touchStartTime = Date.now();
      event.preventDefault();
    }
  }, { passive: false });

  terminalDiv.addEventListener('touchmove', (event) => {
    if (isScrolling && event.touches.length === 2) {
      const touchY = event.touches[0].clientY;
      const deltaY = touchStartY - touchY;
      const deltaTime = Date.now() - touchStartTime;

      scrollVelocity = deltaY / (deltaTime || 1);

      const scrollAmount = Math.round(deltaY / 20);
      if (Math.abs(scrollAmount) > 0) {
        term.scrollLines(scrollAmount);
        updateScrollIndicator(sessionId);
        touchStartY = touchY;
        touchStartTime = Date.now();
      }

      event.preventDefault();
    }
  }, { passive: false });

  terminalDiv.addEventListener('touchend', () => {
    if (isScrolling) {
      if (Math.abs(scrollVelocity) > 0.5) {
        const momentum = Math.round(scrollVelocity * 10);
        term.scrollLines(momentum);
        updateScrollIndicator(sessionId);
      }
      isScrolling = false;
      scrollVelocity = 0;
    }
  });

  terminalDiv.addEventListener('wheel', (event) => {
    const delta = event.deltaY > 0 ? 3 : -3;
    term.scrollLines(delta);
    updateScrollIndicator(sessionId);
    event.preventDefault();
  }, { passive: false });
}

function setTmuxCopyMode(session, isActive) {
  session.tmuxCopyModeActive = isActive;
  session.root.classList.toggle('tmux-copy-mode', Boolean(isActive));
}

function performLocalScroll(session, direction) {
  const term = session.term;
  const buffer = term.buffer.active;
  const viewportStart = typeof buffer.viewportY === 'number' ? buffer.viewportY : buffer.baseY;
  const maxViewportStart = Math.max(0, buffer.length - term.rows);
  const pageSize = Math.max(1, Math.floor(term.rows * 0.75));

  const scrollToLine = (line) => {
    if (typeof term.scrollToLine === 'function') {
      term.scrollToLine(line);
    } else {
      term.scrollLines(line - viewportStart);
    }
  };

  switch (direction) {
    case 'up':
      scrollToLine(Math.max(0, viewportStart - pageSize));
      return true;
    case 'down':
      scrollToLine(Math.min(maxViewportStart, viewportStart + pageSize));
      return true;
    case 'bottom':
      term.scrollToBottom();
      return true;
    default:
      console.warn('Unknown scroll direction:', direction);
      return false;
  }
}

function performTmuxScroll(session, direction) {
  if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
    console.warn('Cannot scroll tmux session - socket not ready');
    return false;
  }

  const sendInput = (data) => {
    session.socket.send(JSON.stringify({
      type: 'input',
      data
    }));
  };

  const ensureCopyMode = () => {
    if (session.tmuxCopyModeActive) {
      return;
    }
    sendInput('\x02[');
    setTmuxCopyMode(session, true);
  };

  switch (direction) {
    case 'up':
      ensureCopyMode();
      sendInput('\x1b[5~');
      return true;
    case 'down':
      ensureCopyMode();
      sendInput('\x1b[6~');
      return true;
    case 'bottom':
      if (session.tmuxCopyModeActive) {
        sendInput('q');
        setTmuxCopyMode(session, false);
        return true;
      }
      return false;
    default:
      console.warn('Unknown tmux scroll direction:', direction);
      return false;
  }
}

function performScroll(sessionId, direction, event) {
  const session = getSession(sessionId);
  if (!session) {
    return;
  }

  const handled = isTmuxMode(session.mode)
    ? performTmuxScroll(session, direction)
    : performLocalScroll(session, direction);

  if (handled) {
    setTimeout(() => updateScrollIndicator(sessionId), isTmuxMode(session.mode) ? 100 : 0);
  }

  if (event) {
    const button = event.target.closest('button');
    if (button) {
      button.style.transform = 'scale(0.9)';
      setTimeout(() => {
        button.style.transform = '';
      }, 100);
    }
  }
}

function handleTmuxSoftKey(sessionId, action, event) {
  const session = getSession(sessionId);
  if (!session || !session.socket || session.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const command = {
    prev: 'p',
    next: 'n',
    last: 'l'
  }[action];

  if (!command) {
    return;
  }

  session.socket.send(JSON.stringify({
    type: 'input',
    data: `\x02${command}`
  }));

  if (event) {
    const button = event.target.closest('button');
    if (button) {
      button.style.transform = 'scale(0.9)';
      setTimeout(() => {
        button.style.transform = '';
      }, 100);
    }
  }
}

function updateScrollIndicator(sessionId) {
  const session = getSession(sessionId);
  if (!session || !session.termOpened) {
    return;
  }

  const buffer = session.term.buffer.active;
  const totalLines = buffer.length;
  const viewportStart = typeof buffer.viewportY === 'number' ? buffer.viewportY : buffer.baseY;
  const maxViewportStart = Math.max(0, totalLines - session.term.rows);
  const hasHistory = maxViewportStart > 0;
  const inHistory = hasHistory && viewportStart < maxViewportStart;

  const indicator = document.getElementById(`scroll-indicator-${sessionId}`);
  if (!indicator) {
    return;
  }

  indicator.classList.toggle('active', hasHistory);
  indicator.classList.toggle('history', inHistory);
  indicator.classList.toggle('live', !inHistory);

  const bar = indicator.querySelector('.scroll-indicator-bar');
  if (bar) {
    const visibleRatio = totalLines > 0 ? Math.min(1, session.term.rows / totalLines) : 1;
    const clampedRatio = Math.max(0.12, visibleRatio);
    const barHeight = clampedRatio * 100;
    const offsetRatio = hasHistory ? Math.min(1, viewportStart / maxViewportStart) : 0;
    const translate = (100 - barHeight) * offsetRatio;

    bar.style.height = `${barHeight}%`;
    bar.style.transform = `translateY(${translate}%)`;
  }

  const label = indicator.querySelector('.scroll-indicator-label');
  if (label) {
    label.textContent = inHistory ? 'History' : 'Live';
  }
}

function createSessionRoot(sessionId, mode) {
  const root = document.createElement('div');
  root.className = 'tailmux-terminal-root';
  root.id = `terminal-${sessionId}`;

  const forwardPaneFocus = () => requestSessionActivation(sessionId);
  root.addEventListener('pointerdown', forwardPaneFocus);
  root.addEventListener('focusin', forwardPaneFocus);

  const scrollControls = document.createElement('div');
  scrollControls.className = 'scroll-controls mobile-only';
  scrollControls.innerHTML = `
    <div class="scroll-indicator" id="scroll-indicator-${sessionId}">
      <div class="scroll-indicator-track">
        <div class="scroll-indicator-bar"></div>
      </div>
      <div class="scroll-indicator-label">Live</div>
    </div>
    <button class="scroll-btn" data-action="up" title="Page up" type="button">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="18 15 12 9 6 15"></polyline>
      </svg>
    </button>
    <button class="scroll-btn" data-action="down" title="Page down" type="button">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </button>
    <button class="scroll-btn" data-action="bottom" title="Exit scrollback" type="button">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="7 13 12 18 17 13"></polyline>
        <polyline points="7 6 12 11 17 6"></polyline>
      </svg>
    </button>
  `;

  scrollControls.querySelectorAll('.scroll-btn').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      performScroll(sessionId, event.currentTarget.getAttribute('data-action'), event);
    });
  });

  let tmuxSoftKeys = null;
  if (isTmuxMode(mode)) {
    tmuxSoftKeys = document.createElement('div');
    tmuxSoftKeys.className = 'tmux-soft-keys mobile-only';
    tmuxSoftKeys.innerHTML = `
      <button class="tmux-soft-key" data-action="prev" title="Previous tmux window" aria-label="Previous tmux window" type="button">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      </button>
      <button class="tmux-soft-key" data-action="next" title="Next tmux window" aria-label="Next tmux window" type="button">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </button>
      <button class="tmux-soft-key" data-action="last" title="Last tmux window" aria-label="Last tmux window" type="button">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="8 6 12 10 8 14"></polyline>
          <polyline points="16 6 20 10 16 14"></polyline>
        </svg>
      </button>
    `;

    tmuxSoftKeys.querySelectorAll('.tmux-soft-key').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleTmuxSoftKey(sessionId, event.currentTarget.getAttribute('data-action'), event);
      });
    });
  }

  const terminalDiv = document.createElement('div');
  terminalDiv.className = 'terminal';
  terminalDiv.addEventListener('focusin', forwardPaneFocus);

  root.appendChild(scrollControls);
  if (tmuxSoftKeys) {
    root.appendChild(tmuxSoftKeys);
  }
  root.appendChild(terminalDiv);

  return { root, terminalDiv };
}

function bindSessionPanelLifecycle(session) {
  session.panelDisposables.forEach((disposable) => disposable?.dispose?.());
  session.panelDisposables = [];

  const panel = workspace?.getPanel(session.id);
  if (!panel) {
    return;
  }

  session.panel = panel;
  session.panelDisposables.push(panel.api.onDidDimensionsChange(() => scheduleFitSession(session.id)));
  session.panelDisposables.push(panel.api.onDidVisibilityChange((event) => {
    if (event.isVisible) {
      scheduleFitSession(session.id);
    }
  }));
  session.panelDisposables.push(panel.api.onDidFocusChange((event) => {
    if (event.isFocused) {
      setActiveSession(session.id);
    }
  }));
}

function addWorkspacePanel(session, activate) {
  const addOptions = {
    id: session.id,
    component: 'tailmux-terminal',
    tabComponent: 'tailmux-terminal-tab',
    title: session.sessionLabel,
    params: getPanelParams(session),
    renderer: 'always',
    inactive: !activate
  };

  const referencePanel = activeSessionId
    ? workspace?.getPanel(activeSessionId)
    : workspace?.activePanel;

  if (referencePanel && referencePanel.id !== session.id) {
    addOptions.position = {
      referencePanel: referencePanel.id,
      direction: 'within',
      index: referencePanel.group.panels.indexOf(referencePanel) + 1
    };
  }

  const panel = workspace.addPanel(addOptions);
  session.panel = panel;
  bindSessionPanelLifecycle(session);

  if (activate) {
    panel.api.setActive();
  }

  return panel;
}

function bootstrapSessionTerminal(sessionId, attempt = 0) {
  const session = getSession(sessionId);
  if (!session || session.termOpened) {
    return;
  }

  requestAnimationFrame(() => {
    const currentSession = getSession(sessionId);
    if (!currentSession || currentSession.termOpened) {
      return;
    }

    if (!currentSession.terminalDiv.isConnected) {
      if (attempt < 20) {
        bootstrapSessionTerminal(sessionId, attempt + 1);
      }
      return;
    }

    currentSession.term.open(currentSession.terminalDiv);
    currentSession.termOpened = true;
    currentSession.dataDisposable = currentSession.term.onData((data) => {
      if (currentSession.socket && currentSession.socket.readyState === WebSocket.OPEN) {
        currentSession.socket.send(JSON.stringify({
          type: 'input',
          data
        }));
      }
    });

    setupTerminalScrolling(currentSession.terminalDiv, currentSession.term, sessionId);
    currentSession.term.onScroll(() => updateScrollIndicator(sessionId));
    currentSession.term.onLineFeed(() => updateScrollIndicator(sessionId));

    scheduleFitSession(sessionId);
    if (sessionId === activeSessionId) {
      focusSession(sessionId);
    }
    updateScrollIndicator(sessionId);
    connectTerminal(sessionId);
  });
}

function createTerminalSession({
  sessionLabel,
  mode,
  sessionName = '',
  sessionId = generateSessionId(),
  activate = true,
  persist = true
}) {
  syncSessionCounter(sessionId);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    scrollback: 10000,
    theme: {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffffff',
      selection: 'rgba(255, 255, 255, 0.3)',
      black: '#000000',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#6ea8ff',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#bbbbbb',
      brightBlack: '#555555',
      brightRed: '#ff5555',
      brightGreen: '#50fa7b',
      brightYellow: '#f1fa8c',
      brightBlue: '#6ea8ff',
      brightMagenta: '#ff79c6',
      brightCyan: '#8be9fd',
      brightWhite: '#ffffff'
    }
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const { root, terminalDiv } = createSessionRoot(sessionId, mode);
  const label = sessionLabel || 'Terminal';

  const session = {
    id: sessionId,
    term,
    fitAddon,
    root,
    terminalDiv,
    panel: null,
    panelDisposables: [],
    socket: null,
    sessionName: sessionName || '',
    sessionLabel: label,
    mode,
    connected: false,
    termOpened: false,
    tmuxCopyModeActive: false,
    shouldReconnect: isTmuxMode(mode),
    reconnectAttempts: 0,
    reconnectTimer: null,
    reconnectToast: null,
    lastCloseReason: null,
    fitTimer: null,
    isClosing: false,
    dataDisposable: null
  };

  sessions.set(sessionId, session);
  addWorkspacePanel(session, activate);
  bootstrapSessionTerminal(sessionId);

  if (isTmuxMode(mode)) {
    invalidateSessionCache();
  }

  updateSessionPanelState(session);
  updateDashboard();
  updateWorkspaceSummary();
  updateTmuxToolbarButtons();

  if (persist) {
    scheduleWorkspaceSave();
  }

  return sessionId;
}

function updateSessionConnection(sessionId, connected) {
  const session = getSession(sessionId);
  if (!session) {
    return;
  }

  session.connected = connected;
  updateSessionPanelState(session);
  updateDashboard();

  if (sessionId === activeSessionId) {
    updateTmuxToolbarButtons();
    updateWorkspaceSummary();
  }

  scheduleWorkspaceSave();
}

function connectTerminal(sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    return;
  }

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  const socket = new WebSocket(wsUrl);
  session.socket = socket;

  socket.onopen = () => {
    const wasReconnecting = session.reconnectAttempts > 0;
    session.reconnectAttempts = 0;
    setTmuxCopyMode(session, false);
    updateSessionConnection(sessionId, true);

    socket.send(JSON.stringify({
      type: 'create',
      mode: session.mode,
      sessionName: session.sessionName || '',
      cols: session.term.cols,
      rows: session.term.rows,
      token: authToken
    }));

    if (wasReconnecting) {
      if (session.reconnectToast) {
        dismissToast(session.reconnectToast);
        session.reconnectToast = null;
      }
      showToast(`Reconnected to ${session.sessionLabel}`, 'success');
    }
  };

  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);

      if (message.type === 'output') {
        session.term.write(message.data);
      } else if (message.type === 'exit') {
        session.shouldReconnect = false;
        session.term.write(`\r\n\r\n[Process exited with code ${message.exitCode}]\r\n`);
        updateSessionConnection(sessionId, false);
        session.lastCloseReason = 'exit';
        if (session.reconnectToast) {
          dismissToast(session.reconnectToast);
          session.reconnectToast = null;
        }
        showToast(`${session.sessionLabel} exited (code ${message.exitCode})`, 'info');
      } else if (message.type === 'error') {
        session.shouldReconnect = false;
        const errorMessage = message.message || 'An unknown error occurred.';
        session.term.write(`\r\n\r\n[Error: ${errorMessage}]\r\n`);
        updateSessionConnection(sessionId, false);
        session.lastCloseReason = 'error';
        if (session.reconnectToast) {
          dismissToast(session.reconnectToast);
          session.reconnectToast = null;
        }
        const lowered = errorMessage.toLowerCase();
        const variant = lowered.includes('inactive') || lowered.includes('inactivity') ? 'warning' : 'error';
        showToast(errorMessage, variant, { duration: variant === 'error' ? 0 : DEFAULT_TOAST_DURATION });
        socket.close();
      } else if (message.type === 'ready') {
        scheduleFitSession(sessionId);
      }
    } catch (err) {
      console.error('Error handling terminal message:', err);
    }
  };

  socket.onerror = (error) => {
    console.error(`WebSocket error for ${sessionId}:`, error);
    updateSessionConnection(sessionId, false);
  };

  socket.onclose = () => {
    session.socket = null;

    if (session.isClosing || !sessions.has(sessionId)) {
      return;
    }

    updateSessionConnection(sessionId, false);
    session.term.write('\r\n\r\n[Connection closed]\r\n');
    setTmuxCopyMode(session, false);

    if (session.shouldReconnect) {
      if (session.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        session.term.write('\r\n\r\n[Reconnect attempts exhausted. Please reopen the session manually.]\r\n');
        const exhaustedMessage = `Reconnect attempts exhausted for ${session.sessionLabel}`;
        if (session.reconnectToast) {
          session.reconnectToast.textContent = exhaustedMessage;
        } else {
          session.reconnectToast = showToast(exhaustedMessage, 'error', { duration: 0 });
        }
        session.shouldReconnect = false;
        session.reconnectAttempts = 0;
      } else {
        const nextAttempt = session.reconnectAttempts + 1;
        const retryMessage = `Connection lost. Reconnecting ${session.sessionLabel} (${nextAttempt}/${MAX_RECONNECT_ATTEMPTS})...`;

        if (session.reconnectToast) {
          session.reconnectToast.textContent = retryMessage;
        } else {
          session.reconnectToast = showToast(retryMessage, 'warning', { duration: 0 });
        }

        const delay = Math.min(
          RECONNECT_MAX_DELAY,
          RECONNECT_BASE_DELAY * Math.pow(2, session.reconnectAttempts)
        );
        session.reconnectAttempts = nextAttempt;
        session.term.write(`\r\n[Reconnecting in ${(delay / 1000).toFixed(1)}s...]\r\n`);

        session.reconnectTimer = window.setTimeout(() => {
          session.reconnectTimer = null;
          connectTerminal(sessionId);
        }, delay);
      }
    } else {
      if (session.reconnectToast) {
        dismissToast(session.reconnectToast);
        session.reconnectToast = null;
      }

      if (session.lastCloseReason !== 'exit' && session.lastCloseReason !== 'error') {
        showToast(`${session.sessionLabel} disconnected`, 'warning');
      }

      session.reconnectAttempts = 0;
    }

    session.lastCloseReason = null;
  };
}

function disposeSession(session) {
  session.panelDisposables.forEach((disposable) => disposable?.dispose?.());
  session.panelDisposables = [];

  if (session.fitTimer) {
    clearTimeout(session.fitTimer);
    session.fitTimer = null;
  }

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  if (session.reconnectToast) {
    dismissToast(session.reconnectToast);
    session.reconnectToast = null;
  }

  if (session.socket && session.socket.readyState === WebSocket.OPEN) {
    session.socket.close();
  }
  session.socket = null;

  if (session.dataDisposable) {
    session.dataDisposable.dispose();
    session.dataDisposable = null;
  }

  if (typeof session.term.dispose === 'function') {
    session.term.dispose();
  }

  session.root.remove();
  sessions.delete(session.id);

  if (isTmuxMode(session.mode)) {
    invalidateSessionCache();
  }
}

function closeSession(sessionId) {
  const session = getSession(sessionId);
  if (!session || session.isClosing) {
    return;
  }

  session.isClosing = true;
  session.shouldReconnect = false;
  session.lastCloseReason = 'close';

  const panel = workspace?.getPanel(sessionId);
  if (panel) {
    session.panelDisposables.forEach((disposable) => disposable?.dispose?.());
    session.panelDisposables = [];
    workspace.removePanel(panel);
  }

  disposeSession(session);

  if (sessions.size === 0) {
    activeSessionId = null;
    clearPersistedWorkspaceState();
    showSessionSelector();
  } else {
    const nextActiveId = workspace.activePanel?.id || getOrderedSessionIds()[0] || null;
    if (nextActiveId) {
      requestSessionActivation(nextActiveId, { focusTerminal: true });
    } else {
      setActiveSession(null);
    }
    scheduleWorkspaceSave();
  }

  updateDashboard();
  updateWorkspaceSummary();
  updateTmuxToolbarButtons();
}

function activateSession(sessionId) {
  requestSessionActivation(sessionId, { focusTerminal: true });
}

async function loadSessions() {
  try {
    const data = await fetchSessions(true);

    if (!data.tmuxAvailable) {
      dom.tmuxWarning.classList.remove('hidden');
      dom.existingSessions.replaceChildren();
      return;
    }

    dom.tmuxWarning.classList.add('hidden');
    dom.existingSessions.replaceChildren();

    if (data.sessions && data.sessions.length > 0) {
      const heading = document.createElement('h3');
      heading.style.color = '#fff';
      heading.style.fontSize = '16px';
      heading.style.marginBottom = '10px';
      heading.textContent = 'Existing tmux Sessions';
      dom.existingSessions.appendChild(heading);

      data.sessions.forEach((session) => {
        const option = document.createElement('div');
        option.className = 'session-option';
        option.addEventListener('click', () => attachToSession(session.name));

        const title = document.createElement('h3');
        title.textContent = `Attach to: ${session.name}`;
        const details = document.createElement('p');
        details.textContent = `${session.windows} window(s) | ${session.attached ? 'Currently attached' : 'Detached'} | Created: ${new Date(session.created).toLocaleString()}`;

        option.append(title, details);
        dom.existingSessions.appendChild(option);
      });
    }
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

async function showSessionSelector() {
  await loadSessions();
  dom.sessionSelector.classList.remove('hidden');
}

function hideNewSessionForm() {
  dom.newSessionForm.classList.add('hidden');
  dom.sessionNameInput.value = '';
}

function showNewSessionForm(mode) {
  sessionMode = mode;
  dom.newSessionForm.classList.remove('hidden');
  dom.sessionNameInput.focus();
}

function hideSessionSelector() {
  dom.sessionSelector.classList.add('hidden');
  hideNewSessionForm();
}

function attachToSession(sessionName) {
  createTerminalSession({
    sessionLabel: sessionName,
    mode: 'attach',
    sessionName
  });
  hideSessionSelector();
}

function createSessionFromForm() {
  const userInput = dom.sessionNameInput.value.trim();
  let actualSessionName = userInput;
  let displayLabel = userInput;

  if (sessionMode === 'tmux') {
    if (!actualSessionName) {
      actualSessionName = `tailmux-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    }
    displayLabel = userInput || actualSessionName;
  } else if (sessionMode === 'new') {
    actualSessionName = userInput || '';
    displayLabel = userInput || 'shell';
  }

  createTerminalSession({
    sessionLabel: displayLabel,
    mode: sessionMode,
    sessionName: actualSessionName
  });

  hideSessionSelector();
}

function toggleDashboard(force) {
  const shouldShow = typeof force === 'boolean'
    ? force
    : dom.dashboard.classList.contains('hidden');

  dom.dashboard.classList.toggle('hidden', !shouldShow);

  if (shouldShow) {
    updateDashboard();
    updateTmuxToolbarButtons();
  }
}

async function updateDashboard() {
  if (!dom.statActive) {
    return;
  }

  dom.statActive.textContent = String(Array.from(sessions.values()).filter((session) => session.connected).length);
  dom.statTabs.textContent = String(sessions.size);

  try {
    const data = await fetchSessions();
    dom.statTmux.textContent = String(data.sessions?.length || 0);
  } catch (err) {
    dom.statTmux.textContent = '?';
  }

  dom.dashboardTabsList.replaceChildren();

  if (sessions.size === 0) {
    const empty = document.createElement('p');
    empty.style.color = '#999';
    empty.style.textAlign = 'center';
    empty.style.padding = '20px';
    empty.textContent = 'No active tabs';
    dom.dashboardTabsList.appendChild(empty);
    return;
  }

  getOrderedSessionIds().forEach((sessionId) => {
    const session = getSession(sessionId);
    if (!session) {
      return;
    }

    const item = document.createElement('div');
    item.className = 'dashboard-tab-item';
    item.classList.toggle('active', sessionId === activeSessionId);

    const info = document.createElement('div');
    info.className = 'dashboard-tab-info';

    const name = document.createElement('div');
    name.className = 'dashboard-tab-name';
    name.textContent = session.sessionLabel;

    const details = document.createElement('div');
    details.className = 'dashboard-tab-details';
    details.textContent = `${session.mode} | ${session.connected ? 'Connected' : 'Disconnected'}`;

    info.append(name, details);

    const actions = document.createElement('div');
    actions.className = 'dashboard-tab-actions';

    const switchBtn = document.createElement('button');
    switchBtn.className = 'icon-btn';
    switchBtn.type = 'button';
    switchBtn.title = 'Switch';
    switchBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 18 15 12 9 6"></polyline>
      </svg>
    `;
    switchBtn.addEventListener('click', () => {
      activateSession(sessionId);
      toggleDashboard(false);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn';
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    `;
    closeBtn.addEventListener('click', () => closeSession(sessionId));

    actions.append(switchBtn, closeBtn);
    item.append(info, actions);
    dom.dashboardTabsList.appendChild(item);
  });
}

function closeAllTabs() {
  if (sessions.size === 0) {
    return;
  }

  if (!window.confirm('Close all tabs?')) {
    return;
  }

  getOrderedSessionIds().forEach((sessionId) => closeSession(sessionId));
  toggleDashboard(false);
}

function resetLayoutState() {
  if (!window.confirm('Reset saved workspace layout and reload?')) {
    return;
  }

  persistenceSuppressed = true;
  clearPersistedWorkspaceState();
  window.location.reload();
}

function toggleVirtualKeyboard() {
  dom.virtualKeyboard.classList.toggle('hidden');
  dom.terminalContainer.classList.toggle('keyboard-visible');

  if (!dom.virtualKeyboard.classList.contains('hidden')) {
    dom.tmuxPanel.classList.add('hidden');
    dom.terminalContainer.classList.remove('tmux-visible');
  }

  scheduleWorkspaceLayout(100, true);
}

function toggleTmuxPanel() {
  dom.tmuxPanel.classList.toggle('hidden');
  dom.terminalContainer.classList.toggle('tmux-visible');

  if (!dom.tmuxPanel.classList.contains('hidden')) {
    dom.virtualKeyboard.classList.add('hidden');
    dom.terminalContainer.classList.remove('keyboard-visible');
  }

  scheduleWorkspaceLayout(100, true);
}

function sendInputToSession(session, data) {
  if (!session || !session.socket || session.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  session.socket.send(JSON.stringify({
    type: 'input',
    data
  }));
}

function sendKey(key, modifier) {
  const session = getActiveSession();
  if (!session) {
    return;
  }

  let data = null;

  if (modifier === 'c') {
    data = '\x03';
  } else if (modifier === 'd') {
    data = '\x04';
  } else if (modifier === 'z') {
    data = '\x1a';
  } else if (key === 'Escape') {
    data = '\x1b';
  } else if (key === 'Tab') {
    data = '\t';
  } else if (key === 'Enter') {
    data = '\r';
  } else if (key === 'ArrowUp') {
    data = '\x1b[A';
  } else if (key === 'ArrowDown') {
    data = '\x1b[B';
  } else if (key === 'ArrowLeft') {
    data = '\x1b[D';
  } else if (key === 'ArrowRight') {
    data = '\x1b[C';
  }

  if (data) {
    sendInputToSession(session, data);
  }
}

function sendTmuxCommandInternal(event, command, sessionIdOverride) {
  const session = getSession(sessionIdOverride || activeSessionId);
  if (!session || !session.socket || session.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  let data = '\x02';
  if (command === 'ArrowUp') {
    data += '\x1b[A';
  } else if (command === 'ArrowDown') {
    data += '\x1b[B';
  } else if (command === 'ArrowLeft') {
    data += '\x1b[D';
  } else if (command === 'ArrowRight') {
    data += '\x1b[C';
  } else if (command === '&quot;') {
    data += '"';
  } else {
    data += command;
  }

  sendInputToSession(session, data);

  if (command === '[') {
    setTmuxCopyMode(session, true);
  } else if (command === 'q') {
    setTmuxCopyMode(session, false);
  }

  if (event) {
    const button = event.target.closest('button');
    if (button) {
      button.style.transform = 'scale(0.95)';
      setTimeout(() => {
        button.style.transform = '';
      }, 100);
    }
  }
}

function handleNewTmuxWindow() {
  const session = getActiveSession();
  if (!session) {
    showToast('Open a tmux tab before adding a window.', 'warning');
    return;
  }

  if (!isTmuxMode(session.mode)) {
    showToast('New tmux window is only available inside tmux tabs.', 'warning');
    return;
  }

  if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
    showToast('Session is not connected yet.', 'error');
    return;
  }

  sendTmuxCommandInternal(null, 'c', session.id);
  showToast('Created new tmux window.', 'success', { duration: 2000 });
}

async function handleRenameTmuxSession() {
  const session = getActiveSession();
  if (!session) {
    showToast('Open a tmux tab before renaming.', 'warning');
    return;
  }

  if (!isTmuxMode(session.mode)) {
    showToast('Rename is only available inside tmux tabs.', 'warning');
    return;
  }

  if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
    showToast('Session is not connected yet.', 'error');
    return;
  }

  if (!session.sessionName) {
    showToast('Session name is unavailable for this tab.', 'error');
    return;
  }

  const proposed = window.prompt('Rename tmux session', session.sessionName);
  if (proposed === null) {
    return;
  }

  const newName = proposed.trim();
  if (!newName) {
    showToast('Session name cannot be empty.', 'warning');
    return;
  }

  if (newName === session.sessionName) {
    showToast('Session name unchanged.', 'info', { duration: 2000 });
    return;
  }

  dom.tmuxRenameBtn.disabled = true;

  try {
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    const response = await fetch('/api/tmux/rename', {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        currentName: session.sessionName,
        newName
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to rename tmux session.');
    }

    session.sessionName = newName;
    session.sessionLabel = newName;
    updateSessionPanelState(session);
    invalidateSessionCache();
    updateDashboard();
    updateWorkspaceSummary();
    showToast(`Renamed session to ${newName}`, 'success', { duration: 2500 });
    scheduleWorkspaceSave();
  } catch (err) {
    showToast(err.message || 'Failed to rename tmux session.', 'error', { duration: 0 });
  } finally {
    updateTmuxToolbarButtons();
  }
}

function bindStaticEventHandlers() {
  dom.dashboardBtn.addEventListener('click', () => toggleDashboard());
  dom.dashboardCloseBtn.addEventListener('click', () => toggleDashboard(false));
  dom.newTabBtn.addEventListener('click', () => showSessionSelector());
  dom.sessionSelectorCloseBtn.addEventListener('click', () => hideSessionSelector());
  dom.newShellOption.addEventListener('click', () => showNewSessionForm('new'));
  dom.newTmuxOption.addEventListener('click', () => showNewSessionForm('tmux'));
  dom.cancelSessionBtn.addEventListener('click', () => hideNewSessionForm());
  dom.createSessionBtn.addEventListener('click', () => createSessionFromForm());
  dom.sessionNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      createSessionFromForm();
    }
  });

  dom.dashboardNewTerminalBtn.addEventListener('click', () => showSessionSelector());
  dom.dashboardCloseAllBtn.addEventListener('click', () => closeAllTabs());
  dom.dashboardResetLayoutBtn.addEventListener('click', () => resetLayoutState());

  dom.keyboardBtn.addEventListener('click', () => toggleVirtualKeyboard());
  dom.tmuxBtn.addEventListener('click', () => toggleTmuxPanel());
  dom.tmuxNewWindowBtn.addEventListener('click', () => handleNewTmuxWindow());
  dom.tmuxRenameBtn.addEventListener('click', () => handleRenameTmuxSession());

  dom.virtualKeyboard.querySelectorAll('[data-key]').forEach((button) => {
    button.addEventListener('click', () => {
      sendKey(button.getAttribute('data-key'), button.getAttribute('data-modifier'));
    });
  });

  dom.tmuxPanel.querySelectorAll('[data-tmux-command]').forEach((button) => {
    button.addEventListener('click', (event) => {
      sendTmuxCommandInternal(event, button.getAttribute('data-tmux-command'));
    });
  });

  window.addEventListener('resize', () => {
    scheduleWorkspaceLayout(0, true);
  });

  window.addEventListener('beforeunload', () => {
    persistWorkspaceState();
  });
}

async function restoreWorkspaceState() {
  const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
  if (!raw) {
    return false;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse workspace state:', err);
    clearPersistedWorkspaceState();
    return false;
  }

  if (!payload || payload.version !== WORKSPACE_STATE_VERSION || !Array.isArray(payload.sessions)) {
    clearPersistedWorkspaceState();
    return false;
  }

  const skippedShellDescriptors = payload.sessions.filter((descriptor) => !descriptor.restorable);
  const restorableDescriptors = payload.sessions.filter((descriptor) => descriptor.restorable);
  if (restorableDescriptors.length === 0) {
    clearPersistedWorkspaceState();
    return false;
  }

  isRestoringWorkspace = true;

  try {
    restorableDescriptors.forEach((descriptor) => {
      createTerminalSession({
        sessionLabel: descriptor.sessionLabel || descriptor.sessionName || 'Terminal',
        mode: descriptor.mode,
        sessionName: descriptor.sessionName || '',
        sessionId: descriptor.id,
        activate: false,
        persist: false
      });
    });

    const allowedIds = new Set(restorableDescriptors.map((descriptor) => descriptor.id));
    const filteredLayout = buildFilteredLayout(payload.layout, allowedIds);
    if (filteredLayout) {
      try {
        workspace.fromJSON(filteredLayout, { reuseExistingPanels: true });
      } catch (err) {
        console.error('Failed to restore Dockview layout:', err);
      }
    }

    const preferredActiveId = payload.activeSessionId && allowedIds.has(payload.activeSessionId)
      ? payload.activeSessionId
      : getOrderedSessionIds()[0] || payload.orderedSessionIds?.find((sessionId) => allowedIds.has(sessionId));

    if (preferredActiveId) {
      requestSessionActivation(preferredActiveId, { focusTerminal: true });
    }

    if (skippedShellDescriptors.length > 0) {
      showToast(formatSkippedRestoreMessage(skippedShellDescriptors), 'warning', { duration: 6000 });
    }
  } finally {
    isRestoringWorkspace = false;
    scheduleWorkspaceLayout(0, true);
    persistWorkspaceState();
  }

  return true;
}

async function initializeApp() {
  cacheDomReferences();
  toastContainer = dom.toastContainer;
  initializeWorkspace();
  bindStaticEventHandlers();
  setupMobileDetection();

  const restored = await restoreWorkspaceState();
  if (!restored && sessions.size === 0) {
    await showSessionSelector();
  }

  updateWorkspaceSummary();
  updateTmuxToolbarButtons();
  updateDashboard();
}

document.addEventListener('DOMContentLoaded', () => {
  initializeApp().catch((err) => {
    console.error('Failed to initialize Tailmux:', err);
    showToast('Failed to initialize Tailmux.', 'error', { duration: 0 });
  });
});
