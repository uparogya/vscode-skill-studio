# Changelog

## [0.0.2] - 2026-06-06

### Added

- Drag and drop files from VS Code Explorer or Finder / File Manager directly into any folder inside the package tree.
- OS metadata junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `__MACOSX`) is stripped automatically when a package is opened and excluded from every repack.

## [0.0.1] - 2026-06-06

### Added

- Open `.skill` packages directly in VS Code — no manual unzip or rezip required.
- Dedicated activity bar panel with a full file-and-folder tree of package contents.
- Click any file in the tree to open and edit it in a normal editor tab.
- Auto-repack on save — changes write back into the `.skill` archive automatically, with debouncing so rapid saves are coalesced into one operation.
- **New Skill Package** command creates a fresh `.skill` file from scratch with a prefilled `SKILL.md` template (command palette, Explorer right-click).
- Automatically initialises a zero-byte `.skill` file (created via Explorer "New File") into a valid package instead of showing an error.
- New File / New Folder via toolbar (always at package root) and via right-click context menu (inside the selected folder).
- Rename files and folders in-place with pre-selected basename.
- Delete files and folders with a confirmation prompt.
- Drag and drop to move files and folders within the package tree.
- Copy relative path of any tree item to the clipboard.
- Reveal any file in Finder / Explorer / File Manager depending on platform.
- Panel title shows the actual skill name instead of a generic label.
- Atomic writes — all archive updates go through a `.tmp` file and are renamed atomically, so the `.skill` file is never in a partial state.
