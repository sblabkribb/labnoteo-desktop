# Changelog

User-visible changes in labnoteO Desktop. Versions follow [Semantic Versioning](https://semver.org/).

## 0.2.0 - 2026-11-12

### New

- **Automatic updates.** The app checks for a new version on start, every 6 hours and when you come
  back after more than an hour away. It downloads in the background, shows the progress in the
  button at the bottom left, and installs only when you click **Update**. **Check for updates** is in
  the command palette.
- **Assistant (Flasko).** A small flask in the corner of the window opens a chat window you can
  resize. Quick chips help with how-to questions, sections, Unit Operations and Workflows.
  - Workflow and Unit Operation questions are answered from the catalog first.
  - Every answer shows source chips. **Insert into note** adds the answer with its sources.
  - Changes to a note are shown as a preview and run only after you allow them.
  - Chat history is kept per experiment in this PC's app folder, never in the vault.
- **Lookups for the assistant.** All read-only:
  - PartBank parts and storage locations, labelled mine, group or public
  - Workflow server (bfworkflow) designs and methods
  - Papers from PubMed, Europe PMC, Crossref and bioRxiv
  - Web search through your own SearXNG server, with page reading
- **Assistant skins.** Install skins from the gallery, with preview, author and licence. Import and
  export `.labnoteo-skin` files, or make your own from PNG sprite sheets.
- **Upload to GitHub.** Sign in once with a short code. Each experiment folder becomes a private
  repository under your account or your lab's organization.
  - You check the file list before anything is sent.
  - Secret files are always left out, and saved keys are scanned for.
  - Later uploads send only the changes, and changes made on GitHub are kept in its history.
- **External MCP servers.** Give the assistant tools from other MCP servers: RAPID and BioModel
  Portal presets or your own. A switch per server decides whether the AI may use it.
- **New experiment dialog.** It asks for a title and the experimenter. The README then shows an empty
  state with **Add first Workflow** from the catalog.
- **Experiments panel.** It lists experiments, Workflows and Unit Operations, grouped by status,
  experimenter, project, last update or open discussion.
  - Click the status icon to change or clear an experiment's status.
  - Each Workflow has a done checkbox in the tree and in the note header. The experiment shows a
    "Workflow n/m" badge.
- **Reorder Workflows.** Use the menu, Alt+Shift+Up/Down or drag. You can also add a Workflow in
  between or delete one. Numbers, links and the README checklist follow. Unit Operations can be
  moved too.
- **Unit Operation cards.** Each card has Start and End date chips with a date picker.
  `last_updated` is stamped as you write.
- **Attachments and viewers.**
  - Files you drop into a note are saved in the experiment's `resources` folder.
  - Images and CSV files open in the app.
  - Other files get **Open with default app** and **Show in folder**.
- **CSV export.** Export a note's tables, or all tables of an experiment, to CSV files.
- **AI drafts.**
  - **Draft Unit Operation planning** shows the context it will send, with a token estimate, before
    sending anything. It then streams the thinking and the writing live.
  - **Draft Method section** and **Prefill Input from previous step** use the same context. Drafts
    include the catalog descriptions.
  - AI-written lines are highlighted until you press **Done**. The highlight is never saved to the
    file. A setting keeps the old marker line if you prefer it.
- **AI provider settings.**
  - **Test connection** reads the model's context window.
  - New settings for thinking mode, max output tokens and temperature.
  - Connection settings and keys can be imported from one file.
- **Editor.**
  - A right-click menu with Insert and Format submenus.
  - A Properties card with a status chip.
  - The Ctrl+O quick switcher.
  - A command palette grouped by purpose, with shortcuts.

### Changed

- New window layout:
  - a ribbon and a resizable left dock with icon tabs
  - outline and links in a right sidebar, closed by default
  - a view header and a status bar with appearance settings
- New colours from the Korea Biofoundry CI, and a notebook-and-flask app icon.
- The Korean interface and Korean AI replies write "Workflow" and "Unit Operation" in English.
- Toasts appear at the bottom left, with a title, details and an action.
- The first-run screen no longer names other apps.
- The status toast shows status names instead of internal ids.

### Fixed

- Deleting the open Workflow note now opens the experiment README instead of an empty page.
- The update button stays readable while it downloads.
- The AI draft **Done** label is readable in light and dark themes, and drafts inside Unit Operation
  cards are highlighted.
- A catalog source chip opens its entry in the Experiments panel's catalog.
- Many smaller fixes to the assistant, GitHub upload, AI requests and accessibility.

## 0.1.0

First version. All labnoteO plugin features ported to the desktop app:

- vault and notes
- live-preview editor
- samples
- Workflows and Unit Operations
- PartBank and bfworkflow
- AI commands
- note IDs, QR codes and worksheets
- scan import
- MCP server
