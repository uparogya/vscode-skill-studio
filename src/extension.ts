import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import * as util from 'util';

// execFile passes arguments as an array — never interpolated into a shell string.
const execFile = util.promisify(child_process.execFile);

const TMP_PREFIX = 'skillstudio-';
const DND_MIME = 'application/vnd.code.tree.skillStudio.contents';

// Files and directories that are never shown in the tree and are stripped from
// the archive on every repack. Prevents macOS/Windows metadata from leaking in.
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const JUNK_DIRS = new Set(['__MACOSX']);

interface Mount {
  skillPath: string;
  extractDir: string;
  tmpDir: string;
  flatArchive: boolean;
}

interface TreeNode {
  label: string;
  fsPath: string;
  isDir: boolean;
  children: TreeNode[];
}

const mounts = new Map<string, Mount>();
const pendingMounts = new Map<string, Promise<Mount>>();

async function mountSkill(skillPath: string): Promise<Mount> {
  const existing = mounts.get(skillPath);
  if (existing && fs.existsSync(existing.extractDir)) {
    return existing;
  }

  const inflight = pendingMounts.get(skillPath);
  if (inflight) {
    return inflight;
  }

  const promise = performMount(skillPath);
  pendingMounts.set(skillPath, promise);
  try {
    return await promise;
  } finally {
    pendingMounts.delete(skillPath);
  }
}

async function initializeSkillPackage(skillPath: string): Promise<void> {
  const skillName = path.basename(skillPath, '.skill');
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  const tmpZip = skillPath + '.tmp';
  try {
    const packageDir = path.join(tmpDir, skillName);
    await fs.promises.mkdir(packageDir);
    const template = [
      '---',
      `name: ${skillName}`,
      `description: Description of ${skillName}`,
      'version: 1.0.0',
      '---',
      '',
      `# ${skillName}`,
      '',
      'Describe your skill here.',
      '',
    ].join('\n');
    await fs.promises.writeFile(path.join(packageDir, 'SKILL.md'), template);
    await execFile('zip', ['-r', tmpZip, skillName, '--quiet'], { cwd: tmpDir });
    fs.renameSync(tmpZip, skillPath);
  } catch (err) {
    if (fs.existsSync(tmpZip)) { try { fs.rmSync(tmpZip); } catch { /* best effort */ } }
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function performMount(skillPath: string): Promise<Mount> {
  if (!fs.existsSync(skillPath)) {
    throw new Error(`File not found: ${skillPath}`);
  }

  // A zero-byte file was just created (e.g. Explorer "New File"). Seed it with
  // a valid package so it opens without error instead of failing unzip.
  const stat = await fs.promises.stat(skillPath);
  if (stat.size === 0) {
    await initializeSkillPackage(skillPath);
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  try {
    await execFile('unzip', ['-o', skillPath, '-d', tmpDir]);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }

  const entries = await fs.promises.readdir(tmpDir);
  const rootEntry = entries.find((e) => fs.statSync(path.join(tmpDir, e)).isDirectory());
  const extractDir = rootEntry ? path.join(tmpDir, rootEntry) : tmpDir;
  const flatArchive = extractDir === tmpDir;

  purgeJunk(extractDir);

  const mount: Mount = { skillPath, extractDir, tmpDir, flatArchive };
  mounts.set(skillPath, mount);
  return mount;
}

// Promise chain serialises repacks so concurrent saves (e.g. a tree command
// racing with a debounced auto-save) never write to the same .tmp file.
const repackChains = new Map<string, Promise<void>>();

async function repackSkill(mount: Mount): Promise<void> {
  const prev = repackChains.get(mount.skillPath) ?? Promise.resolve();
  const next = prev.then(() => doRepack(mount), () => doRepack(mount));
  repackChains.set(mount.skillPath, next);
  await next;
  if (repackChains.get(mount.skillPath) === next) {
    repackChains.delete(mount.skillPath);
  }
}

async function doRepack(mount: Mount): Promise<void> {
  if (!fs.existsSync(mount.extractDir)) {
    return;
  }

  const tmpZip = mount.skillPath + '.tmp';

  // Build a fresh archive so deleted entries are not preserved.
  // Flat archives zip from inside the dir so entries sit at the root, not under
  // the randomly-named tmpDir folder name.
  const junkExclusions = [
    ...Array.from(JUNK_FILES).flatMap(f => ['-x', `*/${f}`]),
    ...Array.from(JUNK_DIRS).flatMap(d => ['-x', `*/${d}/*`]),
  ];
  const zipArgs = mount.flatArchive
    ? ['-r', tmpZip, '.', '--quiet', ...junkExclusions]
    : ['-r', tmpZip, path.basename(mount.extractDir), '--quiet', ...junkExclusions];
  const zipCwd = mount.flatArchive ? mount.extractDir : mount.tmpDir;

  try {
    if (fs.existsSync(tmpZip)) { fs.rmSync(tmpZip); }
    await execFile('zip', zipArgs, { cwd: zipCwd });
    fs.renameSync(tmpZip, mount.skillPath);
    vscode.window.setStatusBarMessage(`Saved → ${path.basename(mount.skillPath)}`, 2500);
  } catch (err) {
    if (fs.existsSync(tmpZip)) { fs.rmSync(tmpZip); }
    vscode.window.showErrorMessage(`Skill Studio: save failed — ${String(err)}`);
  }
}

const repackDebounce = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRepack(mount: Mount): void {
  const existing = repackDebounce.get(mount.skillPath);
  if (existing) { clearTimeout(existing); }
  repackDebounce.set(
    mount.skillPath,
    setTimeout(() => {
      repackDebounce.delete(mount.skillPath);
      void repackSkill(mount);
    }, 500)
  );
}

function isJunk(name: string, isDir: boolean): boolean {
  return isDir ? JUNK_DIRS.has(name) : JUNK_FILES.has(name);
}

function purgeJunk(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const fsPath = path.join(dir, name);
    const isDir = fs.statSync(fsPath).isDirectory();
    if (isJunk(name, isDir)) {
      fs.rmSync(fsPath, { recursive: true, force: true });
    } else if (isDir) {
      purgeJunk(fsPath);
    }
  }
}

function buildTreeNodes(dir: string): TreeNode[] {
  const entries = fs.readdirSync(dir)
    .map((name) => {
      const fsPath = path.join(dir, name);
      const isDir = fs.statSync(fsPath).isDirectory();
      return { name, fsPath, isDir };
    })
    .filter(({ name, isDir }) => !isJunk(name, isDir));

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) { return a.isDir ? -1 : 1; }
    return a.name.localeCompare(b.name);
  });

  return entries.map(({ name, fsPath, isDir }) => ({
    label: name,
    fsPath,
    isDir,
    children: isDir ? buildTreeNodes(fsPath) : [],
  }));
}

class SkillTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private rootNodes: TreeNode[] = [];
  currentMount: Mount | undefined;

  loadPackage(mount: Mount): void {
    this.currentMount = mount;
    this.rootNodes = buildTreeNodes(mount.extractDir);
    this.changeEmitter.fire();
  }

  refresh(): void {
    if (this.currentMount) {
      this.rootNodes = buildTreeNodes(this.currentMount.extractDir);
    }
    this.changeEmitter.fire();
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return node ? node.children : this.rootNodes;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.isDir
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    item.iconPath = node.isDir ? vscode.ThemeIcon.Folder : iconForFile(node.label);
    item.contextValue = node.isDir ? 'dir' : 'file';
    item.tooltip = node.fsPath;

    if (!node.isDir) {
      item.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [vscode.Uri.file(node.fsPath)],
      };
    }

    return item;
  }
}

class SkillDragAndDropController implements vscode.TreeDragAndDropController<TreeNode> {
  readonly dropMimeTypes = [DND_MIME, 'text/uri-list'];
  readonly dragMimeTypes = [DND_MIME];

  handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    dataTransfer.set(DND_MIME, new vscode.DataTransferItem(source));
  }

  async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const mount = treeProvider.currentMount;
    if (!mount) { return; }

    const destDir = target?.isDir ? target.fsPath : mount.extractDir;
    let changed = false;

    // Internal tree move
    const internal = dataTransfer.get(DND_MIME);
    if (internal) {
      const sources: TreeNode[] = internal.value;
      for (const source of sources) {
        if (
          destDir === source.fsPath ||
          destDir.startsWith(source.fsPath + path.sep) ||
          path.dirname(source.fsPath) === destDir
        ) {
          continue;
        }

        const destPath = path.join(destDir, path.basename(source.fsPath));
        if (fs.existsSync(destPath)) {
          const choice = await vscode.window.showWarningMessage(
            `"${path.basename(source.fsPath)}" already exists here. Replace?`,
            { modal: true },
            'Replace'
          );
          if (choice !== 'Replace') { continue; }
          fs.rmSync(destPath, { recursive: true, force: true });
        }

        fs.renameSync(source.fsPath, destPath);
        changed = true;
      }
    }

    // External file drop from VS Code Explorer or OS file manager
    const external = dataTransfer.get('text/uri-list');
    if (external) {
      const uris = (await external.asString())
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => vscode.Uri.parse(l));

      for (const uri of uris) {
        if (uri.scheme !== 'file') { continue; }
        const srcPath = uri.fsPath;
        if (srcPath.startsWith(mount.extractDir + path.sep)) { continue; }

        const name = path.basename(srcPath);
        const destPath = path.join(destDir, name);

        if (fs.existsSync(destPath)) {
          const choice = await vscode.window.showWarningMessage(
            `"${name}" already exists here. Replace?`,
            { modal: true },
            'Replace'
          );
          if (choice !== 'Replace') { continue; }
          fs.rmSync(destPath, { recursive: true, force: true });
        }

        fs.cpSync(srcPath, destPath, { recursive: true });
        changed = true;
      }
    }

    if (changed) {
      treeProvider.refresh();
      await repackSkill(mount);
    }
  }
}

function iconForFile(name: string): vscode.ThemeIcon {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.md') { return new vscode.ThemeIcon('markdown'); }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) { return new vscode.ThemeIcon('file-media'); }
  if (ext === '.pdf') { return new vscode.ThemeIcon('file-pdf'); }
  if (['.py', '.js', '.ts', '.sh', '.json', '.yaml', '.yml'].includes(ext)) { return new vscode.ThemeIcon('file-code'); }
  return new vscode.ThemeIcon('file');
}

const treeProvider = new SkillTreeProvider();
let treeView: vscode.TreeView<TreeNode> | undefined;

class SkillEditorProvider implements vscode.CustomReadonlyEditorProvider {
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    panel.webview.options = { enableScripts: false };
    panel.webview.html = buildWebviewHtml('Opening…', '');

    let mount: Mount;
    try {
      mount = await mountSkill(document.uri.fsPath);
    } catch (err) {
      panel.webview.html = buildWebviewHtml(
        'Could not open package',
        `<code>${escapeHtml(String(err))}</code>`
      );
      return;
    }

    const skillName = path.basename(document.uri.fsPath, '.skill');
    panel.webview.html = buildWebviewHtml(
      skillName,
      'Browse and edit files in the <b>Skill Studio</b> panel in the activity bar.<br>' +
      'Click any file to open it. Changes save directly back into the <code>.skill</code> package.'
    );

    treeProvider.loadPackage(mount);
    if (treeView) { treeView.title = skillName; }

    try {
      await vscode.commands.executeCommand('skillStudio.contents.focus');
    } catch {
      // Silently ignored — panel may not be ready on first activation.
    }

    const skillMdPath = path.join(mount.extractDir, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(skillMdPath));
    }
  }
}

function validateEntryName(name: string): string | undefined {
  if (!name.trim()) { return 'Name cannot be empty.'; }
  if (name.includes('\0')) { return 'Name cannot contain null bytes.'; }
  if (name.includes('/') || name.includes('\\')) { return 'Name cannot contain slashes.'; }
  if (name === '.' || name === '..') { return 'Name is reserved.'; }
  return undefined;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildWebviewHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    * { box-sizing: border-box }
    body {
      margin: 0; padding: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .wrap { max-width: 640px; margin: 0 auto; padding: 56px 32px }
    .eyebrow {
      text-transform: uppercase; letter-spacing: .14em;
      font-size: 10px; font-weight: 600; opacity: .4; margin: 0 0 10px;
    }
    h1 { margin: 0 0 24px; font-size: 26px; font-weight: 700; letter-spacing: -.02em }
    .tip {
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.1));
      border-left: 3px solid var(--vscode-textBlockQuote-border, rgba(128,128,128,.3));
      padding: 12px 16px; font-size: 12px; line-height: 1.7;
      color: var(--vscode-descriptionForeground);
    }
    .tip b, .tip code { color: var(--vscode-foreground) }
  </style>
</head>
<body>
  <div class="wrap">
    <p class="eyebrow">Skill Studio</p>
    <h1>${escapeHtml(title)}</h1>
    ${body ? `<div class="tip">${body}</div>` : ''}
  </div>
</body>
</html>`;
}

function resolveTargetDir(mount: Mount, node: TreeNode | undefined): string {
  return node?.isDir ? node.fsPath : mount.extractDir;
}

function locationLabel(mount: Mount, targetDir: string): string {
  const rel = path.relative(mount.extractDir, targetDir);
  return rel ? rel + '/' : '(root)';
}

export function activate(context: vscode.ExtensionContext): void {
  treeView = vscode.window.createTreeView('skillStudio.contents', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    dragAndDropController: new SkillDragAndDropController(),
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'skillStudio.editor',
      new SkillEditorProvider(),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      }
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      for (const mount of mounts.values()) {
        if (document.uri.fsPath.startsWith(mount.extractDir + path.sep)) {
          scheduleRepack(mount);
          break;
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('skillStudio.newSkill', async () => {
      const skillName = await vscode.window.showInputBox({
        prompt: 'Skill name',
        placeHolder: 'my-skill',
        validateInput: validateEntryName,
      });
      if (!skillName) { return; }

      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `${skillName}.skill`)),
        filters: { 'Skill packages': ['skill'] },
        title: 'Save New Skill Package',
      });
      if (!saveUri) { return; }

      if (fs.existsSync(saveUri.fsPath)) {
        const overwrite = await vscode.window.showWarningMessage(
          `"${path.basename(saveUri.fsPath)}" already exists. Overwrite?`,
          { modal: true },
          'Overwrite'
        );
        if (overwrite !== 'Overwrite') { return; }
      }

      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
      const tmpZip = saveUri.fsPath + '.tmp';
      try {
        const packageDir = path.join(tmpDir, skillName);
        await fs.promises.mkdir(packageDir);
        const template = [
          '---',
          `name: ${skillName}`,
          `description: Description of ${skillName}`,
          'version: 1.0.0',
          '---',
          '',
          `# ${skillName}`,
          '',
          'Describe your skill here.',
          '',
        ].join('\n');
        await fs.promises.writeFile(path.join(packageDir, 'SKILL.md'), template);
        await execFile('zip', ['-r', tmpZip, skillName, '--quiet'], { cwd: tmpDir });
        fs.renameSync(tmpZip, saveUri.fsPath);
      } catch (err) {
        if (fs.existsSync(tmpZip)) { try { fs.rmSync(tmpZip); } catch { /* best effort */ } }
        vscode.window.showErrorMessage(`Skill Studio: could not create package — ${String(err)}`);
        return;
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }

      await vscode.commands.executeCommand('vscode.openWith', saveUri, 'skillStudio.editor');
    })
  );

  // Toolbar buttons always target the package root regardless of tree selection.
  // Context-menu variants (newFile / newFolder) target the right-clicked folder.
  context.subscriptions.push(
    vscode.commands.registerCommand('skillStudio.newFileAtRoot', () => createFile(undefined, true)),
    vscode.commands.registerCommand('skillStudio.newFolderAtRoot', () => createFolder(undefined, true)),
    vscode.commands.registerCommand('skillStudio.newFile', (node?: TreeNode) => createFile(node, false)),
    vscode.commands.registerCommand('skillStudio.newFolder', (node?: TreeNode) => createFolder(node, false))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('skillStudio.renameNode', async (node?: TreeNode) => {
      const mount = treeProvider.currentMount;
      if (!mount || !node) { return; }

      const dotIndex = node.label.lastIndexOf('.');
      const selectionEnd = !node.isDir && dotIndex > 0 ? dotIndex : node.label.length;

      const newName = await vscode.window.showInputBox({
        prompt: 'Rename',
        value: node.label,
        valueSelection: [0, selectionEnd],
        validateInput: validateEntryName,
      });
      if (!newName || newName === node.label) { return; }

      const destPath = path.join(path.dirname(node.fsPath), newName);
      if (fs.existsSync(destPath)) {
        vscode.window.showWarningMessage(`"${newName}" already exists.`);
        return;
      }

      fs.renameSync(node.fsPath, destPath);
      treeProvider.refresh();
      await repackSkill(mount);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('skillStudio.deleteNode', async (node?: TreeNode) => {
      const mount = treeProvider.currentMount;
      if (!mount || !node) { return; }

      const confirmed = await vscode.window.showWarningMessage(
        `Delete "${node.label}"?`,
        { modal: true },
        'Delete'
      );
      if (confirmed !== 'Delete') { return; }

      fs.rmSync(node.fsPath, { recursive: true, force: true });
      treeProvider.refresh();
      await repackSkill(mount);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('skillStudio.copyPath', async (node?: TreeNode) => {
      const mount = treeProvider.currentMount;
      if (!mount || !node) { return; }
      await vscode.env.clipboard.writeText(path.relative(mount.extractDir, node.fsPath));
      vscode.window.setStatusBarMessage('Path copied', 2000);
    })
  );

  const revealInOs = (node?: TreeNode) => {
    if (!node) { return; }
    void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.fsPath));
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('skillStudio.revealInFinder', revealInOs),
    vscode.commands.registerCommand('skillStudio.revealInExplorer', revealInOs),
    vscode.commands.registerCommand('skillStudio.revealInFileManager', revealInOs)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('skillStudio.open', async (uri?: vscode.Uri) => {
      let target = uri;
      if (!target) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'Skill packages': ['skill'] },
        });
        if (!picked?.length) { return; }
        target = picked[0];
      }
      await vscode.commands.executeCommand('vscode.openWith', target, 'skillStudio.editor');
    })
  );
}

async function createFile(node: TreeNode | undefined, forceRoot: boolean): Promise<void> {
  const mount = treeProvider.currentMount;
  if (!mount) {
    vscode.window.showWarningMessage('Open a skill package first.');
    return;
  }

  const targetDir = forceRoot ? mount.extractDir : resolveTargetDir(mount, node);
  const name = await vscode.window.showInputBox({
    prompt: `New file in ${locationLabel(mount, targetDir)}`,
    placeHolder: 'example.md',
    validateInput: validateEntryName,
  });
  if (!name) { return; }

  const destPath = path.join(targetDir, name);
  if (fs.existsSync(destPath)) {
    vscode.window.showWarningMessage(`"${name}" already exists.`);
    return;
  }

  fs.writeFileSync(destPath, '');
  treeProvider.refresh();
  await repackSkill(mount);
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(destPath));
}

async function createFolder(node: TreeNode | undefined, forceRoot: boolean): Promise<void> {
  const mount = treeProvider.currentMount;
  if (!mount) {
    vscode.window.showWarningMessage('Open a skill package first.');
    return;
  }

  const targetDir = forceRoot ? mount.extractDir : resolveTargetDir(mount, node);
  const name = await vscode.window.showInputBox({
    prompt: `New folder in ${locationLabel(mount, targetDir)}`,
    placeHolder: 'assets',
    validateInput: validateEntryName,
  });
  if (!name) { return; }

  const destPath = path.join(targetDir, name);
  if (fs.existsSync(destPath)) {
    vscode.window.showWarningMessage(`"${name}" already exists.`);
    return;
  }

  fs.mkdirSync(destPath, { recursive: true });
  treeProvider.refresh();
  await repackSkill(mount);
}

export function deactivate(): void {
  for (const timer of repackDebounce.values()) {
    clearTimeout(timer);
  }
  repackDebounce.clear();

  for (const mount of mounts.values()) {
    try {
      fs.rmSync(mount.tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort — the OS reclaims /tmp on reboot.
    }
  }
  mounts.clear();
}
