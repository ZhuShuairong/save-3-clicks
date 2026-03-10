# save-3-clicks

**Tampermonkey script for Microsoft 365 Copilot Enterprise/Education**  
Stops the “auto” default and lets you pick your preferred GPT model in one click.

---

## What it does

Tired of:

- Clicking **Auto**, then **More**, then selecting one of three GPT versions?
- Being forced to use the default model every time you start a new chat?
- Not being on Windows (no desktop app) and stuck with the web UI?

This script fixes that by automatically selecting the model you want when Copilot loads.

> **Note:** Only works with the enterprise/educational edition of M365 Copilot, not the regular Copilot.

---

## Install steps

1. Install the Tampermonkey extension for your browser.
2. Open the extension and choose **Create a new script**.
3. Copy & paste the contents of `Auto Select Copilot - GPT Mode-1.1.0.user.js` (or import the file directly).
4. Refresh the M365 Copilot page – it should now switch to your preferred model automatically.

---

## Customization

- The default target model is **GPT‑5.4**, chosen for its high benchmark scores and robust prompt handling.
- To change the target model, edit the script and adjust the `targetMode` or run the “Set target mode” action from the menu.
- If you don’t want the script to open the **More** menu (i.e. you just want “Ambiguous / Quick response / Think deeper”), turn off the `clickMore` option—then it won’t expand the menu at all.

---

Enjoy a smoother Copilot experience with one less click!