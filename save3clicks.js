// ==UserScript==
// @name         Save3Clicks
// @namespace    anon.local.Save3Clicks
// @version      1.1.0
// @description  On matching URLs, open the mode switcher, optionally click More, and select a configured mode.
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  // CHANGE DEFAULT MODE HERE IF THERE ARE UPDATES TO M365 COPILOT
  const DEFAULT_MODE = 'GPT-5.4 Think deeper';
  // SOME M365 HAVE UNIQUE URLS BASED ON ORGANIZATION
  // THESE ARE MY DEFAULTS SO JUST ADD MORE
  const DEFAULT_URL_RULES = [
    'https://m365.cloud.microsoft/chat?fromCode=CsrToSSR',
    'https://m365.cloud.microsoft/chat'
  ];

  const KEY_MODE = 'targetMode';
  const KEY_URL_RULES = 'urlRules';
  const KEY_ALWAYS_CLICK_MORE = 'alwaysClickMore';

  let lastProcessedUrl = null;
  let runInProgress = false;

  function getMode() {
    return GM_getValue(KEY_MODE, DEFAULT_MODE);
  }

  function setMode(value) {
    GM_setValue(KEY_MODE, String(value || '').trim() || DEFAULT_MODE);
  }

  function getUrlRules() {
    const saved = GM_getValue(KEY_URL_RULES, DEFAULT_URL_RULES);
    return Array.isArray(saved) ? saved : DEFAULT_URL_RULES;
  }

  function setUrlRules(lines) {
    const rules = String(lines || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    GM_setValue(KEY_URL_RULES, rules);
  }

  function getAlwaysClickMore() {
    return GM_getValue(KEY_ALWAYS_CLICK_MORE, true);
  }

  function setAlwaysClickMore(value) {
    GM_setValue(KEY_ALWAYS_CLICK_MORE, !!value);
  }

  function normalizeText(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function ruleMatchesUrl(rule, url) {
    if (!rule) return false;

    if (rule.startsWith('/') && rule.endsWith('/')) {
      try {
        const rx = new RegExp(rule.slice(1, -1));
        return rx.test(url);
      } catch {
        return false;
      }
    }

    return url.includes(rule);
  }

  function currentUrlMatches() {
    const rules = getUrlRules();
    if (!rules.length) return false;
    const url = location.href;
    return rules.some(rule => ruleMatchesUrl(rule, url));
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  async function waitForFinder(findFn, { timeout = 8000, interval = 100 } = {}) {
    const immediate = findFn();
    if (immediate) return immediate;

    return new Promise((resolve, reject) => {
      const started = Date.now();

      const timer = setInterval(() => {
        const found = findFn();
        if (found) {
          cleanup();
          resolve(found);
          return;
        }
        if (Date.now() - started > timeout) {
          cleanup();
          reject(new Error('Timeout waiting for element'));
        }
      }, interval);

      const observer = new MutationObserver(() => {
        const found = findFn();
        if (found) {
          cleanup();
          resolve(found);
        }
      });

      function cleanup() {
        clearInterval(timer);
        observer.disconnect();
      }

      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    });
  }

  // clicker
  function safeClick(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.click();
      return true;
    } catch (err) {
      console.warn('[AutoMode] Click failed:', err);
      return false;
    }
  }

  // hard coded id name for the element, ill update this if it changes in the future
  function getSwitcherButton() {
    return document.getElementById('gptModeSwitcher');
  }

  function getOpenMenus() {
    return [...document.querySelectorAll('div[role="menu"]')];
  }

  function getMenuItems() {
    const menus = getOpenMenus();
    const items = menus.flatMap(menu => [...menu.querySelectorAll('[role="menuitem"], [role="button"]')]);
    return items.filter(isVisible);
  }

  function findItemByLabel(label) {
    const target = normalizeText(label);
    return getMenuItems().find(el => normalizeText(el.textContent).includes(target)) || null;
  }

  function isItemSelected(item) {
    if (!item) return false;

    const visibleCheckmark = item.querySelector(
      'span[style*="visibility: visible"] svg[data-testid^="checkmark"]'
    );
    if (visibleCheckmark) return true;

    const anyVisibleCheck = [...item.querySelectorAll('svg[data-testid^="checkmark"]')]
      .some(svg => {
        const parent = svg.closest('span') || svg;
        return isVisible(parent);
      });

    return anyVisibleCheck;
  }

  async function openSwitcherMenu() {
    // if the menu = open then do nothing, otherwise open
    if (getMenuItems().length) return true;

    const btn = await waitForFinder(() => getSwitcherButton(), { timeout: 12000 });
    if (!btn) throw new Error('gptModeSwitcher not found');

    safeClick(btn);

    await waitForFinder(() => getMenuItems().length > 0 ? getMenuItems()[0] : null, {
      timeout: 6000
    });

    return true;
  }

  async function clickMoreIfPresent() {
    if (!getAlwaysClickMore()) return 'skipped-disabled';

    // find the more button by label
    let moreItem = findItemByLabel('More');

    // retry in case your webpage is slow to load
    if (!moreItem) {
      await sleep(250);
      moreItem = findItemByLabel('More');
    }

    if (!moreItem) {
      return 'not-found';
    }

    // if it looks like a submenu then click it
    safeClick(moreItem);

    // even more time for slow ui
    await sleep(250);
    return 'clicked';
  }

  async function selectMode(modeLabel) {
    await openSwitcherMenu();
    await clickMoreIfPresent();

    let item = findItemByLabel(modeLabel);

    // even more time for slow ur but for finindng the item this time
    if (!item) {
      await sleep(300);
      item = findItemByLabel(modeLabel);
    }

    if (!item) {
      throw new Error(`Mode not found in menu: ${modeLabel}`);
    }

    if (isItemSelected(item)) {
      console.log('[AutoMode] Already selected:', modeLabel);
      return 'already-selected';
    }

    safeClick(item);
    console.log('[AutoMode] Clicked mode:', modeLabel);
    return 'clicked';
  }

  async function runOnceForCurrentUrl() {
    if (runInProgress) return;
    if (!currentUrlMatches()) return;
    if (lastProcessedUrl === location.href) return;

    runInProgress = true;
    try {
      const mode = getMode();
      await selectMode(mode);
      lastProcessedUrl = location.href;
    } catch (err) {
      console.warn('[AutoMode] Failed:', err);
    } finally {
      runInProgress = false;
    }
  }

  function registerMenu() {
    GM_registerMenuCommand(`Set target mode (current: ${getMode()})`, () => {
      const next = prompt('Enter the exact menu label to click:', getMode());
      if (next != null) {
        setMode(next);
        alert(`Saved target mode:\n${getMode()}`);
      }
    });

    GM_registerMenuCommand(
      `Toggle "click More first" (currently: ${getAlwaysClickMore() ? 'ON' : 'OFF'})`,
      () => {
        setAlwaysClickMore(!getAlwaysClickMore());
        alert(`click More first = ${getAlwaysClickMore() ? 'ON' : 'OFF'}`);
      }
    );

    GM_registerMenuCommand('Set URL rules (one per line; substring or /regex/)', () => {
      const current = getUrlRules().join('\n');
      const next = prompt(
        'Enter URL rules, one per line.\n\nExamples:\nhttps://copilot.microsoft.com/\n/copilot\\.microsoft\\.com\\/.*/',
        current
      );
      if (next != null) {
        setUrlRules(next);
        alert(`Saved ${getUrlRules().length} URL rule(s).`);
      }
    });

    GM_registerMenuCommand('Run now on this page', async () => {
      try {
        await selectMode(getMode());
        alert(`Done: attempted to select "${getMode()}"`);
      } catch (err) {
        alert(`Failed: ${err.message}`);
      }
    });
  }

  function initUrlWatcher() {
    let lastUrl = location.href;

    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastProcessedUrl = null;
        runOnceForCurrentUrl();
      }
    }, 500);

    // runs it once but retries if fails
    runOnceForCurrentUrl();
    setTimeout(runOnceForCurrentUrl, 1500);
    setTimeout(runOnceForCurrentUrl, 3500);
  }

  registerMenu();
  initUrlWatcher();
})();