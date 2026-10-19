import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  // Aliased because `net` in this file is Node's socket module, imported below.
  net as electronNet,
  screen,
  session,
  shell,
  type MenuItemConstructorOptions,
  type Session,
} from "electron";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import treeKill from "tree-kill";
import { checkForUpdatesFromMenu, initAutoUpdater } from "./updater";
import { getLauncherHtml } from "./launcher-html";
import { handleSwipeNavigation } from "./navigation-gestures";
import {
  shouldHandleTrackedServerExit,
  shouldKillSupersededServer,
  shouldRestorePreviousTrackedServer,
  shouldStopAttemptedServer,
} from "./connection/local-server-lifecycle";
import { probeLocalServerHealth } from "./connection/local-server-health";
import { createPartitionProbeFetch } from "./connection/partition-probe-fetch";
import { provisionBundledPlugins } from "./connection/plugin-provisioning";
import { preflightRemoteConnection } from "./connection/preflight";
import { ConnectionStore, getConnectionsFilePath } from "./connection/profiles";
import { normalizeRemoteUrl } from "./connection/validate";
import { createElectronPaperclipClient, partitionCookieReader } from "./paperclip/electron";
import {
  applyDesktopUserDataOverride,
  assertIsolatedRuntimePaths,
  resolvePaperclipHomePath,
} from "./runtime-safety";
import {
  isNavigationAllowed,
  localPartition,
  remotePartitionForProfile,
  shouldOpenExternally,
} from "./connection/window-policy";
import {
  DESKTOP_VIEWS,
  resolveDesktopViewUrl,
  resolveStartUrl,
  toViewPath,
} from "./connection/start-path";
import { LOCAL_PROFILE_ID } from "./connection/types";
import type {
  ConnectionMode,
  ConnectionProfile,
  RemotePreflightResult,
} from "./connection/types";
import { createTrayController, type TrayController } from "./tray/tray-controller";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREFERRED_PORT = 3100;
const SERVER_STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 400;
const PID_FILE_NAME = "paperclip-electron.pid";
const LOCAL_SERVER_HEALTH_POLL_INTERVAL_MS = 30_000;
const LOCAL_SERVER_HEALTH_TIMEOUT_MS = 5_000;
const SERVER_LOG_MAX_BYTES = 20 * 1024 * 1024;
const SERVER_LOG_ARCHIVE_KEEP = 5;
const SERVER_LOG_ARCHIVE_PREFIX = "server.log.";
const SERVER_LOG_UNSAFE_PREFIX = "server.log.unsafe.";

// ---------------------------------------------------------------------------
// Process-global state
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess | null = null;
let serverPort = PREFERRED_PORT;
let mainWindow: BrowserWindow | null = null;
let launcherWindow: BrowserWindow | null = null;
let launcherPresentation: LauncherPresentation = "standalone";
let isQuitting = false;
let bootSequence = 0;
let launcherView: LauncherView = "chooser";
let appStartupReadyForFocus = false;
let pendingSecondInstanceFocus = false;
let localServerMonitorTimer: ReturnType<typeof setInterval> | null = null;
let localServerHealthCheckInFlight = false;
let localServerFailureDialogOpen = false;
let currentConnection: {
  mode: ConnectionMode;
  profileId: string | null;
  startUrl: string;
  allowedOrigin: string;
  partition: string;
} | null = null;

let connectionStore: ConnectionStore;
let trayController: TrayController | null = null;

type LauncherView =
  | "chooser"
  | "remote-form"
  | "saved"
  | "local-boot"
  | "connecting"
  | "error";
type LauncherPresentation = "standalone" | "attached";
type BootStep = "init" | "database" | "server" | "ready";

app.setName("Haven Office");
applyDesktopUserDataOverride(app, process.env);

// Capture native crashes locally (no upload) so segfaults that bypass the
// macOS crash reporter still leave evidence in app.getPath("crashDumps").
crashReporter.start({ uploadToServer: false });

function focusExistingInstanceWindow(): void {
  if (!appStartupReadyForFocus) {
    pendingSecondInstanceFocus = true;
    return;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.show();
    launcherWindow.focus();
    return;
  }

  void ensureLauncherWindow("chooser");
}

function markAppStartupReadyForFocus(): void {
  appStartupReadyForFocus = true;
  if (!pendingSecondInstanceFocus) {
    return;
  }

  pendingSecondInstanceFocus = false;
  focusExistingInstanceWindow();
}

// A second app instance must never boot its own embedded server against the
// same PAPERCLIP_HOME/postgres data dir — focus the existing instance instead.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", focusExistingInstanceWindow);
}

// ---------------------------------------------------------------------------
// Paths and version helpers
// ---------------------------------------------------------------------------

function getAppRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app-server");
  }

  return path.resolve(app.getAppPath(), "..");
}

/**
 * The tray's template image (HAV-43). A placeholder glyph, not a designed
 * asset — see `build/trayTemplate.png`. Shipped at the resources root
 * (`electron-builder.yml`'s `extraResources`), unlike `app-server`.
 */
function trayIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "trayTemplate.png");
  }

  return path.join(path.resolve(app.getAppPath(), ".."), "build", "trayTemplate.png");
}

function resolveLocalServerVersion(): string | null {
  const candidates = app.isPackaged
    ? [path.join(getAppRoot(), "server", "package.json")]
    : [path.join(getAppRoot(), "node_modules", "@paperclipai", "server", "package.json")];

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function getLauncherHtmlPath(): string {
  return path.join(app.getPath("temp"), "paperclip-launcher", "launcher.html");
}

function ensureLauncherHtmlFile(): string {
  const launcherPath = getLauncherHtmlPath();
  fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
  fs.writeFileSync(launcherPath, getLauncherHtml(), "utf8");
  return launcherPath;
}

// ---------------------------------------------------------------------------
// Port detection and server lifecycle
// ---------------------------------------------------------------------------

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
  });
}

async function findFreePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (!(await isPortInUse(port))) {
      return port;
    }
  }

  throw new Error(`No free port found in range ${startPort}-${startPort + 99}`);
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const tryConnect = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Server did not start within ${timeoutMs}ms`));
        return;
      }

      const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve();
      });

      sock.on("error", () => {
        setTimeout(tryConnect, POLL_INTERVAL_MS);
      });
    };

    tryConnect();
  });
}

function findNodeBinary(): string {
  if (!app.isPackaged) {
    return "node";
  }

  const isWindows = process.platform === "win32";
  const bundledNode = path.join(
    process.resourcesPath,
    "app-server",
    "node-bin",
    isWindows ? "node.exe" : "node",
  );

  try {
    fs.accessSync(bundledNode, fs.constants.X_OK);
    return bundledNode;
  } catch {
    // ignore
  }

  const candidates: string[] = [];
  const home = process.env.HOME ?? "";
  const nvmDir = process.env.NVM_DIR ?? path.join(home, ".nvm");

  try {
    const version = fs.readFileSync(path.join(nvmDir, "alias", "default"), "utf8").trim();
    candidates.push(path.join(nvmDir, "versions", "node", version, "bin", "node"));
  } catch {
    // ignore
  }

  candidates.push("/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node");

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // ignore
    }
  }

  return "node";
}

function resolveShellPath(): string {
  const fallbackDirs = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];

  const home = process.env.HOME ?? "";
  if (home) {
    fallbackDirs.unshift(path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin"));
    const nvmDir = process.env.NVM_DIR ?? path.join(home, ".nvm");
    try {
      const version = fs.readFileSync(path.join(nvmDir, "alias", "default"), "utf8").trim();
      fallbackDirs.unshift(path.join(nvmDir, "versions", "node", version, "bin"));
    } catch {
      // ignore
    }
  }

  let basePath = process.env.PATH ?? "";
  try {
    const userShell = process.env.SHELL && path.isAbsolute(process.env.SHELL)
      ? process.env.SHELL
      : "/bin/zsh";
    const shellPath = execFileSync(userShell, ["-lc", "echo $PATH"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (shellPath) {
      basePath = shellPath;
    }
  } catch {
    // ignore
  }

  const existing = new Set(basePath.split(path.delimiter));
  const missing = fallbackDirs.filter((dir) => !existing.has(dir));
  return missing.length > 0
    ? basePath + path.delimiter + missing.join(path.delimiter)
    : basePath;
}

function getPidFilePath(): string {
  return path.join(app.getPath("userData"), PID_FILE_NAME);
}

function writePidFile(pid: number): void {
  try {
    fs.writeFileSync(getPidFilePath(), String(pid), "utf8");
  } catch {
    // ignore
  }
}

function cleanupPidFile(): void {
  try {
    fs.unlinkSync(getPidFilePath());
  } catch {
    // ignore
  }
}

function killOrphanedServer(): void {
  try {
    const pidStr = fs.readFileSync(getPidFilePath(), "utf8").trim();
    const pid = Number.parseInt(pidStr, 10);
    if (!Number.isNaN(pid) && pid > 0) {
      process.kill(pid, 0);
      treeKill(pid, "SIGTERM");
      console.log(`Killed orphaned server process (pid=${pid})`);
    }
  } catch {
    // ignore
  }

  cleanupPidFile();
}

function serverLogArchiveDir(logFile: string): string {
  return path.join(path.dirname(logFile), "log-archive");
}

function serverLogArchivePath(logFile: string, prefix: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace(".", "-");
  return path.join(serverLogArchiveDir(logFile), `${prefix}${stamp}.${randomUUID()}`);
}

function archiveServerLogPath(logFile: string, prefix: string = SERVER_LOG_ARCHIVE_PREFIX): void {
  const archiveDir = serverLogArchiveDir(logFile);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.renameSync(logFile, serverLogArchivePath(logFile, prefix));
}

function quarantineUnsafeServerLogPath(logFile: string): void {
  try {
    const stats = fs.lstatSync(logFile);
    if (stats.isFile()) {
      return;
    }

    archiveServerLogPath(logFile, SERVER_LOG_UNSAFE_PREFIX);
  } catch {
    // ignore
  }
}

function pruneServerLogArchives(logFile: string): void {
  try {
    const archiveDir = serverLogArchiveDir(logFile);
    const archives = fs
      .readdirSync(archiveDir)
      .filter((name) => {
        if (!name.startsWith(SERVER_LOG_ARCHIVE_PREFIX)) {
          return false;
        }

        try {
          return fs.lstatSync(path.join(archiveDir, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort();

    for (const stale of archives.slice(0, Math.max(0, archives.length - SERVER_LOG_ARCHIVE_KEEP))) {
      fs.unlinkSync(path.join(archiveDir, stale));
    }
  } catch {
    // ignore
  }
}

function rotateServerLogIfLarge(logFile: string): void {
  try {
    const stats = fs.lstatSync(logFile);
    if (!stats.isFile()) {
      return;
    }

    if (stats.size < SERVER_LOG_MAX_BYTES) {
      return;
    }

    archiveServerLogPath(logFile);
    pruneServerLogArchives(logFile);
  } catch {
    // ignore
  }
}

function resolvePaperclipHome(): string {
  return resolvePaperclipHomePath({
    env: process.env,
    homePath: app.getPath("home"),
    userDataPath: app.getPath("userData"),
    pathExists: fs.existsSync,
  });
}

/**
 * Where `prepare-server.mjs` stages the plugins that get preinstalled into the
 * local server. In a packaged app that is `<Resources>/app-server/plugins`. In
 * dev it is whatever the last `pnpm prepare-server` left under
 * `build/server-bundle/<variant>/plugins`, so a dev run exercises the same
 * packages the installer ships. `HAVEN_OFFICE_PLUGINS_DIR` overrides both.
 */
function resolveBundledPluginsRoot(): string {
  const override = process.env.HAVEN_OFFICE_PLUGINS_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  const root = getAppRoot();
  if (app.isPackaged) {
    return path.join(root, "plugins");
  }

  const bundleRoot = path.join(root, "build", "server-bundle");
  try {
    for (const variant of fs.readdirSync(bundleRoot).sort()) {
      const candidate = path.join(bundleRoot, variant, "plugins");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // No staged bundle in this checkout; nothing to preinstall.
  }

  return path.join(bundleRoot, "plugins");
}

function resolveTeamsCatalogDir(root: string): string {
  return app.isPackaged
    ? path.join(root, "server", "node_modules", "@paperclipai", "teams-catalog")
    : path.join(root, "node_modules", "@paperclipai", "teams-catalog");
}

function startServer(port: number): ChildProcess {
  const root = getAppRoot();
  const isWindows = process.platform === "win32";
  const enrichedPath = resolveShellPath();
  const paperclipHome = resolvePaperclipHome();
  const teamsCatalogDir = resolveTeamsCatalogDir(root);
  console.log(`Using PAPERCLIP_HOME: ${paperclipHome}`);

  const child = app.isPackaged
    ? spawn(findNodeBinary(), [path.join(root, "server", "dist", "index.js")], {
        cwd: root,
        env: {
          ...process.env,
          PATH: enrichedPath,
          NODE_ENV: "production",
          PORT: String(port),
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_TEAMS_CATALOG_DIR: teamsCatalogDir,
          PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: !isWindows,
      })
    : spawn("node", [path.join(root, "node_modules", "@paperclipai", "server", "dist", "index.js")], {
        cwd: root,
        env: {
          ...process.env,
          PATH: enrichedPath,
          NODE_ENV: "development",
          PORT: String(port),
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_TEAMS_CATALOG_DIR: teamsCatalogDir,
          PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: !isWindows,
      });

  if (child.pid) {
    writePidFile(child.pid);
  }

  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  return child;
}

function killServer(): Promise<void> {
  stopLocalServerMonitor();
  return new Promise((resolve) => {
    if (!serverProcess?.pid) {
      cleanupPidFile();
      resolve();
      return;
    }

    const pid = serverProcess.pid;
    serverProcess = null;

    treeKill(pid, "SIGTERM", () => {
      cleanupPidFile();
      resolve();
    });
  });
}

function killChildProcess(processToKill: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (!processToKill?.pid) {
      resolve();
      return;
    }

    treeKill(processToKill.pid, "SIGTERM", () => {
      resolve();
    });
  });
}

function trackServerProcess(processToTrack: ChildProcess | null): void {
  serverProcess = processToTrack;
  if (processToTrack?.pid) {
    writePidFile(processToTrack.pid);
    return;
  }
  cleanupPidFile();
}

function stopLocalServerMonitor(): void {
  if (localServerMonitorTimer) {
    clearInterval(localServerMonitorTimer);
    localServerMonitorTimer = null;
  }
  localServerHealthCheckInFlight = false;
}

function startLocalServerMonitor(origin: string): void {
  stopLocalServerMonitor();

  const checkHealth = async () => {
    if (localServerHealthCheckInFlight || isQuitting) {
      return;
    }

    if (currentConnection?.mode !== "local_embedded" || currentConnection.allowedOrigin !== origin) {
      return;
    }

    localServerHealthCheckInFlight = true;
    try {
      const result = await probeLocalServerHealth({
        origin,
        timeoutMs: LOCAL_SERVER_HEALTH_TIMEOUT_MS,
      });
      if (!result.ok) {
        await promptToRecoverLocalServer({
          message: "The embedded Paperclip server is no longer responding.",
          detail: result.detail ?? "Local server health checks are failing.",
        });
      }
    } finally {
      localServerHealthCheckInFlight = false;
    }
  };

  void checkHealth();
  localServerMonitorTimer = setInterval(() => {
    void checkHealth();
  }, LOCAL_SERVER_HEALTH_POLL_INTERVAL_MS);
}

async function promptToRecoverLocalServer(input: {
  message: string;
  detail: string;
}): Promise<void> {
  if (isQuitting || localServerFailureDialogOpen || currentConnection?.mode !== "local_embedded") {
    return;
  }

  stopLocalServerMonitor();
  localServerFailureDialogOpen = true;

  const parentWindow = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow
    : undefined;
  const messageBoxOptions = {
    type: "error" as const,
    title: "Local Paperclip Unavailable",
    message: input.message,
    detail: `${input.detail}\n\nRestart the local server to continue.`,
    buttons: ["Restart Local", "Quit"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };

  try {
    const { response } = parentWindow
      ? await dialog.showMessageBox(parentWindow, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions);

    if (response === 0) {
      await ensureLauncherWindow("local-boot");
      void bootLocal({ forceRestart: true });
      return;
    }

    app.quit();
  } finally {
    localServerFailureDialogOpen = false;
  }
}

// ---------------------------------------------------------------------------
// Launcher and window policy
// ---------------------------------------------------------------------------

function desiredLauncherPresentation(): LauncherPresentation {
  return mainWindow && !mainWindow.isDestroyed() ? "attached" : "standalone";
}

function closeLauncherWindow(): void {
  launcherContentHeightSettleTimers.forEach((timer) => clearTimeout(timer));
  launcherContentHeightSettleTimers = [];
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.close();
  }
  launcherWindow = null;
}

let launcherResizeTimer: ReturnType<typeof setTimeout> | null = null;
let launcherContentHeightSettleTimers: ReturnType<typeof setTimeout>[] = [];
let lastRequestedLauncherContentHeight = 0;

function animateLauncherContentHeight(
  startContentHeight: number,
  targetContentHeight: number,
): void {
  if (launcherResizeTimer) {
    clearInterval(launcherResizeTimer);
    launcherResizeTimer = null;
  }

  const delta = targetContentHeight - startContentHeight;
  if (Math.abs(delta) < 3) return;

  const durationMs = 180;
  const stepMs = 16;
  const steps = Math.max(1, Math.round(durationMs / stepMs));
  let step = 0;

  launcherResizeTimer = setInterval(() => {
    step += 1;
    if (!launcherWindow || launcherWindow.isDestroyed()) {
      if (launcherResizeTimer) clearInterval(launcherResizeTimer);
      launcherResizeTimer = null;
      return;
    }

    const t = Math.min(step / steps, 1);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - t, 3);
    const h = Math.round(startContentHeight + delta * eased);
    const [w] = launcherWindow.getContentSize();
    launcherWindow.setContentSize(w, h);

    if (t >= 1) {
      if (launcherResizeTimer) clearInterval(launcherResizeTimer);
      launcherResizeTimer = null;
    }
  }, stepMs);
}

function requestLauncherContentHeightSync(): void {
  if (!launcherWindow || launcherWindow.isDestroyed()) {
    return;
  }

  launcherWindow.webContents.send("launcher:request-content-height-sync");
  const timer = setTimeout(() => {
    if (!launcherWindow || launcherWindow.isDestroyed()) {
      return;
    }
    launcherWindow.webContents.send("launcher:request-content-height-sync");
  }, 80);
  launcherContentHeightSettleTimers.push(timer);
}

function settleLauncherContentHeight(targetContentHeight: number): void {
  if (!launcherWindow || launcherWindow.isDestroyed()) {
    return;
  }

  launcherContentHeightSettleTimers.forEach((timer) => clearTimeout(timer));
  const settleDelaysMs = [0, 80, 180, 320];
  launcherContentHeightSettleTimers = settleDelaysMs.map((delayMs) => setTimeout(() => {
    if (!launcherWindow || launcherWindow.isDestroyed() || !launcherWindow.isVisible()) {
      return;
    }

    const [, currentContentHeight] = launcherWindow.getContentSize();
    if (Math.abs(currentContentHeight - targetContentHeight) <= 2) {
      return;
    }

    animateLauncherContentHeight(currentContentHeight, targetContentHeight);
    launcherWindow.webContents.send("launcher:request-content-height-sync");
  }, delayMs));
}

function getAttachedLauncherDimensions(): {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
} {
  const parentBounds = mainWindow?.getBounds();
  const display = parentBounds
    ? screen.getDisplayMatching(parentBounds)
    : screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const width = Math.max(480, Math.min(560, workArea.width - 96));
  const height = Math.max(500, Math.min(620, workArea.height - 96));

  return {
    width,
    height,
    minWidth: width,
    minHeight: 400,
  };
}

async function createLauncherWindow(presentation: LauncherPresentation): Promise<BrowserWindow> {
  const attached = presentation === "attached";
  const attachedDimensions = attached
    ? getAttachedLauncherDimensions()
    : null;
  const launcher = new BrowserWindow({
    width: attached ? attachedDimensions!.width : 560,
    height: attached ? attachedDimensions!.height : 620,
    minWidth: attached ? attachedDimensions!.minWidth : 560,
    minHeight: attached ? attachedDimensions!.minHeight : 400,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: !attached,
    parent: attached ? mainWindow ?? undefined : undefined,
    modal: attached,
    title: "Haven Office",
    show: false,
    backgroundColor: "#0a0a0a",
    titleBarStyle: process.platform === "darwin" ? "hidden" : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "launcher-preload.js"),
    },
  });

  launcher.on("closed", () => {
    launcherWindow = null;
    launcherPresentation = "standalone";
  });

  await launcher.loadFile(ensureLauncherHtmlFile());
  launcherWindow = launcher;
  launcherPresentation = presentation;
  return launcher;
}

async function ensureLauncherWindow(view: LauncherView, payload?: object): Promise<BrowserWindow> {
  launcherView = view;
  const presentation = desiredLauncherPresentation();
  const mustRecreate =
    !launcherWindow ||
    launcherWindow.isDestroyed() ||
    launcherPresentation !== presentation;

  let launcher: BrowserWindow;
  if (mustRecreate) {
    closeLauncherWindow();
    launcher = await createLauncherWindow(presentation);
  } else {
    launcher = launcherWindow!;
  }

  if (!launcher.isVisible() && !mustRecreate) {
    launcher.show();
    launcher.focus();
  }
  sendLauncherState();
  sendLauncherNavigation(view, payload);
  return launcher;
}

function sendLauncherNavigation(view: LauncherView, payload: object = {}): void {
  launcherView = view;
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.webContents.send("launcher:navigate", { view, ...payload });
  }
}

function sendLauncherState(): void {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.webContents.send("launcher:state-changed", buildLauncherSnapshot());
  }
  rebuildAppMenu();
}

function sendBootStatus(step: BootStep, detail: string, progress: number): void {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.webContents.send("launcher:boot-status", { step, detail, progress });
  }
}

function sendConnectionError(title: string, detail: string): void {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.webContents.send("launcher:connection-error", { title, detail });
  }
}

function buildLauncherSnapshot() {
  const snapshot = connectionStore.getSnapshot();
  return {
    initialView: launcherView,
    activeProfileId: snapshot.state.activeProfileId,
    hasCurrentConnection: currentConnection !== null,
    isAttachedLauncher: launcherPresentation === "attached",
    currentConnectionLabel: describeCurrentConnection(),
    state: snapshot.state,
    profiles: connectionStore.listProfiles(),
  };
}

function describeCurrentConnection(): string | null {
  if (!currentConnection) {
    return null;
  }

  if (currentConnection.mode === "local_embedded") {
    return "Return to Local";
  }

  const profile = currentConnection.profileId
    ? connectionStore.getProfile(currentConnection.profileId)
    : null;
  if (profile?.mode === "remote_existing") {
    return `Return to ${profile.name}`;
  }

  try {
    return `Return to ${new URL(currentConnection.startUrl).host}`;
  } catch {
    return "Return to Current Session";
  }
}

function applyWindowPolicy(win: BrowserWindow, allowedOrigin: string): void {
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (isNavigationAllowed(targetUrl, allowedOrigin)) {
      return;
    }

    event.preventDefault();
    if (shouldOpenExternally(targetUrl, allowedOrigin)) {
      void shell.openExternal(targetUrl);
    }
  });

  win.webContents.on("will-redirect", (event, targetUrl) => {
    if (isNavigationAllowed(targetUrl, allowedOrigin)) {
      return;
    }

    event.preventDefault();
    if (shouldOpenExternally(targetUrl, allowedOrigin)) {
      void shell.openExternal(targetUrl);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternally(url, allowedOrigin)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  if (process.platform === "darwin") {
    win.on("swipe", (_event, direction) => {
      handleSwipeNavigation(direction, win.webContents.navigationHistory);
    });
  }
}

/**
 * Remembers the current view for a connection so the next launch reopens it.
 * Only the origin-relative path is stored, and only for in-origin URLs.
 */
function trackLastViewPath(win: BrowserWindow, profileId: string, allowedOrigin: string): void {
  const record = (targetUrl: string): void => {
    const viewPath = toViewPath(targetUrl, allowedOrigin);
    if (viewPath) {
      connectionStore.recordLastViewPath(profileId, viewPath);
    }
  };

  win.webContents.on("did-navigate", (_event, targetUrl) => {
    record(targetUrl);
  });

  // The web app is a single-page app, so most view changes are pushState.
  win.webContents.on("did-navigate-in-page", (_event, targetUrl, isMainFrame) => {
    if (isMainFrame) {
      record(targetUrl);
    }
  });
}

function createMainWindow(input: {
  mode: ConnectionMode;
  profileId: string | null;
  startUrl: string;
  allowedOrigin: string;
  partition: string;
  preloadPath?: string;
}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Haven Office",
    show: false,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: input.mode === "remote_existing",
      partition: input.partition,
      preload: input.preloadPath,
    },
  });

  applyWindowPolicy(win, input.allowedOrigin);

  if (input.profileId) {
    trackLastViewPath(win, input.profileId, input.allowedOrigin);
  }

  win.once("ready-to-show", () => {
    win.show();
  });

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  return win;
}

async function replaceMainWindow(nextWindow: BrowserWindow): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }

  mainWindow = nextWindow;
}

async function resetLocalEmbeddedUiSession(origin: string, windowSession: Session): Promise<void> {
  await windowSession.clearCache();
  await windowSession.clearStorageData({
    origin,
    storages: ["serviceworkers", "cachestorage"],
  });
}

async function clearRemoteProfileSession(profileId: string): Promise<void> {
  const remoteSession = session.fromPartition(remotePartitionForProfile(profileId));
  await remoteSession.clearCache();
  await remoteSession.clearStorageData();
  await remoteSession.clearAuthCache();
}

async function reopenCurrentConnectionWindow(): Promise<boolean> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    return true;
  }

  if (!currentConnection) {
    return false;
  }

  const window = createMainWindow({
    mode: currentConnection.mode,
    profileId: currentConnection.profileId,
    startUrl: currentConnection.startUrl,
    allowedOrigin: currentConnection.allowedOrigin,
    partition: currentConnection.partition,
    preloadPath:
      currentConnection.mode === "local_embedded"
        ? path.join(__dirname, "preload.js")
        : undefined,
  });

  if (currentConnection.mode === "local_embedded") {
    await resetLocalEmbeddedUiSession(currentConnection.allowedOrigin, window.webContents.session);
  }

  // Reopening returns to the remembered view rather than the original boot URL.
  await window.loadURL(
    resolveStartUrl({
      allowedOrigin: currentConnection.allowedOrigin,
      prefix: connectionStore.getCompanyPrefix(currentConnection.profileId),
      lastViewPath: connectionStore.getLastViewPath(currentConnection.profileId),
    }),
  );
  await replaceMainWindow(window);
  if (currentConnection.mode === "local_embedded") {
    initAutoUpdater(window);
  }
  return true;
}

function remotePartitionKey(profileId: string | null, origin: string): string {
  if (profileId) {
    return `persist:paperclip-remote-${profileId}`;
  }

  const hash = createHash("sha256").update(origin).digest("hex").slice(0, 12);
  return `persist:paperclip-remote-${hash}`;
}

/**
 * Probe a remote through the same Chromium session the window will use.
 *
 * Verifying over a different network stack than we connect over is how you get
 * a "Verify Remote" that disagrees with "Connect Remote". The global `fetch` in
 * the main process is Node's undici: it carries Node's own bundled CA list
 * instead of the OS trust store, so a host issued by a private lab CA fails
 * verification while the browser window loads it fine, and it ignores the proxy
 * and client-certificate configuration the session applies.
 *
 * The session alone does not make the probe *authenticated* — see
 * src/connection/partition-probe-fetch.ts, which is where the cookies and the
 * declined redirects both come from. This function is only the Electron wiring.
 */
function remotePartitionFetch(profileId: string | null, origin: string): typeof fetch {
  const preflightSession = session.fromPartition(remotePartitionKey(profileId, origin));
  // electronNet.request rather than preflightSession.fetch: both use Chromium's
  // stack, but only the former lets us decline a redirect and still see it. See
  // src/connection/manual-redirect-fetch.ts.
  return createPartitionProbeFetch({
    session: preflightSession,
    createRequest: (init) => electronNet.request(init),
    readCookies: partitionCookieReader(preflightSession),
  });
}

// ---------------------------------------------------------------------------
// Connection boot flows
// ---------------------------------------------------------------------------

async function bootLocal(options: {
  rememberChoiceExplicit?: boolean;
  rememberChoice?: boolean;
  forceRestart?: boolean;
} = {}): Promise<void> {
  const bootId = ++bootSequence;
  stopLocalServerMonitor();

  if (!options.forceRestart && currentConnection?.mode === "local_embedded" && mainWindow && !mainWindow.isDestroyed()) {
    connectionStore.recordConnectionResult(LOCAL_PROFILE_ID);
    if (options.rememberChoiceExplicit) {
      connectionStore.setRememberedProfile(
        LOCAL_PROFILE_ID,
        options.rememberChoice === true,
      );
    }
    sendLauncherState();
    closeLauncherWindow();
    mainWindow.focus();
    return;
  }

  const previousConnectionMode = currentConnection?.mode ?? null;
  const previousServerProcess = previousConnectionMode === "local_embedded" ? serverProcess : null;
  let nextServerProcess: ChildProcess | null = null;
  await ensureLauncherWindow("local-boot");

  try {
    sendBootStatus("init", "Preparing environment...", 5);

    serverPort = await findFreePort(PREFERRED_PORT);
    if (bootId !== bootSequence) {
      return;
    }

    sendBootStatus("database", "Launching embedded PostgreSQL...", 15);
    nextServerProcess = startServer(serverPort);
    trackServerProcess(nextServerProcess);

    const logFile = path.join(app.getPath("userData"), "server.log");
    quarantineUnsafeServerLogPath(logFile);
    rotateServerLogIfLarge(logFile);
    const logStream = fs.createWriteStream(logFile, { flags: "a" });
    logStream.write(`\n--- Server start ${new Date().toISOString()} (port=${serverPort}) ---\n`);

    let dbReady = false;
    let serverListening = false;
    let lastProgress = 15;
    const serverOutputLines: string[] = [];

    const updateProgress = (step: BootStep, detail: string, progress: number) => {
      if (progress <= lastProgress || bootId !== bootSequence) {
        return;
      }
      lastProgress = progress;
      sendBootStatus(step, detail, progress);
    };

    const onServerData = (chunk: Buffer) => {
      const text = chunk.toString();
      serverOutputLines.push(...text.split("\n").filter(Boolean));
      if (serverOutputLines.length > 200) {
        serverOutputLines.splice(0, serverOutputLines.length - 200);
      }
      logStream.write(text);

      if (!dbReady && (text.includes("PostgreSQL ready") || text.includes("migration"))) {
        dbReady = true;
        updateProgress("database", "Running migrations...", 35);
      }

      if (!serverListening && text.includes("Server listening on")) {
        serverListening = true;
        updateProgress("server", "Server is starting...", 55);
      }
    };

    nextServerProcess.stdout?.on("data", onServerData);
    nextServerProcess.stderr?.on("data", onServerData);

    nextServerProcess.on("exit", (code, signal) => {
      logStream.end();
      if (!shouldHandleTrackedServerExit(serverProcess, nextServerProcess)) {
        return;
      }

      trackServerProcess(null);
      stopLocalServerMonitor();
      const tail = serverOutputLines.slice(-30).join("\n");
      console.error(`Server exited unexpectedly (code=${code}, signal=${signal})\n${tail}`);
      void promptToRecoverLocalServer({
        message: "The embedded Paperclip server stopped unexpectedly.",
        detail: `Exit code: ${code}, signal: ${signal}\n\nLog: ${logFile}\n\n${tail}`,
      });
    });

    const progressInterval = setInterval(() => {
      if (bootId !== bootSequence) {
        clearInterval(progressInterval);
        return;
      }

      if (!dbReady) {
        updateProgress("database", "Launching embedded PostgreSQL...", 20);
      } else if (!serverListening) {
        updateProgress("server", "Waiting for server...", 50);
      }
    }, 2_000);

    updateProgress("server", "Waiting for server...", 45);
    await waitForPort(serverPort, SERVER_STARTUP_TIMEOUT_MS);
    clearInterval(progressInterval);

    if (bootId !== bootSequence) {
      if (shouldStopAttemptedServer(nextServerProcess, serverProcess)) {
        await killChildProcess(nextServerProcess);
        if (shouldRestorePreviousTrackedServer(previousServerProcess, nextServerProcess, serverProcess)) {
          trackServerProcess(previousServerProcess);
        } else {
          trackServerProcess(null);
        }
      }
      return;
    }

    sendBootStatus("server", "Server is ready", 70);

    const allowedOrigin = new URL(`http://localhost:${serverPort}`).origin;
    // Preinstall the bundled plugins before the window loads: the start path
    // defaults to the office, which only exists once its plugin is installed.
    sendBootStatus("server", "Preparing the office...", 75);
    await provisionBundledPlugins({
      origin: allowedOrigin,
      pluginsRoot: resolveBundledPluginsRoot(),
    });
    if (bootId !== bootSequence) {
      if (shouldStopAttemptedServer(nextServerProcess, serverProcess)) {
        await killChildProcess(nextServerProcess);
        if (shouldRestorePreviousTrackedServer(previousServerProcess, nextServerProcess, serverProcess)) {
          trackServerProcess(previousServerProcess);
        } else {
          trackServerProcess(null);
        }
      }
      return;
    }

    sendBootStatus("ready", "Loading the UI...", 80);

    // Land on the remembered view, defaulting to the office on first run.
    const startUrl = resolveStartUrl({
      allowedOrigin,
      prefix: connectionStore.getCompanyPrefix(LOCAL_PROFILE_ID),
      lastViewPath: connectionStore.getLastViewPath(LOCAL_PROFILE_ID),
    });
    const window = createMainWindow({
      mode: "local_embedded",
      profileId: LOCAL_PROFILE_ID,
      startUrl,
      allowedOrigin,
      partition: localPartition(),
      preloadPath: path.join(__dirname, "preload.js"),
    });

    await resetLocalEmbeddedUiSession(allowedOrigin, window.webContents.session);
    await window.loadURL(startUrl);
    if (bootId !== bootSequence) {
      window.destroy();
      if (shouldStopAttemptedServer(nextServerProcess, serverProcess)) {
        await killChildProcess(nextServerProcess);
        if (shouldRestorePreviousTrackedServer(previousServerProcess, nextServerProcess, serverProcess)) {
          trackServerProcess(previousServerProcess);
        } else {
          trackServerProcess(null);
        }
      }
      return;
    }

    await replaceMainWindow(window);
    if (shouldKillSupersededServer(previousServerProcess, nextServerProcess)) {
      await killChildProcess(previousServerProcess);
    }
    currentConnection = {
      mode: "local_embedded",
      profileId: LOCAL_PROFILE_ID,
      startUrl,
      allowedOrigin,
      partition: localPartition(),
    };
    syncTrayController();
    connectionStore.recordConnectionResult(LOCAL_PROFILE_ID);
    if (options.rememberChoiceExplicit) {
      connectionStore.setRememberedProfile(
        LOCAL_PROFILE_ID,
        options.rememberChoice === true,
      );
    }
    sendLauncherState();

    sendBootStatus("ready", "Ready!", 100);
    startLocalServerMonitor(allowedOrigin);
    closeLauncherWindow();
    initAutoUpdater(window);
  } catch (error) {
    if (shouldStopAttemptedServer(nextServerProcess, serverProcess)) {
      await killChildProcess(nextServerProcess);
      if (shouldRestorePreviousTrackedServer(previousServerProcess, nextServerProcess, serverProcess)) {
        trackServerProcess(previousServerProcess);
      } else {
        trackServerProcess(null);
      }
    }
    sendConnectionError(
      "Failed to start local Paperclip",
      error instanceof Error ? error.message : String(error),
    );
    sendLauncherNavigation("error");
  }
}

async function bootRemote(options: {
  profileId?: string;
  remoteUrl: string;
  displayName?: string;
  saveProfile: boolean;
  rememberChoiceExplicit?: boolean;
  rememberChoice?: boolean;
  allowInsecureHttp?: boolean;
}): Promise<void> {
  const bootId = ++bootSequence;
  const previousConnectionMode = currentConnection?.mode ?? null;

  let normalized;
  try {
    normalized = normalizeRemoteUrl(options.remoteUrl);
    if (normalized.insecureTransport && options.allowInsecureHttp !== true) {
      throw new Error("HTTP remotes require confirming that you want to allow an insecure connection.");
    }
  } catch (error) {
    await ensureLauncherWindow("remote-form");
    sendConnectionError(
      "Invalid remote URL",
      error instanceof Error ? error.message : "Enter a valid remote URL.",
    );
    sendLauncherNavigation("error");
    return;
  }

  await ensureLauncherWindow("connecting", {
    label: "Opening verified remote...",
    url: normalized.normalizedUrl,
  });

  const result = await preflightRemoteConnection({
    remoteUrl: normalized.normalizedUrl,
    localServerVersion: resolveLocalServerVersion(),
    fetchImpl: remotePartitionFetch(options.profileId ?? null, normalized.origin),
  });

  if (bootId !== bootSequence) {
    return;
  }

  if (!result.ok) {
    if (options.profileId) {
      connectionStore.recordRemoteHealth(options.profileId, result);
      sendLauncherState();
    }

    sendConnectionError(
      remoteErrorTitle(result),
      result.detail ?? "Could not verify the selected remote.",
    );
    sendLauncherNavigation("error");
    return;
  }

  let savedProfile: ConnectionProfile | null = null;
  if (options.profileId) {
    connectionStore.syncRemoteProfileUrl(options.profileId, result.normalizedUrl, result.insecureTransport);
    savedProfile = connectionStore.getProfile(options.profileId);
  } else if (options.saveProfile || options.rememberChoice) {
    savedProfile = connectionStore.saveRemoteProfile({
      name: options.displayName,
      remoteUrl: result.normalizedUrl,
      allowInsecureHttp: result.insecureTransport,
    });
  }

  if (savedProfile) {
    connectionStore.recordRemoteHealth(savedProfile.id, result);
  }
  if (options.rememberChoiceExplicit) {
    connectionStore.setRememberedProfile(savedProfile?.id ?? null, options.rememberChoice === true);
  }
  sendLauncherState();

  const profileId = savedProfile?.id ?? options.profileId ?? null;
  const partition = remotePartitionKey(profileId, result.origin);
  // Setup and sign-in are driven by the server's own redirects, so only a
  // usable session deep-links to the office or the remembered view.
  const startUrl =
    result.bootstrapStatus === "bootstrap_pending" || result.sessionState === "signed_out"
      ? result.normalizedUrl
      : resolveStartUrl({
          allowedOrigin: result.origin,
          prefix: connectionStore.getCompanyPrefix(profileId),
          lastViewPath: connectionStore.getLastViewPath(profileId),
        });
  const window = createMainWindow({
    mode: "remote_existing",
    profileId,
    startUrl,
    allowedOrigin: result.origin,
    partition,
  });

  const label = result.bootstrapStatus === "bootstrap_pending"
    ? "Opening remote setup..."
    : result.sessionState === "signed_out"
      ? "Opening remote sign-in..."
      : "Opening verified remote...";
  sendLauncherNavigation("connecting", {
    label,
    url: result.normalizedUrl,
  });

  try {
    await window.loadURL(startUrl);
    if (bootId !== bootSequence) {
      window.destroy();
      return;
    }

    closeLauncherWindow();
    await replaceMainWindow(window);
    if (previousConnectionMode === "local_embedded") {
      await killServer();
    }
    currentConnection = {
      mode: "remote_existing",
      profileId: savedProfile?.id ?? null,
      startUrl,
      allowedOrigin: result.origin,
      partition,
    };
    syncTrayController();
    if (savedProfile) {
      connectionStore.recordConnectionResult(savedProfile.id, result);
    }
    sendLauncherState();
  } catch (error) {
    sendConnectionError(
      "Failed to open remote Paperclip",
      error instanceof Error ? error.message : String(error),
    );
    sendLauncherNavigation("error");
  }
}

async function bootSavedProfile(
  profileId: string,
  options: { rememberChoiceExplicit?: boolean; rememberChoice?: boolean } = {},
): Promise<void> {
  if (profileId === LOCAL_PROFILE_ID) {
    await bootLocal(options);
    return;
  }

  const profile = connectionStore.getProfile(profileId);
  if (!profile || profile.mode !== "remote_existing" || !profile.remoteUrl) {
    throw new Error(`Unknown saved profile: ${profileId}`);
  }

  await bootRemote({
    profileId,
    remoteUrl: profile.remoteUrl,
    displayName: profile.name,
    saveProfile: false,
    rememberChoiceExplicit: options.rememberChoiceExplicit,
    rememberChoice: options.rememberChoice,
    allowInsecureHttp: profile.allowInsecureHttp,
  });
}

// ---------------------------------------------------------------------------
// Launcher IPC
// ---------------------------------------------------------------------------

function registerLauncherIpc(): void {
  ipcMain.handle("launcher:bootstrap", () => buildLauncherSnapshot());

  ipcMain.handle("launcher:set-chooser-mode", (_event, mode: ConnectionMode) => {
    connectionStore.setChooserMode(mode);
    sendLauncherState();
    return buildLauncherSnapshot();
  });

  ipcMain.handle(
    "launcher:save-remote-profile",
    (_event, payload: { profileId?: string; name?: string; remoteUrl: string; allowInsecureHttp?: boolean }) => {
      connectionStore.saveRemoteProfile(payload);
      sendLauncherState();
      return buildLauncherSnapshot();
    },
  );

  ipcMain.handle("launcher:duplicate-profile", (_event, profileId: string) => {
    connectionStore.duplicateRemoteProfile(profileId);
    sendLauncherState();
    return buildLauncherSnapshot();
  });

  ipcMain.handle("launcher:delete-profile", async (_event, profileId: string) => {
    await clearRemoteProfileSession(profileId);
    connectionStore.deleteRemoteProfile(profileId);
    if (currentConnection?.mode === "remote_existing" && currentConnection.profileId === profileId) {
      currentConnection = {
        ...currentConnection,
        profileId: null,
      };
      syncTrayController();
    }
    sendLauncherState();
    return buildLauncherSnapshot();
  });

  ipcMain.handle("launcher:verify-remote", (_event, payload: { remoteUrl: string }) => {
    // Verify over the very partition Connect Remote would use. Without this the
    // button probed with Node's global fetch while the connection used the
    // Chromium session, so the two could disagree about the same host.
    let fetchImpl: typeof fetch | undefined;
    try {
      fetchImpl = remotePartitionFetch(null, normalizeRemoteUrl(payload.remoteUrl).origin);
    } catch {
      // No parseable origin means no partition to probe through; preflight
      // reports invalid_url without issuing a request.
      fetchImpl = undefined;
    }

    return preflightRemoteConnection({
      remoteUrl: payload.remoteUrl,
      localServerVersion: resolveLocalServerVersion(),
      fetchImpl,
    });
  });

  ipcMain.handle("launcher:connect-local", async (_event, payload: { rememberChoice: boolean }) => {
    void bootLocal({
      rememberChoiceExplicit: true,
      rememberChoice: payload.rememberChoice,
    });
    return { started: true };
  });

  ipcMain.handle(
    "launcher:connect-remote",
    async (
      _event,
      payload: {
        profileId?: string;
        remoteUrl: string;
        displayName?: string;
        saveProfile: boolean;
        rememberChoice: boolean;
        allowInsecureHttp?: boolean;
      },
    ) => {
      void bootRemote({
        ...payload,
        rememberChoiceExplicit: true,
        rememberChoice: payload.rememberChoice,
      });
      return { started: true };
    },
  );

  ipcMain.handle(
    "launcher:connect-saved-profile",
    async (_event, payload: { profileId: string; rememberChoice: boolean }) => {
      void bootSavedProfile(payload.profileId, {
        rememberChoiceExplicit: true,
        rememberChoice: payload.rememberChoice,
      });
      return { started: true };
    },
  );

  ipcMain.handle("launcher:open-current-remote", async () => {
    const opened = await reopenCurrentConnectionWindow();
    return { opened };
  });

  ipcMain.handle("launcher:return-to-current-session", async () => {
    closeLauncherWindow();
    const opened = await reopenCurrentConnectionWindow();
    return { opened };
  });

  ipcMain.handle("launcher:close-sheet", async () => {
    closeLauncherWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      return { closed: true };
    }

    const opened = await reopenCurrentConnectionWindow();
    return { closed: opened };
  });

  ipcMain.handle("launcher:report-content-height", async (_event, height: number) => {
    if (!launcherWindow || launcherWindow.isDestroyed()) return;
    const bounds = launcherWindow.getBounds();
    const maxContentHeight = screen.getDisplayMatching(bounds).workArea.height - 96;
    const newContentHeight = Math.max(400, Math.min(height, maxContentHeight));
    lastRequestedLauncherContentHeight = newContentHeight;
    const [, currentContentHeight] = launcherWindow.getContentSize();

    if (!launcherWindow.isVisible()) {
      const [w] = launcherWindow.getContentSize();
      launcherWindow.setContentSize(w, newContentHeight);
      launcherWindow.show();
      launcherWindow.focus();
      requestLauncherContentHeightSync();
      settleLauncherContentHeight(newContentHeight);
      return;
    }

    if (Math.abs(currentContentHeight - newContentHeight) > 2) {
      animateLauncherContentHeight(currentContentHeight, newContentHeight);
    }
    settleLauncherContentHeight(lastRequestedLauncherContentHeight);
  });

  ipcMain.handle("launcher:show-chooser", async () => {
    await ensureLauncherWindow("chooser");
    return buildLauncherSnapshot();
  });
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function rebuildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Haven Office",
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates",
          click: () => {
            void checkForUpdatesFromMenu(
              BrowserWindow.getFocusedWindow() ?? mainWindow ?? launcherWindow,
            );
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Connection",
      submenu: buildConnectionMenuItems(),
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        ...buildDesktopViewMenuItems(),
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Documentation",
          click: () => {
            void shell.openExternal("https://docs.paperclip.ing/");
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Office/Board items for the active connection. Each one resolves through
 * `resolveDesktopViewUrl`, so a view that would leave the allowed origin is
 * simply not navigable.
 */
function buildDesktopViewMenuItems(): MenuItemConstructorOptions[] {
  return DESKTOP_VIEWS.map((view) => ({
    label: view.label,
    accelerator: view.accelerator,
    enabled: currentConnection !== null,
    click: () => {
      void navigateToDesktopView(view.key);
    },
  }));
}

async function navigateToDesktopView(viewKey: string): Promise<void> {
  if (!currentConnection) {
    return;
  }

  const target = resolveDesktopViewUrl({
    allowedOrigin: currentConnection.allowedOrigin,
    prefix: connectionStore.getCompanyPrefix(currentConnection.profileId),
    viewKey,
  });
  if (!target) {
    return;
  }

  if (!(await reopenCurrentConnectionWindow())) {
    return;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(target);
  }
}

/**
 * Click-through for the tray (HAV-43): the same reopen-then-load path
 * `navigateToDesktopView` uses, so there is one navigation path, not two.
 * `url` is already resolved and origin-checked by the tray controller
 * (`resolveWithinOrigin` / `resolveDesktopViewUrl`) before this is called.
 */
async function openUrlInConnectionWindow(url: string): Promise<void> {
  if (!(await reopenCurrentConnectionWindow())) {
    return;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(url);
  }
}

/**
 * (Re)builds the tray's data source to match `currentConnection`. Called
 * after every place that assigns `currentConnection`, so the tray never
 * polls a stale origin or partition after switching accounts.
 */
function syncTrayController(): void {
  trayController?.stop();
  trayController = null;

  if (!currentConnection) {
    return;
  }

  const { profileId, allowedOrigin, partition } = currentConnection;
  const companyPrefix = connectionStore.getCompanyPrefix(profileId);
  const connectionName = profileId ? connectionStore.getProfile(profileId)?.name ?? null : null;

  trayController = createTrayController({
    client: createElectronPaperclipClient({
      origin: allowedOrigin,
      companyId: companyPrefix,
      partition,
      // The partition already uniquely scopes a saved profile or an ad hoc
      // origin (see `remotePartitionKey`); reusing it here keeps the
      // fallback-credential scope consistent with the cookie scope instead
      // of inventing a second identity for the same connection.
      profileId: profileId ?? partition,
      userDataPath: app.getPath("userData"),
    }),
    userDataPath: app.getPath("userData"),
    allowedOrigin,
    companyPrefix,
    connectionName,
    onOpenUrl: (url) => {
      void openUrlInConnectionWindow(url);
    },
    iconPath: trayIconPath(),
    isFocused: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
  });
}

function buildConnectionMenuItems(): MenuItemConstructorOptions[] {
  const snapshot = connectionStore.getSnapshot();
  const recentProfiles = connectionStore.getRecentRemoteProfiles(5);

  const items: MenuItemConstructorOptions[] = [
    {
      label: "Launch Chooser",
      click: () => {
        void ensureLauncherWindow("chooser");
      },
    },
    {
      label: "Connect Local",
      click: () => {
        void ensureLauncherWindow("local-boot").then(() => bootLocal());
      },
    },
    {
      label: "Manage Connections",
      click: () => {
        void ensureLauncherWindow("saved");
      },
    },
    {
      label: "Always Show Chooser On Launch",
      type: "checkbox",
      checked: snapshot.state.alwaysShowChooser,
      click: (menuItem) => {
        connectionStore.setAlwaysShowChooser(menuItem.checked);
        sendLauncherState();
      },
    },
  ];

  if (recentProfiles.length > 0) {
    items.push({ type: "separator" });
    items.push(
      ...recentProfiles.map((profile) => ({
        label: `${profile.name} (${new URL(profile.remoteUrl ?? "https://example.com").host})`,
        click: () => {
          void ensureLauncherWindow("connecting", {
            label: "Opening verified remote...",
            url: profile.remoteUrl,
          }).then(() => bootSavedProfile(profile.id));
        },
      })),
    );
  }

  return items;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function remoteErrorTitle(result: RemotePreflightResult): string {
  switch (result.reason) {
    case "unsupported_local_trusted":
      return "Remote not eligible";
    case "not_paperclip":
      return "Non-Paperclip endpoint";
    case "tls_error":
      return "TLS validation failed";
    case "auth_not_ready":
      return "Remote auth is not ready";
    default:
      return "Could not verify remote";
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }

  const paperclipHome = resolvePaperclipHome();
  assertIsolatedRuntimePaths({
    env: process.env,
    userDataPath: app.getPath("userData"),
    paperclipHome,
    homePath: app.getPath("home"),
    platform: process.platform,
  });

  killOrphanedServer();
  connectionStore = new ConnectionStore(getConnectionsFilePath(app.getPath("userData")));
  registerLauncherIpc();
  rebuildAppMenu();

  const startupProfileId = connectionStore.getStartupProfileId();
  if (startupProfileId) {
    if (startupProfileId === LOCAL_PROFILE_ID) {
      await ensureLauncherWindow("local-boot");
      markAppStartupReadyForFocus();
      void bootLocal();
      return;
    }

    const profile = connectionStore.getProfile(startupProfileId);
    if (profile?.mode === "remote_existing" && profile.remoteUrl) {
      await ensureLauncherWindow("connecting", {
        label: "Opening verified remote...",
        url: profile.remoteUrl,
      });
      markAppStartupReadyForFocus();
      void bootSavedProfile(startupProfileId);
      return;
    }
  }

  connectionStore.setChooserMode("local_embedded");
  await ensureLauncherWindow("chooser");
  markAppStartupReadyForFocus();
});

app.on("activate", () => {
  if (!appStartupReadyForFocus) {
    pendingSecondInstanceFocus = true;
    return;
  }

  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.show();
    launcherWindow.focus();
    return;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  if (currentConnection) {
    void reopenCurrentConnectionWindow();
    return;
  }

  void ensureLauncherWindow("chooser");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async (event) => {
  if (isQuitting) {
    return;
  }

  stopLocalServerMonitor();
  trayController?.stop();
  trayController = null;
  if (!serverProcess) {
    return;
  }

  isQuitting = true;
  event.preventDefault();
  await killServer();
  app.quit();
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    isQuitting = true;
    void killServer().then(() => app.quit());
  });
}
