// ==UserScript==
// @name         Save3Clicks for M365 Copilot
// @namespace    anon.local.Save3Clicks
// @version      1.2.0
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
   * DEFAULT CONFIGURATION
   * ================================================================
   */

  /*
   * Each array item represents one menu click.
   *
   * Current Copilot menu arrangement:
   *
   * 1. Open the model selector.
   * 2. Click "GPT".
   * 3. Click "GPT 5.6 Think deeper" in the submenu.
   */
  const DEFAULT_MODEL_PATH = [
    'GPT',
    'GPT 5.6 Think deeper'
  ];

  /*
   * Automatic selection and prompt focusing run only on Copilot Chat
   * URLs.
   */
  const CHAT_URL_PREFIX =
    'https://m365.cloud.microsoft/chat';

  /*
   * Persistent Violentmonkey storage keys.
   */
  const KEY_MODEL_PATH = 'modelPath';
  const KEY_ENABLED = 'automaticSelectionEnabled';

  /*
   * Delay after an internal Copilot navigation.
   */
  const NAVIGATION_DELAY_MS = 600;

  /*
   * Maximum time to wait for a Copilot interface element.
   */
  const ELEMENT_TIMEOUT_MS = 10000;

  /*
   * Maximum time to wait for the Copilot prompt field.
   */
  const PROMPT_TIMEOUT_MS = 15000;

  /*
   * Internal state.
   */
  let selectionInProgress = false;
  let pendingSelectionTimer = null;
  let pendingFocusTimer = null;
  let lastSuccessfulUrl = null;
  let switcherObserver = null;
  let observedSwitcherRoot = null;

  /*
   * ================================================================
   * CONFIGURATION
   * ================================================================
   */

  /**
   * Returns the stored model-menu path.
   *
   * @returns {string[]}
   */
  function getModelPath() {
    const savedPath = GM_getValue(
      KEY_MODEL_PATH,
      DEFAULT_MODEL_PATH
    );

    if (!Array.isArray(savedPath)) {
      return [...DEFAULT_MODEL_PATH];
    }

    const cleanedPath = savedPath
      .map(value => String(value || '').trim())
      .filter(Boolean);

    return cleanedPath.length > 0
      ? cleanedPath
      : [...DEFAULT_MODEL_PATH];
  }

  /**
   * Stores a model-menu path.
   *
   * @param {string[]} path
   */
  function setModelPath(path) {
    const cleanedPath = Array.isArray(path)
      ? path
          .map(value => String(value || '').trim())
          .filter(Boolean)
      : [];

    GM_setValue(
      KEY_MODEL_PATH,
      cleanedPath.length > 0
        ? cleanedPath
        : [...DEFAULT_MODEL_PATH]
    );
  }

  /**
   * Returns the final model label from the configured path.
   *
   * @returns {string}
   */
  function getFinalModelLabel() {
    const path = getModelPath();

    return (
      path[path.length - 1] ||
      DEFAULT_MODEL_PATH[
        DEFAULT_MODEL_PATH.length - 1
      ]
    );
  }

  /**
   * Returns whether automatic selection is enabled.
   *
   * @returns {boolean}
   */
  function isAutomaticSelectionEnabled() {
    return GM_getValue(KEY_ENABLED, true);
  }

  /**
   * Enables or disables automatic selection.
   *
   * @param {boolean} enabled
   */
  function setAutomaticSelectionEnabled(enabled) {
    GM_setValue(KEY_ENABLED, Boolean(enabled));
  }

  /*
   * ================================================================
   * GENERAL UTILITIES
   * ================================================================
   */

  /**
   * Converts displayed text into a consistent comparison form.
   *
   * @param {*} value
   * @returns {string}
   */
  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Waits for the specified duration.
   *
   * @param {number} milliseconds
   * @returns {Promise<void>}
   */
  function sleep(milliseconds) {
    return new Promise(resolve => {
      setTimeout(resolve, milliseconds);
    });
  }

  /**
   * Returns whether the current URL is a Copilot Chat URL.
   *
   * @returns {boolean}
   */
  function isCopilotChatPage() {
    return location.href.startsWith(
      CHAT_URL_PREFIX
    );
  }

  /**
   * Returns whether an element is visibly rendered.
   *
   * @param {Element|null} element
   * @returns {boolean}
   */
  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }

    const rectangle =
      element.getBoundingClientRect();

    if (
      rectangle.width <= 0 ||
      rectangle.height <= 0
    ) {
      return false;
    }

    const style = getComputedStyle(element);

    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0
    );
  }

  /**
   * Waits until a finder function returns a value.
   *
   * The MutationObserver exists only while waiting and is disconnected
   * immediately after success or timeout.
   *
   * @param {Function} finder
   * @param {number} timeout
   * @returns {Promise<*>}
   */
  function waitForElement(
    finder,
    timeout = ELEMENT_TIMEOUT_MS
  ) {
    const immediateResult = finder();

    if (immediateResult) {
      return Promise.resolve(immediateResult);
    }

    return new Promise((resolve, reject) => {
      let completed = false;
      let timeoutTimer = null;

      /**
       * Stops the temporary observer and timeout.
       */
      function cleanup() {
        if (completed) {
          return;
        }

        completed = true;

        if (timeoutTimer !== null) {
          clearTimeout(timeoutTimer);
        }

        observer.disconnect();
      }

      /**
       * Checks whether the requested element is available.
       */
      function check() {
        if (completed) {
          return;
        }

        const result = finder();

        if (result) {
          cleanup();
          resolve(result);
        }
      }

      const observer =
        new MutationObserver(check);

      observer.observe(
        document.documentElement,
        {
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
        }
      );

      timeoutTimer = setTimeout(() => {
        cleanup();

        reject(
          new Error(
            'Timeout waiting for a Copilot interface element'
          )
        );
      }, timeout);
    });
  }

  /**
   * Performs a Firefox-compatible click.
   *
   * MouseEventInit.view is deliberately omitted because Firefox can
   * reject Violentmonkey's sandboxed window proxy.
   *
   * @param {Element|null} element
   * @returns {boolean}
   */
  function safeClick(element) {
    if (!element) {
      return false;
    }

    try {
      element.scrollIntoView({
        block: 'nearest',
        inline: 'nearest'
      });

      /*
       * Focus improves submenu activation in Fluent UI.
       */
      if (
        typeof element.focus === 'function'
      ) {
        element.focus();
      }

      const commonOptions = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0
      };

      element.dispatchEvent(
        new MouseEvent(
          'mouseover',
          commonOptions
        )
      );

      element.dispatchEvent(
        new MouseEvent(
          'mousemove',
          commonOptions
        )
      );

      element.dispatchEvent(
        new MouseEvent(
          'mousedown',
          commonOptions
        )
      );

      element.dispatchEvent(
        new MouseEvent(
          'mouseup',
          commonOptions
        )
      );

      element.click();

      return true;
    } catch (error) {
      console.warn(
        '[Save3Clicks] Click failed:',
        error
      );

      return false;
    }
  }

  /*
   * ================================================================
   * PROMPT FIELD DETECTION AND AUTO-FOCUS
   * ================================================================
   */

  /**
   * Assigns a suitability score to a possible Copilot prompt field.
   *
   * A higher score means that the element is more likely to be the
   * main chat composer rather than a search field or another textbox.
   *
   * @param {Element} element
   * @returns {number}
   */
  function scorePromptCandidate(element) {
    if (!isVisible(element)) {
      return -Infinity;
    }

    if (
      element.disabled ||
      element.getAttribute('aria-disabled') === 'true' ||
      element.getAttribute('contenteditable') === 'false'
    ) {
      return -Infinity;
    }

    const rectangle =
      element.getBoundingClientRect();

    const searchableText = normalizeText(
      [
        element.getAttribute('aria-label'),
        element.getAttribute('placeholder'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.getAttribute('id'),
        element.getAttribute('class')
      ]
        .filter(Boolean)
        .join(' ')
    );

    let score = 0;

    /*
     * The main prompt field is normally located in the lower part of
     * the window.
     */
    const verticalPosition =
      rectangle.top /
      Math.max(window.innerHeight, 1);

    score += verticalPosition * 100;

    /*
     * The main prompt is generally wider than search fields and other
     * auxiliary controls.
     */
    score += Math.min(
      rectangle.width / 10,
      100
    );

    if (
      element.tagName === 'TEXTAREA'
    ) {
      score += 80;
    }

    if (
      element.getAttribute('role') ===
      'textbox'
    ) {
      score += 50;
    }

    if (element.isContentEditable) {
      score += 50;
    }

    /*
     * Positive indicators commonly used for the Copilot composer.
     */
    const positiveTerms = [
      'prompt',
      'message',
      'chat',
      'copilot',
      'ask',
      'type',
      'draft',
      'compose',
      'input'
    ];

    for (const term of positiveTerms) {
      if (searchableText.includes(term)) {
        score += 30;
      }
    }

    /*
     * Penalize controls that are likely to be site search fields.
     */
    const negativeTerms = [
      'search',
      'find',
      'filter'
    ];

    for (const term of negativeTerms) {
      if (searchableText.includes(term)) {
        score -= 150;
      }
    }

    /*
     * Prefer elements inside a form or a region containing a send
     * button.
     */
    const surroundingContainer =
      element.closest(
        'form, [role="form"], [class*="chat"], [class*="input"], [class*="composer"]'
      );

    if (surroundingContainer) {
      score += 30;

      const sendControl =
        surroundingContainer.querySelector(
          [
            'button[aria-label*="Send" i]',
            'button[title*="Send" i]',
            'button[data-testid*="send" i]'
          ].join(', ')
        );

      if (sendControl) {
        score += 100;
      }
    }

    return score;
  }

  /**
   * Finds the most likely Copilot prompt field.
   *
   * @returns {Element|null}
   */
  function getPromptField() {
    if (!isCopilotChatPage()) {
      return null;
    }

    const selectors = [
      'textarea:not([disabled])',
      '[contenteditable="true"][role="textbox"]',
      '[role="textbox"][contenteditable="true"]',
      '[contenteditable="true"]',
      '[role="textbox"]:not([aria-disabled="true"])'
    ];

    const candidates = [
      ...new Set(
        document.querySelectorAll(
          selectors.join(', ')
        )
      )
    ];

    const rankedCandidates = candidates
      .map(element => ({
        element,
        score:
          scorePromptCandidate(element)
      }))
      .filter(candidate => {
        return Number.isFinite(
          candidate.score
        );
      })
      .sort((first, second) => {
        return second.score - first.score;
      });

    return rankedCandidates.length > 0
      ? rankedCandidates[0].element
      : null;
  }

  /**
   * Places the text caret at the end of a contenteditable prompt.
   *
   * @param {Element} element
   */
  function placeCaretAtEnd(element) {
    if (!element.isContentEditable) {
      return;
    }

    const selection =
      window.getSelection();

    if (!selection) {
      return;
    }

    const range =
      document.createRange();

    range.selectNodeContents(element);
    range.collapse(false);

    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * Clicks and focuses the Copilot prompt field.
   *
   * @param {boolean} force
   * @returns {Promise<boolean>}
   */
  async function focusPromptField(
    force = false
  ) {
    if (!isCopilotChatPage()) {
      return false;
    }

    let promptField;

    try {
      promptField =
        await waitForElement(
          () => getPromptField(),
          PROMPT_TIMEOUT_MS
        );
    } catch (error) {
      console.warn(
        '[Save3Clicks] Prompt field was not found:',
        error
      );

      return false;
    }

    /*
     * Do not take focus away if the user has already focused another
     * editable field. The force option is used by the manual menu
     * command.
     */
    const activeElement =
      document.activeElement;

    const userIsEditing =
      activeElement &&
      activeElement !== document.body &&
      activeElement !== document.documentElement &&
      (
        activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.isContentEditable ||
        activeElement.getAttribute('role') ===
          'textbox'
      );

    if (
      !force &&
      userIsEditing &&
      activeElement !== promptField
    ) {
      console.log(
        '[Save3Clicks] Prompt auto-focus skipped because another editable field is active.'
      );

      return false;
    }

    try {
      promptField.scrollIntoView({
        block: 'nearest',
        inline: 'nearest'
      });

      /*
       * A normal click helps activate Fluent UI or Lexical-based input
       * fields before focus() is called.
       */
      promptField.click();

      if (
        typeof promptField.focus ===
        'function'
      ) {
        promptField.focus({
          preventScroll: true
        });
      }

      placeCaretAtEnd(promptField);

      /*
       * Reapply focus on the next animation frame in case the click
       * caused Copilot to re-render the composer.
       */
      requestAnimationFrame(() => {
        const currentPrompt =
          getPromptField() ||
          promptField;

        if (
          currentPrompt &&
          typeof currentPrompt.focus ===
            'function'
        ) {
          currentPrompt.focus({
            preventScroll: true
          });

          placeCaretAtEnd(
            currentPrompt
          );
        }
      });

      console.log(
        '[Save3Clicks] Prompt field focused.'
      );

      return true;
    } catch (error) {
      console.warn(
        '[Save3Clicks] Prompt focus failed:',
        error
      );

      return false;
    }
  }

  /**
   * Schedules a debounced prompt-focus attempt.
   *
   * @param {number} delay
   * @param {boolean} force
   */
  function schedulePromptFocus(
    delay = 100,
    force = false
  ) {
    clearTimeout(
      pendingFocusTimer
    );

    pendingFocusTimer =
      setTimeout(() => {
        pendingFocusTimer = null;

        focusPromptField(force).catch(
          error => {
            console.warn(
              '[Save3Clicks] Scheduled prompt focus failed:',
              error
            );
          }
        );
      }, delay);
  }

  /*
   * ================================================================
   * COPILOT INTERFACE DETECTION
   * ================================================================
   */

  /**
   * Finds the Copilot model-switcher button.
   *
   * The current element ID is preferred. Accessible attributes and
   * visible text provide fallbacks if Microsoft changes that ID.
   *
   * @returns {Element|null}
   */
  function getSwitcherButton() {
    const currentSwitcher =
      document.getElementById(
        'gptModeSwitcher'
      );

    if (isVisible(currentSwitcher)) {
      return currentSwitcher;
    }

    const candidates = [
      ...document.querySelectorAll(
        [
          'button[aria-haspopup="menu"]',
          'button[aria-haspopup="listbox"]',
          '[role="button"][aria-haspopup="menu"]',
          '[role="button"][aria-haspopup="listbox"]'
        ].join(', ')
      )
    ].filter(isVisible);

    return candidates.find(candidate => {
      const searchableText = normalizeText(
        [
          candidate.textContent,
          candidate.getAttribute(
            'aria-label'
          ),
          candidate.getAttribute('title')
        ]
          .filter(Boolean)
          .join(' ')
      );

      return (
        searchableText.includes('gpt') ||
        searchableText.includes(
          'automatic'
        ) ||
        searchableText.includes(
          'automaticky'
        ) ||
        searchableText.includes(
          'think deeper'
        ) ||
        searchableText.includes(
          'přemýšlení'
        )
      );
    }) || null;
  }

  /**
   * Returns the normalized visible switcher text.
   *
   * @returns {string}
   */
  function getSwitcherText() {
    const switcher = getSwitcherButton();

    if (!switcher) {
      return '';
    }

    return normalizeText(
      [
        switcher.textContent,
        switcher.getAttribute(
          'aria-label'
        ),
        switcher.getAttribute('title')
      ]
        .filter(Boolean)
        .join(' ')
    );
  }

  /**
   * Returns whether the closed switcher represents the configured
   * final model.
   *
   * @returns {boolean}
   */
  function isConfiguredModelAlreadyActive() {
    const switcherText =
      getSwitcherText();

    const targetText = normalizeText(
      getFinalModelLabel()
    );

    if (!switcherText || !targetText) {
      return false;
    }

    if (
      switcherText.includes(targetText)
    ) {
      return true;
    }

    const versionExpression =
      /\bgpt\s*-?\s*(\d+(?:\.\d+)*)\b/;

    const targetVersion =
      targetText.match(
        versionExpression
      )?.[1];

    const switcherVersion =
      switcherText.match(
        versionExpression
      )?.[1];

    if (
      !targetVersion ||
      !switcherVersion ||
      targetVersion !== switcherVersion
    ) {
      return false;
    }

    const targetIsThinkMode =
      targetText.includes('think') ||
      targetText.includes('deeper');

    const switcherIsThinkMode =
      switcherText.includes('think') ||
      switcherText.includes('deeper');

    if (
      targetIsThinkMode !==
      switcherIsThinkMode
    ) {
      return false;
    }

    return true;
  }

  /**
   * Returns whether the switcher displays Automatic mode.
   *
   * @returns {boolean}
   */
  function isAutomaticModeShown() {
    const switcherText =
      getSwitcherText();

    return (
      switcherText === 'auto' ||
      switcherText.includes(
        'automatic'
      ) ||
      switcherText.includes(
        'automaticky'
      )
    );
  }

  /**
   * Returns all visible Copilot menus and listboxes.
   *
   * @returns {Element[]}
   */
  function getOpenMenus() {
    return [
      ...document.querySelectorAll(
        '[role="menu"], [role="listbox"]'
      )
    ].filter(isVisible);
  }

  /**
   * Returns visible interactive entries inside one menu.
   *
   * @param {Element|null} menu
   * @returns {Element[]}
   */
  function getMenuItems(menu) {
    if (!menu) {
      return [];
    }

    return [
      ...menu.querySelectorAll(
        [
          '[role="menuitem"]',
          '[role="menuitemradio"]',
          '[role="menuitemcheckbox"]',
          '[role="option"]',
          '[role="button"]',
          'button'
        ].join(', ')
      )
    ].filter(isVisible);
  }

  /**
   * Returns the normalized comparison text for a menu entry.
   *
   * @param {Element} item
   * @returns {string}
   */
  function getMenuItemText(item) {
    return normalizeText(
      [
        item.textContent,
        item.getAttribute(
          'aria-label'
        ),
        item.getAttribute('title')
      ]
        .filter(Boolean)
        .join(' ')
    );
  }

  /**
   * Finds a menu item by its visible label.
   *
   * @param {Element|null} menu
   * @param {string} label
   * @returns {Element|null}
   */
  function findMenuItem(menu, label) {
    const target =
      normalizeText(label);

    const items =
      getMenuItems(menu);

    const exactMatch =
      items.find(item => {
        return (
          getMenuItemText(item) === target
        );
      });

    if (exactMatch) {
      return exactMatch;
    }

    return items.find(item => {
      return getMenuItemText(
        item
      ).includes(target);
    }) || null;
  }

  /**
   * Returns whether a menu item is marked as selected.
   *
   * @param {Element|null} item
   * @returns {boolean}
   */
  function isMenuItemSelected(item) {
    if (!item) {
      return false;
    }

    if (
      item.getAttribute(
        'aria-checked'
      ) === 'true' ||
      item.getAttribute(
        'aria-selected'
      ) === 'true' ||
      item.getAttribute(
        'data-checked'
      ) === 'true'
    ) {
      return true;
    }

    const checkmark =
      item.querySelector(
        [
          'svg[data-testid*="check"]',
          '[data-icon-name*="Check"]',
          '[aria-label="Selected"]',
          '[aria-label="selected"]'
        ].join(', ')
      );

    return isVisible(checkmark);
  }

  /**
   * Closes any currently open menus.
   */
  function closeMenus() {
    if (getOpenMenus().length === 0) {
      return;
    }

    const options = {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
      composed: true
    };

    const target =
      document.activeElement ||
      document.body;

    target.dispatchEvent(
      new KeyboardEvent(
        'keydown',
        options
      )
    );

    target.dispatchEvent(
      new KeyboardEvent(
        'keyup',
        options
      )
    );
  }

  /*
   * ================================================================
   * MODEL SELECTION
   * ================================================================
   */

  /**
   * Opens the main model-selection menu only when model selection is
   * necessary.
   *
   * @returns {Promise<Element>}
   */
  async function openSwitcherMenu() {
    const switcher =
      await waitForElement(
        () => getSwitcherButton(),
        ELEMENT_TIMEOUT_MS
      );

    if (
      isConfiguredModelAlreadyActive()
    ) {
      throw new Error(
        'CONFIGURED_MODEL_ALREADY_ACTIVE'
      );
    }

    if (getOpenMenus().length > 0) {
      closeMenus();
      await sleep(100);
    }

    const menuCountBeforeClick =
      getOpenMenus().length;

    if (!safeClick(switcher)) {
      throw new Error(
        'Could not click the model switcher'
      );
    }

    return waitForElement(() => {
      const menus = getOpenMenus();

      if (
        menus.length >
        menuCountBeforeClick
      ) {
        return menus[
          menus.length - 1
        ];
      }

      return null;
    });
  }

  /**
   * Opens a submenu and returns the newly opened menu.
   *
   * @param {Element} parentItem
   * @param {Element} previousMenu
   * @param {string} nextLabel
   * @returns {Promise<Element>}
   */
  async function openSubmenu(
    parentItem,
    previousMenu,
    nextLabel
  ) {
    const menusBeforeClick =
      getOpenMenus();

    if (!safeClick(parentItem)) {
      throw new Error(
        `Could not click submenu item: ${
          getMenuItemText(parentItem)
        }`
      );
    }

    try {
      return await waitForElement(
        () => {
          const menusAfterClick =
            getOpenMenus();

          if (
            menusAfterClick.length >
            menusBeforeClick.length
          ) {
            return menusAfterClick[
              menusAfterClick.length - 1
            ];
          }

          const newestMenu =
            menusAfterClick[
              menusAfterClick.length - 1
            ];

          if (
            newestMenu &&
            newestMenu !== previousMenu &&
            findMenuItem(
              newestMenu,
              nextLabel
            )
          ) {
            return newestMenu;
          }

          return null;
        },
        4000
      );
    } catch (firstError) {
      if (
        typeof parentItem.focus ===
        'function'
      ) {
        parentItem.focus();
      }

      parentItem.dispatchEvent(
        new KeyboardEvent(
          'keydown',
          {
            key: 'ArrowRight',
            code: 'ArrowRight',
            keyCode: 39,
            which: 39,
            bubbles: true,
            cancelable: true,
            composed: true
          }
        )
      );

      return waitForElement(
        () => {
          const menus =
            getOpenMenus();

          const newestMenu =
            menus[menus.length - 1];

          if (
            newestMenu &&
            newestMenu !== previousMenu &&
            findMenuItem(
              newestMenu,
              nextLabel
            )
          ) {
            return newestMenu;
          }

          return null;
        },
        4000
      );
    }
  }

  /**
   * Selects the configured model.
   *
   * @returns {Promise<string>}
   */
  async function selectConfiguredModel() {
    const modelPath = getModelPath();

    if (modelPath.length === 0) {
      throw new Error(
        'No model path is configured'
      );
    }

    let currentMenu =
      await openSwitcherMenu();

    for (
      let pathIndex = 0;
      pathIndex < modelPath.length;
      pathIndex += 1
    ) {
      const label =
        modelPath[pathIndex];

      const isFinalItem =
        pathIndex ===
        modelPath.length - 1;

      console.log(
        `[Save3Clicks] Looking for item ${
          pathIndex + 1
        }/${modelPath.length}:`,
        label
      );

      const item =
        await waitForElement(
          () => findMenuItem(
            currentMenu,
            label
          ),
          6000
        );

      if (isFinalItem) {
        if (
          isMenuItemSelected(item)
        ) {
          closeMenus();

          return 'already-selected';
        }

        if (!safeClick(item)) {
          throw new Error(
            `Could not click final model: ${label}`
          );
        }

        await sleep(250);

        return 'selected';
      }

      currentMenu =
        await openSubmenu(
          item,
          currentMenu,
          modelPath[pathIndex + 1]
        );
    }

    throw new Error(
      'The configured model path was not completed'
    );
  }

  /**
   * Runs one model-selection operation.
   *
   * The prompt field is focused after every successfully completed or
   * unnecessary model-selection attempt.
   *
   * @param {boolean} force
   * @returns {Promise<string>}
   */
  async function runSelection(
    force = false
  ) {
    if (selectionInProgress) {
      return 'already-running';
    }

    if (!isCopilotChatPage()) {
      return 'not-a-chat-page';
    }

    if (
      !force &&
      !isAutomaticSelectionEnabled()
    ) {
      /*
       * Auto-focus remains available even if automatic model selection
       * is disabled.
       */
      schedulePromptFocus(100);

      return 'disabled';
    }

    selectionInProgress = true;

    try {
      await waitForElement(
        () => getSwitcherButton(),
        ELEMENT_TIMEOUT_MS
      );

      await sleep(150);

      if (
        isConfiguredModelAlreadyActive()
      ) {
        lastSuccessfulUrl =
          location.href;

        console.log(
          '[Save3Clicks] Configured model is already active:',
          getSwitcherText()
        );

        /*
         * The model selector was not opened, so the prompt can be
         * focused immediately.
         */
        schedulePromptFocus(50);

        return 'already-selected';
      }

      console.log(
        '[Save3Clicks] Starting selection:',
        getModelPath().join(' -> ')
      );

      const result =
        await selectConfiguredModel();

      lastSuccessfulUrl =
        location.href;

      console.log(
        '[Save3Clicks] Selection finished:',
        result
      );

      /*
       * Give Copilot a short moment to close the model menu and finish
       * any composer re-render before focusing the prompt.
       */
      schedulePromptFocus(200);

      return result;
    } catch (error) {
      closeMenus();

      if (
        error instanceof Error &&
        error.message ===
          'CONFIGURED_MODEL_ALREADY_ACTIVE'
      ) {
        lastSuccessfulUrl =
          location.href;

        console.log(
          '[Save3Clicks] Configured model became active before the menu was opened.'
        );

        schedulePromptFocus(100);

        return 'already-selected';
      }

      console.warn(
        '[Save3Clicks] Selection failed:',
        error
      );

      /*
       * Even if model selection fails, try to leave the prompt ready
       * for manual use.
       */
      schedulePromptFocus(200);

      throw error;
    } finally {
      selectionInProgress = false;
    }
  }

  /**
   * Schedules a debounced automatic selection.
   *
   * @param {number} delay
   */
  function scheduleSelection(
    delay = NAVIGATION_DELAY_MS
  ) {
    if (
      !isAutomaticSelectionEnabled()
    ) {
      /*
       * Model selection is disabled, but prompt auto-focus should still
       * work.
       */
      schedulePromptFocus(delay);

      return;
    }

    clearTimeout(
      pendingSelectionTimer
    );

    pendingSelectionTimer =
      setTimeout(() => {
        pendingSelectionTimer = null;

        runSelection(false).catch(() => {
          /*
           * runSelection() already writes detailed errors to the
           * console.
           */
        });
      }, delay);
  }

  /*
   * ================================================================
   * COPILOT NAVIGATION DETECTION
   * ================================================================
   */

  /**
   * Installs a lightweight watcher for single-page navigation.
   */
  function installHistoryWatcher() {
    const originalPushState =
      history.pushState;

    const originalReplaceState =
      history.replaceState;

    history.pushState = function (
      ...argumentsList
    ) {
      const result =
        originalPushState.apply(
          this,
          argumentsList
        );

      window.dispatchEvent(
        new Event(
          'save3clicks:navigation'
        )
      );

      return result;
    };

    history.replaceState = function (
      ...argumentsList
    ) {
      const result =
        originalReplaceState.apply(
          this,
          argumentsList
        );

      window.dispatchEvent(
        new Event(
          'save3clicks:navigation'
        )
      );

      return result;
    };

    window.addEventListener(
      'popstate',
      () => {
        window.dispatchEvent(
          new Event(
            'save3clicks:navigation'
          )
        );
      }
    );

    window.addEventListener(
      'save3clicks:navigation',
      () => {
        lastSuccessfulUrl = null;

        scheduleSelection();

        setTimeout(() => {
          installSwitcherObserver();
        }, NAVIGATION_DELAY_MS);
      }
    );
  }

  /**
   * Installs or refreshes the observer for the current model-switcher
   * area.
   */
  async function installSwitcherObserver() {
    let switcher;

    try {
      switcher =
        await waitForElement(
          () => getSwitcherButton(),
          15000
        );
    } catch (error) {
      console.warn(
        '[Save3Clicks] Model switcher was not found during initialization.'
      );

      return;
    }

    const observationRoot =
      switcher.parentElement ||
      switcher;

    if (
      switcherObserver &&
      observedSwitcherRoot ===
        observationRoot &&
      observationRoot.isConnected
    ) {
      return;
    }

    if (switcherObserver) {
      switcherObserver.disconnect();
    }

    observedSwitcherRoot =
      observationRoot;

    switcherObserver =
      new MutationObserver(() => {
        if (isAutomaticModeShown()) {
          lastSuccessfulUrl = null;
          scheduleSelection(300);
        }
      });

    switcherObserver.observe(
      observationRoot,
      {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          'aria-label',
          'title',
          'aria-expanded'
        ]
      }
    );
  }

  /*
   * ================================================================
   * VIOLENTMONKEY MENU COMMANDS
   * ================================================================
   */

  /**
   * Registers the userscript menu commands.
   */
  function registerMenuCommands() {
    GM_registerMenuCommand(
      `Set model path: ${
        getModelPath().join(' -> ')
      }`,
      () => {
        const currentPath =
          getModelPath().join(' | ');

        const enteredPath = prompt(
          [
            'Enter the model path.',
            '',
            'Separate menu levels with | or a line break.',
            '',
            'Example:',
            'GPT | GPT 5.6 Think deeper'
          ].join('\n'),
          currentPath
        );

        if (enteredPath === null) {
          return;
        }

        const newPath = enteredPath
          .split(/\r?\n|\|/)
          .map(value => value.trim())
          .filter(Boolean);

        setModelPath(newPath);
        lastSuccessfulUrl = null;

        alert(
          `Saved model path:\n${
            getModelPath().join(' -> ')
          }`
        );
      }
    );

    GM_registerMenuCommand(
      `Toggle automatic selection: ${
        isAutomaticSelectionEnabled()
          ? 'ON'
          : 'OFF'
      }`,
      () => {
        const newValue =
          !isAutomaticSelectionEnabled();

        setAutomaticSelectionEnabled(
          newValue
        );

        alert(
          `Automatic selection is now ${
            newValue ? 'ON' : 'OFF'
          }.`
        );

        if (newValue) {
          lastSuccessfulUrl = null;
          scheduleSelection(100);
        } else {
          clearTimeout(
            pendingSelectionTimer
          );

          pendingSelectionTimer = null;

          /*
           * Disabling model selection does not disable prompt focus.
           */
          schedulePromptFocus(100);
        }
      }
    );

    GM_registerMenuCommand(
      'Select configured model now',
      async () => {
        try {
          const result =
            await runSelection(true);

          alert(
            [
              'Model-selection attempt completed.',
              '',
              `Result: ${result}`,
              `Path: ${
                getModelPath().join(
                  ' -> '
                )
              }`
            ].join('\n')
          );
        } catch (error) {
          alert(
            `Model selection failed:\n${
              error.message
            }`
          );
        }
      }
    );

    GM_registerMenuCommand(
      'Focus prompt field now',
      async () => {
        const focused =
          await focusPromptField(true);

        if (!focused) {
          alert(
            'The Copilot prompt field could not be found or focused.'
          );
        }
      }
    );

    GM_registerMenuCommand(
      'Reset model path to default',
      () => {
        setModelPath(
          DEFAULT_MODEL_PATH
        );

        lastSuccessfulUrl = null;

        alert(
          `Model path reset:\n${
            DEFAULT_MODEL_PATH.join(
              ' -> '
            )
          }`
        );
      }
    );

    GM_registerMenuCommand(
      'Show current configuration',
      () => {
        const promptField =
          getPromptField();

        alert(
          [
            'Save3Clicks configuration',
            '',
            'Version: 1.5.0',
            `Automatic selection: ${
              isAutomaticSelectionEnabled()
                ? 'ON'
                : 'OFF'
            }`,
            'Prompt auto-focus: ON',
            `Model path: ${
              getModelPath().join(
                ' -> '
              )
            }`,
            `Current URL: ${
              location.href
            }`,
            `Chat page: ${
              isCopilotChatPage()
                ? 'YES'
                : 'NO'
            }`,
            `Switcher text: ${
              getSwitcherText() ||
              '(not found)'
            }`,
            `Configured model active: ${
              isConfiguredModelAlreadyActive()
                ? 'YES'
                : 'NO'
            }`,
            `Prompt field found: ${
              promptField
                ? 'YES'
                : 'NO'
            }`,
            `Prompt field focused: ${
              promptField &&
              document.activeElement ===
                promptField
                ? 'YES'
                : 'NO'
            }`,
            `Last successfully handled URL: ${
              lastSuccessfulUrl ||
              '(none)'
            }`
          ].join('\n')
        );
      }
    );
  }

  /*
   * ================================================================
   * INITIALIZATION
   * ================================================================
   */

  /**
   * Initializes Save3Clicks.
   */
  function initialize() {
    console.log(
      '[Save3Clicks] Initializing version 1.5.0'
    );

    console.log(
      '[Save3Clicks] Configured model path:',
      getModelPath().join(' -> ')
    );

    registerMenuCommands();
    installHistoryWatcher();

    /*
     * Install the targeted switcher observer after Copilot creates the
     * relevant interface.
     */
    installSwitcherObserver();

    /*
     * Select the configured model. runSelection() focuses the prompt
     * afterward.
     */
    scheduleSelection(500);

    /*
     * This fallback covers situations where the model switcher cannot
     * be detected or automatic model selection is disabled. The
     * debouncing mechanism means it does not conflict with the focus
     * attempt performed after model selection.
     */
    schedulePromptFocus(2000);
  }

  initialize();
})();
