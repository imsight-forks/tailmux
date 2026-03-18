const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = 'http://127.0.0.1:18200/';
const TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCount(locator, expected, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.count() === expected) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for count ${expected}`);
}

async function waitForVisible(locator, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isVisible().catch(() => false)) {
      return;
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for element to become visible');
}

async function waitForHidden(locator, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await locator.isVisible().catch(() => false))) {
      return;
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for element to become hidden');
}

async function waitForText(locator, expected, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = (await locator.textContent().catch(() => '')) || '';
    if (typeof expected === 'string' ? text.includes(expected) : expected.test(text)) {
      return text;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for text ${expected}`);
}

async function createShell(page, label) {
  await page.getByRole('button', { name: /New Shell Session/i }).click();
  await page.locator('#session-name').fill(label);
  await page.locator('#create-session-btn').click();
  await waitForHidden(page.locator('#session-selector'));
  await waitForVisible(page.locator('.tailmux-dockview-tab-label').filter({ hasText: label }));
}

async function openNewTabMenu(page) {
  await page.locator('#new-tab-btn').click();
  await waitForVisible(page.locator('#session-selector'));
}

async function attachExistingSession(page, sessionName) {
  await page.locator('.session-option').filter({ hasText: `Attach to: ${sessionName}` }).first().click();
  await waitForHidden(page.locator('#session-selector'));
  await waitForVisible(page.locator('.tailmux-dockview-tab-label').filter({ hasText: sessionName }));
}

async function getGroupWithTab(page, label) {
  const groups = page.locator('.dv-groupview');
  const count = await groups.count();

  for (let index = 0; index < count; index += 1) {
    const group = groups.nth(index);
    if (await group.locator('.tailmux-dockview-tab-label').filter({ hasText: label }).count() > 0) {
      return group;
    }
  }

  throw new Error(`No group found for tab ${label}`);
}

async function dragTabTo(page, label, target, targetPosition) {
  const source = page.locator('.tailmux-dockview-tab-label').filter({ hasText: label }).first();
  await waitForVisible(source);
  await source.dragTo(target, { targetPosition });
}

async function getTrimmedTexts(locator) {
  return (await locator.allTextContents()).map((text) => text.trim()).filter(Boolean);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());

  const shellLabel = `shell-split-${Date.now()}`;

  try {
    await page.goto(BASE_URL);
    await waitForVisible(page.locator('#session-selector'));

    await createShell(page, shellLabel);
    await openNewTabMenu(page);
    await attachExistingSession(page, 'main');
    await openNewTabMenu(page);
    await attachExistingSession(page, 'agent-1');

    await waitForCount(page.locator('.dv-groupview'), 1);
    await waitForCount(page.locator('.tailmux-dockview-tab-label'), 3);

    const mainTab = page.locator('.tailmux-dockview-tab-label').filter({ hasText: 'main' }).first();
    const agentTab = page.locator('.tailmux-dockview-tab-label').filter({ hasText: 'agent-1' }).first();
    await agentTab.dragTo(mainTab, { targetPosition: { x: 6, y: 10 } });

    const reordered = await getTrimmedTexts(page.locator('.dv-groupview').first().locator('.tailmux-dockview-tab-label'));
    assert.deepEqual(reordered, [shellLabel, 'agent-1', 'main']);

    const singleGroupContent = page.locator('.dv-groupview').first().locator('.dv-content-container');
    const singleGroupBox = await singleGroupContent.boundingBox();
    await dragTabTo(page, 'main', singleGroupContent, {
      x: Math.max(6, Math.floor(singleGroupBox.width) - 12),
      y: Math.floor(singleGroupBox.height / 2)
    });

    await waitForCount(page.locator('.dv-groupview'), 2);
    const verticalBoxes = await Promise.all([
      page.locator('.dv-groupview').nth(0).boundingBox(),
      page.locator('.dv-groupview').nth(1).boundingBox()
    ]);
    assert.ok(Math.abs(verticalBoxes[0].x - verticalBoxes[1].x) > 50, 'expected vertical split');
    assert.ok(Math.abs(verticalBoxes[0].y - verticalBoxes[1].y) < 60, 'vertical split should share row');

    const shellGroupTabs = (await getGroupWithTab(page, shellLabel)).locator('.dv-tabs-and-actions-container');
    const shellTabsBox = await shellGroupTabs.boundingBox();
    await dragTabTo(page, 'main', shellGroupTabs, {
      x: Math.floor(shellTabsBox.width / 2),
      y: Math.floor(shellTabsBox.height / 2)
    });

    await waitForCount(page.locator('.dv-groupview'), 1);
    const regrouped = await getTrimmedTexts(page.locator('.dv-groupview').first().locator('.tailmux-dockview-tab-label'));
    assert.deepEqual(regrouped, [shellLabel, 'agent-1', 'main']);

    const regroupedContent = page.locator('.dv-groupview').first().locator('.dv-content-container');
    const regroupedBox = await regroupedContent.boundingBox();
    await dragTabTo(page, 'agent-1', regroupedContent, {
      x: Math.floor(regroupedBox.width / 2),
      y: Math.max(6, Math.floor(regroupedBox.height) - 12)
    });

    await waitForCount(page.locator('.dv-groupview'), 2);
    const horizontalBoxes = await Promise.all([
      page.locator('.dv-groupview').nth(0).boundingBox(),
      page.locator('.dv-groupview').nth(1).boundingBox()
    ]);
    assert.ok(Math.abs(horizontalBoxes[0].y - horizontalBoxes[1].y) > 50, 'expected horizontal split');

    const agentGroup = await getGroupWithTab(page, 'agent-1');
    await agentGroup.locator('.tailmux-panel-host').click();
    await waitForText(page.locator('#workspace-active-session'), 'agent-1');
    assert.equal(await page.locator('#tmux-new-window-btn').isEnabled(), true);
    assert.equal(await page.locator('#tmux-rename-btn').isEnabled(), true);

    await page.locator('.tailmux-dockview-tab-label').filter({ hasText: shellLabel }).first().click();
    const shellGroup = await getGroupWithTab(page, shellLabel);
    await shellGroup.locator('.tailmux-panel-host').click();
    await waitForText(page.locator('#workspace-active-session'), shellLabel);
    assert.equal(await page.locator('#tmux-new-window-btn').isEnabled(), false);
    assert.equal(await page.locator('#tmux-rename-btn').isEnabled(), false);

    await page.locator('#dashboard-btn').click();
    await waitForVisible(page.locator('#dashboard'));
    await waitForCount(page.locator('#dashboard-tabs-list .dashboard-tab-item'), 3);
    const agentRow = page.locator('#dashboard-tabs-list .dashboard-tab-item').filter({ hasText: 'agent-1' }).first();
    await agentRow.locator('button[title="Switch"]').click();
    await waitForHidden(page.locator('#dashboard'));
    await waitForText(page.locator('#workspace-active-session'), 'agent-1');

    await page.reload();
    await waitForCount(page.locator('.dv-groupview'), 2);
    await waitForVisible(page.locator('.tailmux-dockview-tab-label').filter({ hasText: 'main' }));
    await waitForVisible(page.locator('.tailmux-dockview-tab-label').filter({ hasText: 'agent-1' }));
    assert.equal(await page.locator('.tailmux-dockview-tab-label').filter({ hasText: shellLabel }).count(), 0);
    await waitForText(page.locator('#workspace-active-session'), 'agent-1');
    await waitForText(page.locator('#toast-container'), /Skipped restoring shell tab/);

    await page.locator('#dashboard-btn').click();
    await waitForVisible(page.locator('#dashboard'));
    await page.locator('#dashboard-reset-layout-btn').click();
    await waitForVisible(page.locator('#session-selector'));
    await waitForCount(page.locator('.tailmux-dockview-tab-label'), 0);

    console.log('Tailmux split verification passed.');
  } catch (error) {
    await page.screenshot({ path: '/tmp/tailmux-split-verification-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
