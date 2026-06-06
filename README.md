# Skill Studio

Open, browse, and edit **Agent Skill packages** (`.skill` files) directly in VS Code — no manual unzipping or rezipping.

A `.skill` file is a zip archive containing a `SKILL.md` and optional supporting files (references, assets, scripts, etc.). Skill Studio lets you treat it like a regular folder.

---

## Features

**Open and edit packages**
- Double-click any `.skill` file — `SKILL.md` opens automatically in the editor
- A dedicated **Skill Studio** panel appears in the activity bar showing the full file and folder tree
- Click any file in the tree to open and edit it in a normal VS Code editor tab
- Save as usual — changes write back into the `.skill` archive automatically

**Create packages**
- Run **Skill Studio: New Skill Package** from the command palette to create a `.skill` file from scratch with a prefilled `SKILL.md` template
- Right-click any folder in the Explorer sidebar and choose **New Skill Package**
- Create a `.skill` file via Explorer "New File" — Skill Studio automatically initialises it into a valid package

**Manage files inside a package**
- **New File / New Folder** — toolbar buttons always create at the package root; right-click a folder in the tree to create inside it
- **Rename** — right-click any file or folder
- **Delete** — right-click with a confirmation prompt
- **Drag and drop** — move files and folders within the package by dragging in the tree; drop files from the VS Code Explorer or Finder/File Manager directly into any folder
- **Copy relative path** — right-click any item to copy its path within the package
- **Reveal in Finder / Explorer / File Manager** — right-click to open the file's location in the OS

**Safe and clean**
- All archive updates are written atomically — the `.skill` file is never left in a partial state
- Rapid saves are debounced so auto-save doesn't trigger a full repack on every keystroke
- OS metadata junk (`.DS_Store`, `Thumbs.db`, `__MACOSX`, etc.) is stripped automatically on open and excluded from every repack
- Extracted files live in a temporary directory that is cleaned up when VS Code closes
- Your workspace folders are never modified

---

## Usage

1. Open any `.skill` file — Skill Studio is registered as its default editor
2. `SKILL.md` opens automatically. Click the **Skill Studio** icon in the activity bar to see the full package tree
3. Click any file in the tree to open and edit it. Save normally — the archive updates automatically

To create a new package, open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run **Skill Studio: New Skill Package**.

---

## Requirements

- VS Code `1.90.0` or newer
- `unzip` and `zip` must be on your `PATH`
  - macOS and most Linux distributions include both by default
  - Windows: install via [Git for Windows](https://gitforwindows.org/) or use WSL

---

## Known limitations

- **Git diff:** `.skill` files appear as a single binary-modified blob in Source Control. Per-file changes inside the package are not visible in the diff view — this is a VS Code limitation.
- **Single active package:** The tree panel shows one package at a time. Opening a second `.skill` file switches the tree to that package.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](https://github.com/uparogya/vscode-skill-studio/blob/main/CONTRIBUTING.md) for setup instructions and guidelines.

Found a bug or have a feature request? [Open an issue on GitHub](https://github.com/uparogya/vscode-skill-studio/issues).

---

## License

[MIT](https://github.com/uparogya/vscode-skill-studio/blob/main/LICENSE) © Arogya Upadhyaya
