// ==UserScript==
// @name         Save3Clicks for M365 Copilot
// @namespace    anon.local.Save3Clicks
// @version      1.7.0
// @description  Automatically selects a preferred model and focuses the prompt field in Microsoft 365 Copilot.
// @match        https://m365.cloud.microsoft/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  /*
   * ================================================================
   * GUARD AGAINST DUPLICATE INITIALIZATION
   * ================================================================
   */
  if (window.__save3clicks_initialized) {
    return;
  }
  window.__save3clicks_initialized = true;

  /*
   * ================================================================
   * DEFAULT CONFIGURATION
   * ================================================================
   */

  const DEFAULT_MODEL_PATH = [
    'GPT',
    'GPT 5.6 Think deeper'
  ];

  const CHAT_URL_PREFIX = 'https://m365.cloud.microsoft/chat';

  // Persistent Violentmonkey storage keys.
  const KEY_MODEL_PATH = 'modelPath';
  const KEY_SELECTION_ENABLED = 'automaticSelectionEnabled';
  const KEY_FOCUS_ENABLED = 'autoFocusEnabled';

  const NAVIGATION_DELAY_MS = 600;
  const ELEMENT_TIMEOUT_MS = 10000;
  const PROMPT_TIMEOUT_MS = 15000;

  // Internal state.
  let selectionInProgress = false;
  let selectionQueued = false;
  let pendingSelectionTimer = null;
  let pendingFocusTimer = null;
  let lastSuccessfulUrl = null;
  let switcherObserver = null;
  let observedSwitcherRoot = null;
  let pendingSwitcherFrame = null;
  let cachedPromptField = null;

  /*
   * ================================================================
   * CONFIGURATION
   * ================================================================
   */

  function getModelPath() {
    const savedPath = GM_getValue(KEY_MODEL_PATH, DEFAULT_MODEL_PATH);
    if (!Array.isArray(savedPath)) {
      return [...DEFAULT_MODEL_PATH];
    }
    const cleanedPath = savedPath
      .map(value => String(value || '').trim())
      .filter(Boolean);
    return cleanedPath.length > 0 ? cleanedPath : [...DEFAULT_MODEL_PATH];
  }

  function setModelPath(path) {
    const cleanedPath = Array.isArray(path)
      ? path.map(value => String(value || '').trim()).filter(Boolean)
      : [];
    GM_setValue(KEY_MODEL_PATH, cleanedPath.length > 0 ? cleanedPath : [...DEFAULT_MODEL_PATH]);
  }

  function getFinalModelLabel() {
    const path = getModelPath();
    return path[path.length - 1] || DEFAULT_MODEL_PATH[DEFAULT_MODEL_PATH.length - 1];
  }

  function isAutomaticSelectionEnabled() {
    return GM_getValue(KEY_SELECTION_ENABLED, true);
  }

  function setAutomaticSelectionEnabled(enabled) {
    GM_setValue(KEY_SELECTION_ENABLED, Boolean(enabled));
  }

  function isAutoFocusEnabled() {
    return GM_getValue(KEY_FOCUS_ENABLED, true);
  }

  function setAutoFocusEnabled(enabled) {
    GM_setValue(KEY_FOCUS_ENABLED, Boolean(enabled));
  }

  /*
   * ================================================================
   * GENERAL UTILITIES
   * ================================================================
   */

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function sleep(milliseconds) {
    return new Promise(resolve => {
      setTimeout(resolve, milliseconds);
    });
  }

  function isCopilotChatPage() {
    return location.href.startsWith(CHAT_URL_PREFIX);
  }

  /**
   * Returns the rendered rectangle when an element is visibly rendered.
   * Returning the rectangle lets callers reuse the same layout measurement.
   */
  function getVisibleRect(element) {
    if (!element || !element.isConnected) return null;

    const rectangle = element.getBoundingClientRect();
    if (rectangle.width <= 0 || rectangle.height <= 0) return null;

    const style = getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0
    ) {
      return null;
    }

    return rectangle;
  }

  function isVisible(element) {
    return getVisibleRect(element) !== null;
  }

  /**
   * Waits until a finder function returns a value.
   * Uses requestAnimationFrame to debounce DOM reads during heavy mutations.
   */
  function waitForElement(finder, timeout = ELEMENT_TIMEOUT_MS) {
    try {
      const immediateResult = finder();
      if (immediateResult) return Promise.resolve(immediateResult);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      let completed = false;
      let timeoutTimer = null;
      let frameRequest = null;

      function cleanup() {
        if (completed) return;
        completed = true;
        if (timeoutTimer !== null) clearTimeout(timeoutTimer);
        if (frameRequest !== null) cancelAnimationFrame(frameRequest);
        observer.disconnect();
      }

      function check() {
        if (completed) return;

        try {
          const result = finder();
          if (result) {
            cleanup();
            resolve(result);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      }

      const observer = new MutationObserver(() => {
        // Schedule at most one DOM check per animation frame. Continuous
        // mutations cannot postpone the check indefinitely.
        if (frameRequest !== null) return;

        frameRequest = requestAnimationFrame(() => {
          frameRequest = null;
          check();
        });
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'aria-expanded',
          'aria-hidden',
          'aria-label',
          'title',
          'style',
          'class',
          'contenteditable',
          'disabled'
        ]
      });

      timeoutTimer = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for a Copilot interface element'));
      }, timeout);
    });
  }

  /**
   * Safe click implementation compatible with Firefox sandboxing.
   * Deliberately tries focus before synthetic clicking.
   */
  function safeClick(element) {
    if (!element) return false;

    try {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });

      // Attempt native focus first as requested.
      if (typeof element.focus === 'function') {
        element.focus({ preventScroll: true });
      }

      const commonOptions = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0
      };

      element.dispatchEvent(new MouseEvent('mouseover', commonOptions));
      element.dispatchEvent(new MouseEvent('mousemove', commonOptions));
      element.dispatchEvent(new MouseEvent('mousedown', commonOptions));
      element.dispatchEvent(new MouseEvent('mouseup', commonOptions));
      element.click();

      return true;
    } catch (error) {
      console.warn('[Save3Clicks] Click failed:', error);
      return false;
    }
  }

  /*
   * ================================================================
   * PROMPT FIELD DETECTION AND AUTO-FOCUS
   * ================================================================
   */

  function scorePromptCandidate(element) {
    // 1. Cheap structural and semantic checks first to avoid layout thrashing
    if (
      element.disabled ||
      element.getAttribute('aria-disabled') === 'true' ||
      element.getAttribute('contenteditable') === 'false'
    ) {
      return -Infinity;
    }

    // Strictly forbid global M365 search boxes to prevent unwanted focus
    if (element.tagName === 'INPUT' && element.type === 'search') return -Infinity;
    if (element.getAttribute('role') === 'searchbox') return -Infinity;
    if (element.closest('header, [role="banner"], [role="search"], #search-box')) return -Infinity;

    // 2. Perform the necessary layout and style reads once, after the
    // cheap checks have rejected unsuitable candidates.
    const rectangle = getVisibleRect(element);
    if (!rectangle) return -Infinity;
    const searchableText = normalizeText(
      [
        element.getAttribute('aria-label'),
        element.getAttribute('placeholder'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.getAttribute('id'),
        element.getAttribute('class')
      ].filter(Boolean).join(' ')
    );

    let score = 0;
    const verticalPosition = rectangle.top / Math.max(window.innerHeight, 1);
    score += verticalPosition * 100;
    score += Math.min(rectangle.width / 10, 100);

    if (element.tagName === 'TEXTAREA') score += 80;
    if (element.getAttribute('role') === 'textbox') score += 50;
    if (element.isContentEditable) score += 50;

    const positiveTerms = ['prompt', 'message', 'chat', 'copilot', 'ask', 'type', 'draft', 'compose', 'input'];
    for (const term of positiveTerms) {
      if (searchableText.includes(term)) score += 30;
    }

    const negativeTerms = ['search', 'find', 'filter'];
    for (const term of negativeTerms) {
      if (searchableText.includes(term)) score -= 150;
    }

    const surroundingContainer = element.closest('form, [role="form"], [class*="chat"], [class*="input"], [class*="composer"]');
    if (surroundingContainer) {
      score += 30;
      const sendControl = surroundingContainer.querySelector(
        ['button[aria-label*="Send" i]', 'button[title*="Send" i]', 'button[data-testid*="send" i]'].join(', ')
      );
      if (sendControl) score += 100;
    }

    return score;
  }

  function getPromptField() {
    if (!isCopilotChatPage()) return null;

    // Reuse the cached prompt only while it remains connected, visible,
    // enabled, editable, and semantically suitable.
    if (
      cachedPromptField &&
      cachedPromptField.isConnected &&
      Number.isFinite(scorePromptCandidate(cachedPromptField))
    ) {
      return cachedPromptField;
    }

    cachedPromptField = null;

    const selectors = [
      'textarea:not([disabled])',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      '[role="textbox"]:not([aria-disabled="true"])'
    ];

    const candidates = new Set(
      document.querySelectorAll(selectors.join(', '))
    );

    // Only the highest-scoring candidate is needed, so avoid allocating
    // ranking objects and sorting the entire candidate list.
    let bestCandidate = null;
    let bestScore = -Infinity;

    for (const element of candidates) {
      const score = scorePromptCandidate(element);

      if (score > bestScore) {
        bestCandidate = element;
        bestScore = score;
      }
    }

    cachedPromptField = bestCandidate;
    return cachedPromptField;
  }

  function placeCaretAtEnd(element) {
    if (!element.isContentEditable) return;
    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function focusPromptField(force = false) {
    if (!isCopilotChatPage()) return false;
    if (!force && !isAutoFocusEnabled()) return false;

    let promptField;
    try {
      promptField = await waitForElement(() => getPromptField(), PROMPT_TIMEOUT_MS);
    } catch (error) {
      console.warn('[Save3Clicks] Prompt field was not found:', error);
      return false;
    }

    const activeElement = document.activeElement;
    const userIsEditing =
      activeElement &&
      activeElement !== document.body &&
      activeElement !== document.documentElement &&
      (activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.isContentEditable ||
        activeElement.getAttribute('role') === 'textbox');

    // Do not steal focus if the user is already typing in another valid field
    if (!force && userIsEditing && activeElement !== promptField) {
      console.log('[Save3Clicks] Prompt auto-focus skipped because another editable field is active.');
      return false;
    }

    try {
      promptField.scrollIntoView({ block: 'nearest', inline: 'nearest' });

      // First, try native focus as mandated
      if (typeof promptField.focus === 'function') {
        promptField.focus({ preventScroll: true });
      }

      // If focus failed to take effect, fallback to synthetic click
      if (document.activeElement !== promptField) {
        promptField.click();
      }

      placeCaretAtEnd(promptField);

      // Verify focus on the next animation frame. Copilot may replace
      // the prompt node while completing a render.
      return new Promise(resolve => {
        requestAnimationFrame(() => {
          const currentPrompt = getPromptField() || promptField;
          const currentActiveElement = document.activeElement;
          const anotherEditableIsActive =
            currentActiveElement &&
            currentActiveElement !== document.body &&
            currentActiveElement !== document.documentElement &&
            currentActiveElement !== currentPrompt &&
            (currentActiveElement.tagName === 'INPUT' ||
              currentActiveElement.tagName === 'TEXTAREA' ||
              currentActiveElement.isContentEditable ||
              currentActiveElement.getAttribute('role') === 'textbox');

          // Do not undo a newer user action that occurred after the
          // original focus check.
          if (!force && anotherEditableIsActive) {
            console.log('[Save3Clicks] Delayed prompt focus skipped because another editable field is active.');
            resolve(false);
            return;
          }

          if (currentPrompt && typeof currentPrompt.focus === 'function') {
            currentPrompt.focus({ preventScroll: true });
            placeCaretAtEnd(currentPrompt);
          }

          // Some rich-text editors focus a descendant of the selected
          // prompt container, so treat that as a successful focus too.
          const focusedElement = document.activeElement;
          const success = Boolean(
            currentPrompt &&
            (focusedElement === currentPrompt || currentPrompt.contains(focusedElement))
          );

          if (success) {
            console.log('[Save3Clicks] Prompt field focused successfully.');
          } else {
            console.warn('[Save3Clicks] Prompt focus verification failed.');
          }
          resolve(success);
        });
      });
    } catch (error) {
      console.warn('[Save3Clicks] Prompt focus failed with exception:', error);
      return false;
    }
  }

  function schedulePromptFocus(delay = 100, force = false) {
    if (pendingFocusTimer !== null) {
      clearTimeout(pendingFocusTimer);
    }
    
    pendingFocusTimer = setTimeout(() => {
      pendingFocusTimer = null;
      focusPromptField(force).catch(error => {
        console.warn('[Save3Clicks] Scheduled prompt focus failed:', error);
      });
    }, delay);
  }

  /*
   * ================================================================
   * COPILOT INTERFACE DETECTION
   * ================================================================
   */

  function getSwitcherButton() {
    const currentSwitcher = document.getElementById('gptModeSwitcher');
    if (isVisible(currentSwitcher)) return currentSwitcher;

    const candidates = [...document.querySelectorAll([
      'button[aria-haspopup="menu"]',
      'button[aria-haspopup="listbox"]',
      '[role="button"][aria-haspopup="menu"]',
      '[role="button"][aria-haspopup="listbox"]'
    ].join(', '))].filter(isVisible);

    return candidates.find(candidate => {
      const searchableText = normalizeText(
        [candidate.textContent, candidate.getAttribute('aria-label'), candidate.getAttribute('title')]
          .filter(Boolean).join(' ')
      );
      return (
        searchableText.includes('gpt') ||
        searchableText.includes('automatic') ||
        searchableText.includes('automaticky') ||
        searchableText.includes('think deeper') ||
        searchableText.includes('přemýšlení')
      );
    }) || null;
  }

  function getSwitcherText() {
    const switcher = getSwitcherButton();
    if (!switcher) return '';
    return normalizeText(
      [switcher.textContent, switcher.getAttribute('aria-label'), switcher.getAttribute('title')]
        .filter(Boolean).join(' ')
    );
  }

  function isConfiguredModelAlreadyActive() {
    const switcherText = getSwitcherText();
    const targetText = normalizeText(getFinalModelLabel());

    if (!switcherText || !targetText) return false;
    if (switcherText.includes(targetText)) return true;

    const versionExpression = /\bgpt\s*-?\s*(\d+(?:\.\d+)*)\b/;
    const targetVersion = targetText.match(versionExpression)?.[1];
    const switcherVersion = switcherText.match(versionExpression)?.[1];

    if (!targetVersion || !switcherVersion || targetVersion !== switcherVersion) return false;

    const targetIsThinkMode = targetText.includes('think') || targetText.includes('deeper');
    const switcherIsThinkMode = switcherText.includes('think') || switcherText.includes('deeper');

    return targetIsThinkMode === switcherIsThinkMode;
  }

  function isAutomaticModeShown() {
    const switcherText = getSwitcherText();
    return switcherText === 'auto' || switcherText.includes('automatic') || switcherText.includes('automaticky');
  }

  function getOpenMenus() {
    return [...document.querySelectorAll('[role="menu"], [role="listbox"]')].filter(isVisible);
  }

  function getMenuItems(menu) {
    if (!menu) return [];
    return [...menu.querySelectorAll([
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="menuitemcheckbox"]',
      '[role="option"]',
      '[role="button"]',
      'button'
    ].join(', '))].filter(isVisible);
  }

  function getMenuItemText(item) {
    return normalizeText([item.textContent, item.getAttribute('aria-label'), item.getAttribute('title')].filter(Boolean).join(' '));
  }

  function findMenuItem(menu, label) {
    const target = normalizeText(label);
    const items = getMenuItems(menu);
    const exactMatch = items.find(item => getMenuItemText(item) === target);
    if (exactMatch) return exactMatch;
    return items.find(item => getMenuItemText(item).includes(target)) || null;
  }

  function isMenuItemSelected(item) {
    if (!item) return false;
    if (
      item.getAttribute('aria-checked') === 'true' ||
      item.getAttribute('aria-selected') === 'true' ||
      item.getAttribute('data-checked') === 'true'
    ) {
      return true;
    }
    const checkmark = item.querySelector([
      'svg[data-testid*="check"]',
      '[data-icon-name*="Check"]',
      '[aria-label="Selected"]',
      '[aria-label="selected"]'
    ].join(', '));
    return isVisible(checkmark);
  }

  function closeMenus() {
    if (getOpenMenus().length === 0) return;
    const options = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', options));
    target.dispatchEvent(new KeyboardEvent('keyup', options));
  }

  /*
   * ================================================================
   * MODEL SELECTION
   * ================================================================
   */

  async function openSwitcherMenu() {
    const switcher = await waitForElement(() => getSwitcherButton(), ELEMENT_TIMEOUT_MS);
    if (isConfiguredModelAlreadyActive()) throw new Error('CONFIGURED_MODEL_ALREADY_ACTIVE');

    if (getOpenMenus().length > 0) {
      closeMenus();
      await sleep(100);
    }

    const menuCountBeforeClick = getOpenMenus().length;
    if (!safeClick(switcher)) throw new Error('Could not click the model switcher');

    return waitForElement(() => {
      const menus = getOpenMenus();
      if (menus.length > menuCountBeforeClick) return menus[menus.length - 1];
      return null;
    });
  }

  async function openSubmenu(parentItem, previousMenu, nextLabel) {
    const menusBeforeClick = getOpenMenus();
    if (!safeClick(parentItem)) throw new Error(`Could not click submenu item: ${getMenuItemText(parentItem)}`);

    try {
      return await waitForElement(() => {
        const menusAfterClick = getOpenMenus();
        if (menusAfterClick.length > menusBeforeClick.length) return menusAfterClick[menusAfterClick.length - 1];
        
        const newestMenu = menusAfterClick[menusAfterClick.length - 1];
        if (newestMenu && newestMenu !== previousMenu && findMenuItem(newestMenu, nextLabel)) return newestMenu;
        return null;
      }, 4000);
    } catch (firstError) {
      if (typeof parentItem.focus === 'function') parentItem.focus();
      parentItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true, composed: true }));

      return waitForElement(() => {
        const menus = getOpenMenus();
        const newestMenu = menus[menus.length - 1];
        if (newestMenu && newestMenu !== previousMenu && findMenuItem(newestMenu, nextLabel)) return newestMenu;
        return null;
      }, 4000);
    }
  }

  async function selectConfiguredModel() {
    const modelPath = getModelPath();
    if (modelPath.length === 0) throw new Error('No model path is configured');

    let currentMenu = await openSwitcherMenu();

    for (let pathIndex = 0; pathIndex < modelPath.length; pathIndex += 1) {
      const label = modelPath[pathIndex];
      const isFinalItem = pathIndex === modelPath.length - 1;

      console.log(`[Save3Clicks] Looking for item ${pathIndex + 1}/${modelPath.length}:`, label);
      const item = await waitForElement(() => findMenuItem(currentMenu, label), 6000);

      if (isFinalItem) {
        if (isMenuItemSelected(item)) {
          closeMenus();
          return 'already-selected';
        }
        if (!safeClick(item)) throw new Error(`Could not click final model: ${label}`);
        await sleep(250);
        return 'selected';
      }

      currentMenu = await openSubmenu(item, currentMenu, modelPath[pathIndex + 1]);
    }
    throw new Error('The configured model path was not completed');
  }

  async function runSelection(force = false) {
    if (selectionInProgress) {
      selectionQueued = true;
      return 'queued';
    }

    if (!isCopilotChatPage()) return 'not-a-chat-page';

    if (!force && !isAutomaticSelectionEnabled()) {
      schedulePromptFocus(100);
      return 'disabled';
    }

    selectionInProgress = true;
    try {
      await waitForElement(() => getSwitcherButton(), ELEMENT_TIMEOUT_MS);
      await sleep(150);

      if (isConfiguredModelAlreadyActive()) {
        lastSuccessfulUrl = location.href;
        console.log('[Save3Clicks] Configured model is already active:', getSwitcherText());
        schedulePromptFocus(50);
        return 'already-selected';
      }

      console.log('[Save3Clicks] Starting selection:', getModelPath().join(' -> '));
      const result = await selectConfiguredModel();
      lastSuccessfulUrl = location.href;
      
      console.log('[Save3Clicks] Selection finished:', result);
      schedulePromptFocus(200);
      return result;
    } catch (error) {
      closeMenus();
      if (error instanceof Error && error.message === 'CONFIGURED_MODEL_ALREADY_ACTIVE') {
        lastSuccessfulUrl = location.href;
        console.log('[Save3Clicks] Configured model became active before the menu was opened.');
        schedulePromptFocus(100);
        return 'already-selected';
      }

      console.warn('[Save3Clicks] Selection failed:', error);
      schedulePromptFocus(200);
      throw error;
    } finally {
      selectionInProgress = false;
      if (selectionQueued) {
        selectionQueued = false;
        scheduleSelection(100);
      }
    }
  }

  function scheduleSelection(delay = NAVIGATION_DELAY_MS) {
    if (!isAutomaticSelectionEnabled()) {
      schedulePromptFocus(delay);
      return;
    }

    if (pendingSelectionTimer !== null) clearTimeout(pendingSelectionTimer);

    pendingSelectionTimer = setTimeout(() => {
      pendingSelectionTimer = null;
      runSelection(false).catch(() => {});
    }, delay);
  }

  /*
   * ================================================================
   * COPILOT NAVIGATION DETECTION
   * ================================================================
   */

  function installHistoryWatcher() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...argumentsList) {
      const result = originalPushState.apply(this, argumentsList);
      window.dispatchEvent(new Event('save3clicks:navigation'));
      return result;
    };

    history.replaceState = function (...argumentsList) {
      const result = originalReplaceState.apply(this, argumentsList);
      window.dispatchEvent(new Event('save3clicks:navigation'));
      return result;
    };

    window.addEventListener('popstate', () => {
      window.dispatchEvent(new Event('save3clicks:navigation'));
    });

    window.addEventListener('save3clicks:navigation', () => {
      lastSuccessfulUrl = null;
      cachedPromptField = null; // Clear cached element on client-side routing
      scheduleSelection();
      setTimeout(() => installSwitcherObserver(), NAVIGATION_DELAY_MS);
    });
  }

  async function installSwitcherObserver() {
    let switcher;
    try {
      switcher = await waitForElement(() => getSwitcherButton(), 15000);
    } catch (error) {
      console.warn('[Save3Clicks] Model switcher was not found during initialization.');
      return;
    }

    const observationRoot = switcher.parentElement || switcher;
    if (switcherObserver && observedSwitcherRoot === observationRoot && observationRoot.isConnected) return;
    
    // Clean up an observer and animation-frame callback associated with
    // an obsolete switcher subtree before watching the new subtree.
    if (switcherObserver) switcherObserver.disconnect();

    if (pendingSwitcherFrame !== null) {
      cancelAnimationFrame(pendingSwitcherFrame);
      pendingSwitcherFrame = null;
    }

    observedSwitcherRoot = observationRoot;
    switcherObserver = new MutationObserver(() => {
      // Evaluate the switcher state at most once per animation frame.
      if (pendingSwitcherFrame !== null) return;

      pendingSwitcherFrame = requestAnimationFrame(() => {
        pendingSwitcherFrame = null;

        // Ignore a callback left over from an obsolete or detached subtree.
        if (
          !observationRoot.isConnected ||
          observedSwitcherRoot !== observationRoot
        ) {
          return;
        }

        if (isAutomaticModeShown()) {
          lastSuccessfulUrl = null;
          scheduleSelection(300);
        }
      });
    });

    switcherObserver.observe(observationRoot, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-label', 'title', 'aria-expanded']
    });
  }

  /*
   * ================================================================
   * VIOLENTMONKEY MENU COMMANDS
   * ================================================================
   */

  function registerMenuCommands() {
    GM_registerMenuCommand(`Set model path: ${getModelPath().join(' -> ')}`, () => {
      const currentPath = getModelPath().join(' | ');
      const enteredPath = prompt(
        ['Enter the model path.', '', 'Separate menu levels with | or a line break.', '', 'Example:', 'GPT | GPT 5.6 Think deeper'].join('\n'),
        currentPath
      );
      if (enteredPath === null) return;
      const newPath = enteredPath.split(/\r?\n|\|/).map(value => value.trim()).filter(Boolean);
      setModelPath(newPath);
      lastSuccessfulUrl = null;
      alert(`Saved model path:\n${getModelPath().join(' -> ')}`);
    });

    GM_registerMenuCommand(`Toggle automatic selection: ${isAutomaticSelectionEnabled() ? 'ON' : 'OFF'}`, () => {
      const newValue = !isAutomaticSelectionEnabled();
      setAutomaticSelectionEnabled(newValue);
      alert(`Automatic selection is now ${newValue ? 'ON' : 'OFF'}.`);
      if (newValue) {
        lastSuccessfulUrl = null;
        scheduleSelection(100);
      } else {
        if (pendingSelectionTimer !== null) clearTimeout(pendingSelectionTimer);
        pendingSelectionTimer = null;
        schedulePromptFocus(100);
      }
    });
    
    GM_registerMenuCommand(`Toggle prompt auto-focus: ${isAutoFocusEnabled() ? 'ON' : 'OFF'}`, () => {
      const newValue = !isAutoFocusEnabled();
      setAutoFocusEnabled(newValue);
      alert(`Prompt auto-focus is now ${newValue ? 'ON' : 'OFF'}.`);
      if (newValue) {
        schedulePromptFocus(100);
      }
    });

    GM_registerMenuCommand('Select configured model now', async () => {
      try {
        const result = await runSelection(true);
        alert(['Model-selection attempt completed.', '', `Result: ${result}`, `Path: ${getModelPath().join(' -> ')}`].join('\n'));
      } catch (error) {
        alert(`Model selection failed:\n${error.message}`);
      }
    });

    GM_registerMenuCommand('Focus prompt field now', async () => {
      const focused = await focusPromptField(true);
      if (!focused) alert('The Copilot prompt field could not be found or focused.');
    });

    GM_registerMenuCommand('Reset model path to default', () => {
      setModelPath(DEFAULT_MODEL_PATH);
      lastSuccessfulUrl = null;
      alert(`Model path reset:\n${DEFAULT_MODEL_PATH.join(' -> ')}`);
    });

    GM_registerMenuCommand('Show current configuration', () => {
      const promptField = getPromptField();
      const focusedElement = document.activeElement;
      const promptIsFocused = Boolean(
        promptField &&
        (focusedElement === promptField || promptField.contains(focusedElement))
      );

      alert([
        'Save3Clicks configuration',
        '',
        'Version: 1.7.0',
        `Automatic selection: ${isAutomaticSelectionEnabled() ? 'ON' : 'OFF'}`,
        `Prompt auto-focus: ${isAutoFocusEnabled() ? 'ON' : 'OFF'}`,
        `Model path: ${getModelPath().join(' -> ')}`,
        `Current URL: ${location.href}`,
        `Chat page: ${isCopilotChatPage() ? 'YES' : 'NO'}`,
        `Switcher text: ${getSwitcherText() || '(not found)'}`,
        `Configured model active: ${isConfiguredModelAlreadyActive() ? 'YES' : 'NO'}`,
        `Prompt field found: ${promptField ? 'YES' : 'NO'}`,
        `Prompt field focused: ${promptIsFocused ? 'YES' : 'NO'}`,
        `Last successfully handled URL: ${lastSuccessfulUrl || '(none)'}`
      ].join('\n'));
    });
  }

  /*
   * ================================================================
   * INITIALIZATION
   * ================================================================
   */

  function initialize() {
    console.log('[Save3Clicks] Initializing version 1.7.0');
    console.log('[Save3Clicks] Configured model path:', getModelPath().join(' -> '));

    registerMenuCommands();
    installHistoryWatcher();
    installSwitcherObserver();

    scheduleSelection(500);
    schedulePromptFocus(2000);
  }

  initialize();
})();
