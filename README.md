# Save3Clicks for M365 Copilot

A userscript that automatically selects your preferred model in Microsoft 365 Copilot and focuses the prompt field so you can start typing immediately.

[Install from Greasy Fork](https://greasyfork.org/en/scripts/569121-save3clicks-m365-copilot)

> [!NOTE]
> This script is intended for the Microsoft 365 Copilot web interface at `https://m365.cloud.microsoft/`. Available models and interface controls depend on your Microsoft 365 account, licence, organisation, interface language, and the current Copilot interface.

## Features

- Automatically selects a configured Copilot model.
- Supports model selectors with multiple menu levels.
- Avoids reopening the model menu when the configured model is already active.
- Automatically focuses the Copilot prompt after model selection.
- Restores the configured model when Copilot returns to Automatic mode.
- Handles internal navigation between Copilot chats.
- Lets you enable or disable model selection and prompt auto-focus independently.
- Avoids taking focus when you are already using another editable field.
- Provides manual commands for selection, focus, configuration, and diagnostics.
- Stores configuration through the userscript manager.
- Prefers semantic selectors and accessibility attributes over generated CSS class names.
- Supports Violentmonkey and compatible userscript managers.

## Default configuration

The default model-selection path is:

```text
GPT
└── GPT 5.6 Think deeper
```

In the userscript menu, the same path is represented as:

```text
GPT | GPT 5.6 Think deeper
```

The path is configurable, so it can be updated when Microsoft changes model names or reorganises the model-selection menu.

## Requirements

You need:

- Firefox, Chrome, Edge, or another compatible browser;
- Violentmonkey, Tampermonkey, or another compatible userscript manager;
- access to Microsoft 365 Copilot at `https://m365.cloud.microsoft/`.

Violentmonkey is recommended because the script is primarily developed and tested with its userscript APIs.

## Installation

### Option 1: Install from Greasy Fork

1. Install Violentmonkey or another compatible userscript manager.
2. Open the [Save3Clicks Greasy Fork page](https://greasyfork.org/en/scripts/569121-save3clicks-m365-copilot).
3. Select **Install this script**.
4. Review the source code.
5. Confirm the installation in your userscript manager.
6. Open or reload Microsoft 365 Copilot.

### Option 2: Install from GitHub

1. Install Violentmonkey or another compatible userscript manager.
2. Open the `.user.js` file in this repository.
3. Click **Raw** or **Download raw file**.
4. Your userscript manager should offer to install the script.
5. Review the source code and confirm the installation.
6. Open or reload Microsoft 365 Copilot.

### Option 3: Install manually

If automatic installation does not open:

1. Open the userscript manager dashboard.
2. Create a new script.
3. Remove the generated template.
4. Copy the complete contents of the repository's `.user.js` file.
5. Paste the code into the userscript editor.
6. Save the script.
7. Open or reload Microsoft 365 Copilot.

## Configuration

Open the userscript manager menu while Microsoft 365 Copilot is open. Save3Clicks provides the following commands.

### Set model path

Changes the sequence of model-menu entries selected by the script.

Separate menu levels with a vertical bar:

```text
GPT | GPT 5.6 Think deeper
```

You can also enter each menu level on a separate line:

```text
GPT
GPT 5.6 Think deeper
```

The labels must match the entries displayed in your Copilot model menu.

### Toggle automatic selection

Enables or disables automatic model selection.

When disabled, you can still run **Select configured model now** manually.

### Toggle prompt auto-focus

Enables or disables automatic focusing of the Copilot prompt independently of model selection.

When disabled, you can still run **Focus prompt field now** manually.

### Select configured model now

Immediately attempts to select the configured model.

Use this command to:

- test a new model path;
- restore the model manually;
- diagnose a Copilot interface change.

### Focus prompt field now

Immediately attempts to find and focus the main Copilot prompt.

### Reset model path to default

Restores the default model path:

```text
GPT | GPT 5.6 Think deeper
```

### Show current configuration

Displays diagnostic information, including:

- script version;
- automatic-selection status;
- prompt auto-focus status;
- configured model path;
- current URL;
- whether the current page was detected as a Copilot chat;
- detected model-switcher text;
- whether the configured model appears to be active;
- whether the prompt field was found;
- whether the prompt field is focused;
- the last successfully handled URL.

This information is useful when reporting a problem.

## How it works

Microsoft 365 Copilot loads and updates much of its interface dynamically.

Save3Clicks therefore:

1. waits for the model switcher to become available;
2. checks whether the configured model is already active;
3. opens the model-selection menu only when necessary;
4. follows the configured model-menu path;
5. selects the final model;
6. allows Copilot to finish updating its interface;
7. identifies and focuses the main prompt field;
8. monitors internal navigation and model-switcher changes;
9. repeats the necessary actions when Copilot returns to Automatic mode.

Repeated navigation and mutation events are debounced or limited to one DOM check per animation frame where appropriate.

The script prefers stable element IDs, roles, ARIA attributes, and visible labels. Generated Microsoft 365 CSS class names are not used as primary selectors.

## Prompt auto-focus safeguards

Prompt detection uses multiple signals to distinguish the Copilot composer from search fields and other editable controls.

The script:

- excludes search inputs, search boxes, and search regions;
- checks whether a candidate is connected, visible, enabled, and editable;
- prefers text areas and editable elements with textbox semantics;
- considers the candidate's position and dimensions;
- considers prompt, message, chat, composer, and input context;
- looks for a related send control;
- validates a cached prompt before reusing it;
- clears cached prompt information after internal navigation;
- avoids taking focus when another editable field is active;
- rechecks focus before performing a delayed focus operation;
- verifies whether focusing succeeded;
- treats a focused descendant of a rich-text editor as a successful focus.

Prompt detection is intentionally conservative because Microsoft can change the Copilot interface without notice.

## Browser compatibility

The script uses standard browser DOM APIs and the following userscript APIs:

```text
GM_getValue
GM_setValue
GM_registerMenuCommand
```

Primary testing should cover:

- Firefox with Violentmonkey;
- Chrome with Violentmonkey.

Tampermonkey should generally support the APIs used by the script, but behaviour may differ between browsers and userscript managers.

## Updating the script

### Greasy Fork installation

If you installed the script from Greasy Fork, your userscript manager can normally check for updates automatically.

You can also open the installed script in your userscript manager and run its update check manually.

### GitHub or manual installation

If you installed the script manually:

1. download the latest `.user.js` file;
2. open the installed script in your userscript manager;
3. replace the existing source with the latest complete version;
4. save it;
5. reload Microsoft 365 Copilot.

Review changes before installing an update.

## Troubleshooting

### The script does not run

Check that:

1. the userscript is enabled;
2. the metadata contains this match pattern:

   ```text
   https://m365.cloud.microsoft/*
   ```

3. the userscript manager has permission to run on the Microsoft 365 Copilot site;
4. you reloaded the Copilot page after installing or updating the script;
5. you are using the Microsoft 365 Copilot web interface.

### The wrong model is selected

1. Open the Copilot model menu manually.
2. Note the exact labels and menu hierarchy.
3. Run **Set model path**.
4. Enter the labels in order, separated with `|`.

For example:

```text
GPT | GPT 5.6 Think deeper
```

5. Run **Select configured model now** to test the path.

### The model cannot be found

Microsoft may have renamed, removed, or reorganised the available models.

Update the configured model path so that every level matches the current visible menu text.

Model availability can differ between accounts and organisations.

### The prompt is not focused

1. Run **Focus prompt field now**.
2. Run **Show current configuration**.
3. Check whether the prompt field was found.
4. Open the browser developer console.
5. Look for messages beginning with:

   ```text
   [Save3Clicks]
   ```

6. Report the browser, userscript manager, script version, Copilot interface language, and relevant diagnostic output.

### Focus moves to the wrong field

Disable automatic prompt focus through:

```text
Toggle prompt auto-focus
```

Then report:

- browser and version;
- userscript manager and version;
- script version;
- Copilot interface language;
- output from **Show current configuration**;
- steps needed to reproduce the problem.

Do not include confidential conversation content, account information, access tokens, or organisation data.

### The script stopped working after a Copilot update

Microsoft may have changed:

- model names;
- menu hierarchy;
- accessible labels;
- element roles;
- model-switcher structure;
- prompt-editor structure.

First, verify and update the configured model path. If the problem remains, open an issue with the diagnostic information listed below.

## Reporting an issue

Include:

- browser and version;
- userscript manager and version;
- script version;
- operating system;
- Copilot interface language;
- whether the problem occurs in a new or existing chat;
- configured model path;
- output from **Show current configuration**;
- relevant console messages beginning with `[Save3Clicks]`;
- clear reproduction steps.

If possible, include relevant semantic HTML attributes such as:

- `id`;
- `role`;
- `aria-label`;
- `aria-haspopup`;
- `aria-expanded`;
- `contenteditable`.

Do not publish:

- conversation contents;
- personal information;
- organisation information;
- authentication tokens;
- cookies;
- session identifiers.

## Testing checklist

Before publishing a new version, test:

- initial Copilot page load;
- new chat;
- existing conversation;
- internal navigation between conversations;
- configured model already active;
- Copilot returning to Automatic mode;
- automatic selection enabled;
- automatic selection disabled;
- prompt auto-focus enabled;
- prompt auto-focus disabled;
- manual model selection;
- manual prompt focus;
- user focusing another editable field during initialization;
- browser console for unexpected errors.

Where possible, test both:

- Firefox with Violentmonkey;
- Chrome with Violentmonkey.

## Contributing

Contributions and compatibility reports are welcome.

When proposing a change:

1. create or use a dedicated branch;
2. keep each change focused on one logical improvement;
3. preserve Firefox and Chrome compatibility;
4. avoid generated CSS class names as selectors;
5. prefer stable IDs, roles, ARIA attributes, and visible labels;
6. include explanatory comments for non-obvious logic;
7. test model selection and prompt focusing;
8. describe the tested browser and userscript manager;
9. open a pull request with a concise explanation of the change.

When updating an existing pull request, commit additional changes directly to that pull request's source branch.

## Privacy and permissions

The script runs locally in your browser on matching Microsoft 365 Copilot pages.

Its declared userscript permissions are limited to:

```text
GM_getValue
GM_setValue
GM_registerMenuCommand
```

These permissions are used to:

- store the configured model path;
- store whether automatic selection is enabled;
- store whether prompt auto-focus is enabled;
- provide userscript menu commands.

The script does not require external libraries.

Review the source code before installation and install userscripts only from sources you trust.

## Limitations

- Microsoft can change the Copilot interface or menu structure at any time.
- Model names and availability can differ between accounts and organisations.
- Localised interface labels may require a different model path.
- Prompt detection may require adjustment after a major interface redesign.
- The script cannot provide models that are unavailable to your account.
- Behaviour may differ between browsers and userscript managers.
- Successful syntax validation does not verify compatibility with future Copilot interface changes.

## Disclaimer

This project is independent and is not affiliated with, endorsed by, sponsored by, or maintained by Microsoft.

The script interacts with a web interface that may change without notice. Use it at your own discretion and review updates before installing them.

## Licence

See the repository licence file for the terms that apply to this project.
