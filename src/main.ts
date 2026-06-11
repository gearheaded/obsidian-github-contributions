import {
  App,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  moment,
  TFile,
  requestUrl,
} from "obsidian";

// ########################################################################
// Constants
// ########################################################################
// Unique identifier for the Obsidian sidebar view — must match registerView() call
const VIEW_TYPE = "github-contributions";

// GitHub API endpoints
const GITHUB_GRAPHQL    = "https://api.github.com/graphql";
const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL  = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL   = "https://api.github.com/user";

// OAuth App Client ID — registered at github.com/settings/developers
// Device flow does NOT require a client secret, only the Client ID
const GITHUB_CLIENT_ID = "Ov23litfj5GbQ8mw81VV";

const MONTHS       = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ########################################################################
// Types
// ########################################################################
type SizePreset = "ultra-compact" | "compact" | "medium" | "large" | "fit";
type ViewMode = "year" | "month";
type DataSource = "github" | "local" | "both";

// Unified data structure for a single day, merging GitHub and local git data.
// count = githubCount + localCount (always kept in sync).
// repos maps each repo name to its commit count for that day.
interface DayData {
  date: string;            // ISO format YYYY-MM-DD
  count: number;           // total contributions (github + local)
  githubCount: number;     // contributions from GitHub API
  localCount: number;      // contributions from local git log
  repos: Record<string, number>; // per-repo breakdown, shown in tooltip
}

interface StreakInfo {
  current: number;
  longest: number;
}

// Represents a discovered local git repository
interface LocalRepo {
  name: string;             // folder name, used as display label
  path: string;             // absolute path on disk
  lastCommit: string | null; // date of most recent commit (ISO), or null if no commits
}

interface GitHubContributionsSettings {
  // Auth
  authMethod: "oauth" | "pat";
  githubToken: string;
  githubUsername: string;
  // Data sources
  dataSource: DataSource;
  localRepoRoot: string;
  scanDepth: number; // 2-5, or 0 = unlimited
  // Display
  sidebarSide: "left" | "right";
  selectedYear: number;
  sizePreset: SizePreset;
  defaultView: ViewMode;
  palette: Palette;
  statsStyle: StatsStyle;
  demoMode: boolean;
  showLegend: boolean;
  tooltipStyle: TooltipStyle;
  // Daily notes
  dailyNoteFolder: string;
  dailyNoteDateFormat: string;
}

const DEFAULT_SETTINGS: GitHubContributionsSettings = {
  authMethod: "oauth",
  githubToken: "",
  githubUsername: "",
  dataSource: "github",
  localRepoRoot: "",
  scanDepth: 2,
  demoMode: false,
  showLegend: true,
  tooltipStyle: "standard",
  sidebarSide: "right",
  selectedYear: new Date().getFullYear(),
  sizePreset: "medium",
  defaultView: "year",
  palette: "classic",
  statsStyle: "default",
  dailyNoteFolder: "",
  dailyNoteDateFormat: "YYYY-MM-DD",
};

// Pixel dimensions for each size preset.
// "fit" uses cell:0 as a sentinel — actual size is calculated at render time
// based on the panel's current width via ResizeObserver.
const PRESET_SIZES: Record<SizePreset, { cell: number; gap: number }> = {
  "ultra-compact": { cell: 7,  gap: 1 },
  "compact":       { cell: 9,  gap: 1 },
  "medium":        { cell: 11, gap: 2 },
  "large":         { cell: 14, gap: 3 },
  "fit":           { cell: 0,  gap: 2 }, // sentinel — calculated at render time
};

// ########################################################################
// Palettes
// ########################################################################
type Palette = "classic" | "high-contrast" | "cobalt" | "neon" | "ember";
type StatsStyle = "compact" | "default" | "grid";
type TooltipStyle = "standard" | "simple";

// Each palette has 5 colours for contribution levels 0–4.
// Level 0 = no contributions (empty cell), level 4 = highest activity.
// Separate dark/light variants so the graph respects Obsidian's theme.
// These are injected as CSS custom properties (--gh-c0 through --gh-c4)
// on <body> so they can be swapped without re-rendering the grid.
interface PaletteColors {
  dark:  [string, string, string, string, string]; // levels 0-4, dark theme
  light: [string, string, string, string, string]; // levels 0-4, light theme
}

const PALETTES: Record<Palette, PaletteColors> = {
  "classic": {
    dark:  ["var(--background-modifier-border)", "#0e4429", "#006d32", "#26a641", "#39d353"],
    light: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
  },
  "high-contrast": {
    dark:  ["var(--background-modifier-border)", "#1a5e2a", "#21a045", "#32d463", "#7fffb0"],
    light: ["#ebedf0", "#b6f0c2", "#3dd668", "#1a9e40", "#0a5c25"],
  },
  "cobalt": {
    dark:  ["var(--background-modifier-border)", "#0a3a6b", "#0e6eb5", "#1ab3d8", "#57e8f5"],
    light: ["#edf4fb", "#b3d4f0", "#4aa8e0", "#1478c8", "#064a8a"],
  },
  "neon": {
    dark:  ["var(--background-modifier-border)", "#2d0a4e", "#7b00c2", "#e0008c", "#ffe600"],
    light: ["#f5eaff", "#c97df5", "#9400d3", "#d4006a", "#c8a800"],
  },
  "ember": {
    dark:  ["var(--background-modifier-border)", "#3d1f00", "#b45200", "#e8820c", "#ffc832"],
    light: ["#f5f0e8", "#f5d5a0", "#e8820c", "#b45200", "#7a3200"],
  },
};

// ########################################################################
// Helpers
// ########################################################################
// Generic debounce utility — delays fn execution until ms milliseconds after
// the last call. Used on text input fields (repo root, daily notes folder, date
// format) to avoid triggering expensive saves/scans on every keystroke.
function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

// ########################################################################
// OAuth Device Flow
// ########################################################################

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

// Step 1 of OAuth device flow: request a device code and user code from GitHub.
// We use Obsidian's requestUrl (not fetch) because the device flow endpoint
// doesn't have CORS headers, so direct fetch() calls from Obsidian's webview fail.
// Returns the user_code to display, device_code to poll with, and expiry/interval.
async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  let res;
  try {
    res = await requestUrl({
      url: GITHUB_DEVICE_URL,
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
    });
  } catch {
    throw new Error("Could not reach GitHub. Check your internet connection.");
  }
  if (res.status !== 200) throw new Error(`GitHub returned an error (${res.status}). Try again.`);
  return res.json;
}

// Step 2 of OAuth device flow: poll GitHub until the user approves or the code expires.
// GitHub's spec requires respecting the interval and backing off on slow_down responses.
// onCancel is checked before each poll so the Cancel button works immediately.
// Network errors retry silently rather than failing — a brief connection hiccup
// shouldn't kill the whole auth flow.
async function pollForToken(
  deviceCode: string,
  intervalSecs: number,
  expiresIn: number,
  onCancel: () => boolean
): Promise<string> {
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
  let currentInterval = Math.max(intervalSecs, 5) * 1000; // minimum 5s per GitHub spec
  const deadline = Date.now() + expiresIn * 1000;

  while (true) {
    if (onCancel()) throw new Error("Cancelled");
    await delay(currentInterval);
    if (onCancel()) throw new Error("Cancelled");

    // Check if code has expired client-side before even polling
    if (Date.now() > deadline) throw new Error("Code expired. Please try again.");

    let data: Record<string, string>;
    try {
      const res = await requestUrl({
        url: GITHUB_TOKEN_URL,
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      data = res.json;
    } catch {
      // Network error - wait and retry rather than failing immediately
      await delay(5000);
      if (onCancel()) throw new Error("Cancelled");
      continue;
    }

    if (data.access_token) return data.access_token;

    switch (data.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        // GitHub asked us to back off - increase interval permanently
        currentInterval += 5000;
        continue;
      case "expired_token":
        throw new Error("Code expired. Please try again.");
      case "access_denied":
        throw new Error("Access was denied. You can try again anytime.");
      case "incorrect_device_code":
        throw new Error("Invalid device code. Please try again.");
      default:
        throw new Error(data.error_description ?? data.error ?? "Unknown OAuth error");
    }
  }
}

async function fetchGitHubUsername(token: string): Promise<string> {
  const res = await requestUrl({
    url: GITHUB_USER_URL,
    headers: { Authorization: `bearer ${token}` },
  });
  if (res.status !== 200) throw new Error("Could not fetch GitHub username");
  return res.json.login;
}

// ########################################################################
// GitHub API
// ########################################################################
// Fetches the full year's contribution calendar from GitHub's GraphQL API.
// Returns a Map<dateString, count> for easy merging with local git data.
// Uses regular fetch (not requestUrl) because the GraphQL API has proper CORS headers.
// Only requests the minimum data needed — no PR/issue/review data, just the calendar.
async function fetchGitHubContributions(
  username: string,
  token: string,
  year: number
): Promise<Map<string, number>> {
  const from = `${year}-01-01T00:00:00Z`;
  const to   = `${year}-12-31T23:59:59Z`;
  const query = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}`;
  const res = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { login: username, from, to } }),
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message ?? "GitHub API error");
  const weeks = json?.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!weeks) throw new Error("No data returned. Check your username.");
  const map = new Map<string, number>();
  for (const week of weeks) {
    for (const day of week.contributionDays) {
      map.set(day.date, day.contributionCount);
    }
  }
  return map;
}

// ########################################################################
// Local Git
// ########################################################################

// window.require is available in Obsidian desktop (Electron) but not on mobile.
// All local git functionality is gated behind this check so the plugin
// loads safely on mobile without crashing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isDesktop = !!(window as any).require;

// Runs a git command in the given directory and returns stdout as a string.
// Returns empty string on any error (non-git directory, git not installed, timeout).
// Timeout is set to 8s to handle slow network-mounted drives.
function runGit(args: string, cwd: string): string {
  if (!isDesktop) return "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { execSync } = (window as any).require("child_process");
    return execSync(`git ${args}`, { cwd, timeout: 8000, encoding: "utf8", stdio: ["pipe","pipe","pipe"] });
  } catch {
    return "";
  }
}

function isGitRepo(path: string): boolean {
  const result = runGit("rev-parse --is-inside-work-tree", path);
  return result.trim() === "true";
}

// Recursively scans rootPath for git repositories up to maxDepth levels deep.
// Stops recursing into a folder once a .git directory is found (repos don't nest).
// Hidden folders (starting with ".") are skipped to avoid scanning .git internals.
// maxDepth === 0 means unlimited depth — warn users this can be slow on large drives.
// Uses Node's fs.readdirSync via Electron's require — desktop only.
async function discoverRepos(rootPath: string, maxDepth = 2): Promise<LocalRepo[]> {
  if (!isDesktop) return [];
  const repos: LocalRepo[] = [];
  // maxDepth === 0 means unlimited
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fs = (window as any).require("fs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const path = (window as any).require("path");

    const scanDir = (dir: string, depth: number) => {
      if (maxDepth !== 0 && depth > maxDepth) return;
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      // Check if this dir itself is a repo
      if (entries.includes(".git")) {
        const name = path.basename(dir);
        const lastCommitRaw = runGit(`log -1 --format=%ai`, dir).trim();
        const lastCommit = lastCommitRaw ? lastCommitRaw.split(" ")[0] : null;
        repos.push({ name, path: dir, lastCommit });
        return; // don't recurse into a repo
      }
      // Recurse
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const full = path.join(dir, entry);
        try {
          if (fs.statSync(full).isDirectory()) scanDir(full, depth + 1);
        } catch { /* skip */ }
      }
    };

    scanDir(rootPath, 0);
  } catch (e) {
    console.error("gh-contributions: repo discovery failed", e);
  }
  return repos;
}

// Gets commit dates for a single repo in the given year.
// IMPORTANT: git's --after and --before flags are EXCLUSIVE, so we extend the
// range by one day on each side and then filter to the target year in code.
// This ensures Jan 1 and Dec 31 commits are never accidentally dropped.
function fetchLocalCommits(repo: LocalRepo, year: number): Map<string, number> {
  const map = new Map<string, number>();
  // Widen range by 1 day each side — git's --after/--before are exclusive
  const after  = `${year - 1}-12-31`;
  const before = `${year + 1}-01-01`;
  const raw = runGit(
    `log --after="${after}" --before="${before}" --format=%ad --date=format:%Y-%m-%d`,
    repo.path
  );
  if (!raw) return map;
  for (const line of raw.split("\n")) {
    const date = line.trim();
    if (!date || !date.startsWith(String(year))) continue;
    map.set(date, (map.get(date) ?? 0) + 1);
  }
  return map;
}

// ########################################################################
// Build unified day map
// ########################################################################
// Merges GitHub contribution data and local git commit data into a unified
// Map<dateString, DayData> for the given year. Either source can be disabled
// in settings, in which case only the enabled source is fetched.
// GitHub contributions don't include per-repo breakdown (the API doesn't expose it),
// so githubCount is a single number per day. Local commits do have per-repo data.
async function buildDayMap(
  settings: GitHubContributionsSettings,
  year: number,
  repos: LocalRepo[]
): Promise<{ days: Map<string, DayData>; totalGH: number; totalLocal: number; repoList: LocalRepo[] }> {
  const days = new Map<string, DayData>();

  const getOrCreate = (date: string): DayData => {
    if (!days.has(date)) days.set(date, { date, count: 0, githubCount: 0, localCount: 0, repos: {} });
    return days.get(date)!;
  };

  let totalGH = 0, totalLocal = 0;

  // GitHub
  if (settings.dataSource === "github" || settings.dataSource === "both") {
    if (settings.githubToken && settings.githubUsername) {
      const ghMap = await fetchGitHubContributions(settings.githubUsername, settings.githubToken, year);
      for (const [date, count] of ghMap) {
        const d = getOrCreate(date);
        d.githubCount = count;
        d.count += count;
        totalGH += count;
      }
    }
  }

  // Local
  if (settings.dataSource === "local" || settings.dataSource === "both") {
    for (const repo of repos) {
      const commits = fetchLocalCommits(repo, year);
      for (const [date, count] of commits) {
        const d = getOrCreate(date);
        d.localCount += count;
        d.count += count;
        d.repos[repo.name] = (d.repos[repo.name] ?? 0) + count;
        totalLocal += count;
      }
    }
  }

  return { days, totalGH, totalLocal, repoList: repos };
}

// ########################################################################
// Generate full year week structure
// ########################################################################
// Builds the week-column structure for the year view grid.
// GitHub's contribution graph starts on Sunday — the grid is padded at the start
// with empty cells so the first real day lands in the correct column.
// Returns an array of weeks, each week being 7 DayData items (Sun→Sat).
// Empty padding cells have date:"" and all counts 0.
function buildYearWeeks(year: number, days: Map<string, DayData>): DayData[][] {
  // Pad the start so Jan 1 falls on the correct day-of-week column
  const jan1 = new Date(year, 0, 1);
  const startOffset = jan1.getDay(); // 0=Sun
  const weeks: DayData[][] = [];
  let week: DayData[] = [];

  // Pad start
  for (let i = 0; i < startOffset; i++) week.push({ date: "", count: 0, githubCount: 0, localCount: 0, repos: {} });

  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInYear = isLeap ? 366 : 365;

  for (let i = 0; i < daysInYear; i++) {
    const d = new Date(year, 0, i + 1);
    const dateStr = `${year}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    week.push(days.get(dateStr) ?? { date: dateStr, count: 0, githubCount: 0, localCount: 0, repos: {} });
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push({ date: "", count: 0, githubCount: 0, localCount: 0, repos: {} });
    weeks.push(week);
  }
  return weeks;
}

// Builds the week-row structure for the month view grid.
// Same Sunday-start padding logic as buildYearWeeks, but scoped to one month.
// month is 0-indexed (0 = January, 11 = December).
function buildMonthDays(year: number, month: number, days: Map<string, DayData>): DayData[][] {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks: DayData[][] = [];
  let week: DayData[] = [];

  for (let i = 0; i < firstDay; i++) week.push({ date: "", count: 0, githubCount: 0, localCount: 0, repos: {} });

  for (let i = 1; i <= daysInMonth; i++) {
    const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(i).padStart(2,"0")}`;
    week.push(days.get(dateStr) ?? { date: dateStr, count: 0, githubCount: 0, localCount: 0, repos: {} });
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push({ date: "", count: 0, githubCount: 0, localCount: 0, repos: {} });
    weeks.push(week);
  }
  return weeks;
}

// ########################################################################
// Streaks
// ########################################################################
// Calculates current and longest contribution streaks for the given year.
// Current streak: consecutive active days ending today (or yesterday if today
// has no contributions yet — we don't penalise an in-progress day).
// Longest streak: the longest consecutive run of active days in the year.
function calculateStreaks(days: Map<string, DayData>, year: number): StreakInfo {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInYear = isLeap ? 366 : 365;
  const today = moment().format("YYYY-MM-DD");

  const allDates: string[] = [];
  for (let i = 0; i < daysInYear; i++) {
    const d = new Date(year, 0, i + 1);
    allDates.push(`${year}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);
  }

  let longest = 0, run = 0;
  for (const date of allDates) {
    const count = days.get(date)?.count ?? 0;
    if (count > 0) { run++; if (run > longest) longest = run; }
    else run = 0;
  }

  let current = 0;
  const past = allDates.filter(d => d <= today).reverse();
  let skipFirst = past.length > 0 && (days.get(past[0])?.count ?? 0) === 0;
  for (const date of past) {
    if (skipFirst) { skipFirst = false; continue; }
    if ((days.get(date)?.count ?? 0) > 0) current++;
    else break;
  }
  return { current, longest };
}

// Returns the number of days since the most recent contribution, or null if
// no contributions exist in the loaded data. Only looks at dates up to today.
function daysSinceLastCommit(days: Map<string, DayData>): number | null {
  const today = moment().format("YYYY-MM-DD");
  const sorted = [...days.entries()].filter(([d]) => d <= today && d !== "").sort((a,b) => b[0].localeCompare(a[0]));
  for (const [date, data] of sorted) {
    if (data.count > 0) {
      return moment(today).diff(moment(date), "days");
    }
  }
  return null;
}

// ########################################################################
// Demo mode
// ########################################################################
// Generates realistic fake contribution data for demo mode / screenshots.
// Uses a seeded LCG pseudo-random number generator so the output is always
// the same for a given year — the graph looks consistent across refreshes.
// Activity is weighted toward recent months (recencyBoost) to look natural.
// Data mirrors the real DayData structure exactly: split between GitHub repos
// and local repos, with repo counts guaranteed to sum to the day total.
function buildDemoData(year: number): Map<string, DayData> {
  const days = new Map<string, DayData>();
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInYear = isLeap ? 366 : 365;
  // Seeded LCG — same seed = same graph every time
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };

  // Demo repos split between GitHub and local
  const ghRepos   = ["my-project", "obsidian-plugin"];
  const localRepos = ["dotfiles", "personal-vault"];

  for (let i = 0; i < daysInYear; i++) {
    const d = new Date(year, 0, i + 1);
    const dateStr = `${year}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const recencyBoost = i / daysInYear;
    if (rand() >= (0.45 + recencyBoost * 0.3)) continue;

    // Split total between GitHub and local
    const totalCount = Math.floor(rand() * 10) + 1;
    const ghCount    = Math.floor(rand() * totalCount);
    const localCount = totalCount - ghCount;

    // Distribute GitHub count across gh repos — always sums to ghCount
    const repos: Record<string, number> = {};
    if (ghCount > 0) {
      let rem = ghCount;
      for (let ri = 0; ri < ghRepos.length; ri++) {
        if (rem <= 0) break;
        const n = ri === ghRepos.length - 1 ? rem : Math.min(rem, Math.floor(rand() * rem) + 1);
        if (n > 0 && rand() > 0.3) { repos[ghRepos[ri]] = n; rem -= n; }
      }
      // If any remainder left unassigned, add to first repo
      if (rem > 0) repos[ghRepos[0]] = (repos[ghRepos[0]] ?? 0) + rem;
    }

    // Distribute local count across local repos — always sums to localCount
    if (localCount > 0) {
      let rem = localCount;
      for (let ri = 0; ri < localRepos.length; ri++) {
        if (rem <= 0) break;
        const n = ri === localRepos.length - 1 ? rem : Math.min(rem, Math.floor(rand() * rem) + 1);
        if (n > 0 && rand() > 0.3) { repos[localRepos[ri]] = n; rem -= n; }
      }
      if (rem > 0) repos[localRepos[0]] = (repos[localRepos[0]] ?? 0) + rem;
    }

    // count must always equal githubCount + localCount exactly.
    // repoTotal from repo assignments may differ slightly due to random skips,
    // so we use the authoritative split values for the headline count.
    days.set(dateStr, {
      date: dateStr,
      count: ghCount + localCount,
      githubCount: ghCount,
      localCount,
      repos,
    });
  }
  return days;
}

function mostRecentRepo(repos: LocalRepo[]): string | null {
  if (!repos.length) return null;
  const sorted = [...repos].filter(r => r.lastCommit).sort((a,b) => (b.lastCommit ?? "").localeCompare(a.lastCommit ?? ""));
  return sorted[0]?.name ?? null;
}

// ########################################################################
// View
// ########################################################################
export class ContributionsView extends ItemView {
  plugin: GitHubContributionsPlugin;
  displayYear: number;
  displayMonth: number;
  viewMode: ViewMode;
  tooltipEl: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private panelWidth = 0;

  constructor(leaf: WorkspaceLeaf, plugin: GitHubContributionsPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.displayYear = plugin.settings.selectedYear;
    this.displayMonth = new Date().getMonth();
    this.viewMode = plugin.settings.defaultView;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "GitHub Contributions"; }
  getIcon() { return "github"; }

  async onOpen() {
    // Watch panel width for fit mode
    this.resizeObserver = new ResizeObserver(() => {
      const w = this.containerEl.clientWidth;
      if (Math.abs(w - this.panelWidth) > 5) {
        this.panelWidth = w;
        if (this.plugin.settings.sizePreset === "fit") this.render();
      }
    });
    this.resizeObserver.observe(this.containerEl);
    this.panelWidth = this.containerEl.clientWidth;
    await this.render();
  }

  async onClose() {
    this.tooltipEl?.remove();
    this.tooltipEl = null;
    this.resizeObserver?.disconnect();
  }

  async refresh() {
    this.displayYear = this.plugin.settings.selectedYear;
    this.viewMode = this.plugin.settings.defaultView;
    await this.render();
  }

  private getCellSize(): { cell: number; gap: number } {
    const preset = this.plugin.settings.sizePreset;
    if (preset !== "fit") return PRESET_SIZES[preset];
    // Fit: calculate based on panel width
    // Year view: 53 columns. Month view: 7 columns.
    const cols = this.viewMode === "year" ? 53 : 7;
    const gap = 2;
    // Account for container padding (10px each side) + scrollbar (~8px)
    const available = Math.max(100, (this.panelWidth || 260) - 28);
    const cell = Math.max(5, Math.floor((available - gap * (cols - 1)) / cols));
    return { cell, gap };
  }

  private async render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("gh-contributions-view");

    if (!this.tooltipEl) {
      this.tooltipEl = document.body.createDiv({ cls: "gh-tooltip" });
    }

    const s = this.plugin.settings;
    const needsGH = s.dataSource === "github" || s.dataSource === "both";
    const needsLocal = s.dataSource === "local" || s.dataSource === "both";

    if (needsGH && (!s.githubToken || !s.githubUsername)) {
      this.renderEmpty(container, "github"); return;
    }
    if (needsLocal && !s.localRepoRoot) {
      this.renderEmpty(container, "local"); return;
    }

    this.renderSkeleton(container);

    try {
      // Discover repos if needed
      let repos: LocalRepo[] = [];
      if (needsLocal && s.localRepoRoot) {
        repos = await discoverRepos(s.localRepoRoot, s.scanDepth);
      }

      let days: Map<string, DayData>;
      let totalGH = 0, totalLocal = 0;

      if (s.demoMode) {
        days = buildDemoData(this.displayYear);
        totalGH = [...days.values()].reduce((a, d) => a + d.githubCount, 0);
      } else {
        const result = await buildDayMap(s, this.displayYear, repos);
        days = result.days; totalGH = result.totalGH; totalLocal = result.totalLocal;
      }

      container.empty();

      const streaks = calculateStreaks(days, this.displayYear);
      const sinceCommit = daysSinceLastCommit(days);
      const recentRepo = s.demoMode ? "my-project" : mostRecentRepo(repos);

      this.renderHeader(container);
      this.renderStats(container, { totalGH, totalLocal, streaks, sinceCommit, recentRepo });

      // Repo name line (default style only — compact shows it inline)
      const style = this.plugin.settings.statsStyle ?? "default";
      if (recentRepo && style === "default") {
        const repoLine = container.createDiv({ cls: "gh-repo-line" });
        repoLine.createEl("span", { cls: "gh-repo-line-icon", text: "📁 " });
        repoLine.createEl("span", { cls: "gh-repo-line-name", text: recentRepo });
      }

      if (this.viewMode === "year") {
        const weeks = buildYearWeeks(this.displayYear, days);
        this.renderYearGrid(container, weeks);
      } else {
        const weeks = buildMonthDays(this.displayYear, this.displayMonth, days);
        this.renderMonthGrid(container, weeks);
      }

      if (this.plugin.settings.showLegend) this.renderLegend(container);
    } catch (e) {
      container.empty();
      this.renderError(container, (e as Error).message);
    }
  }

  private renderHeader(container: HTMLElement) {
    const s = this.plugin.settings;
    const header = container.createDiv({ cls: "gh-header" });

    // Left: username
    if (s.githubUsername) header.createEl("span", { cls: "gh-username", text: s.githubUsername });

    // Right: nav only
    const nav = header.createDiv({ cls: "gh-nav" });
    const currentYear = new Date().getFullYear();

    if (this.viewMode === "year") {
      const prev = nav.createEl("button", { cls: "gh-nav-btn", text: "‹" });
      nav.createEl("span", { cls: "gh-nav-label", text: String(this.displayYear) });
      const next = nav.createEl("button", { cls: "gh-nav-btn", text: "›" });
      next.disabled = this.displayYear >= currentYear;
      prev.onclick = async () => { this.displayYear--; await this.render(); };
      next.onclick = async () => { if (this.displayYear < currentYear) { this.displayYear++; await this.render(); } };
    } else {
      const prev = nav.createEl("button", { cls: "gh-nav-btn", text: "‹" });
      nav.createEl("span", { cls: "gh-nav-label", text: `${MONTHS_SHORT[this.displayMonth]} ${this.displayYear}` });
      const next = nav.createEl("button", { cls: "gh-nav-btn", text: "›" });
      const isLatest = this.displayYear >= currentYear && this.displayMonth >= new Date().getMonth();
      next.disabled = isLatest;
      prev.onclick = async () => {
        if (this.displayMonth === 0) { this.displayMonth = 11; this.displayYear--; }
        else this.displayMonth--;
        await this.render();
      };
      next.onclick = async () => {
        if (isLatest) return;
        if (this.displayMonth === 11) { this.displayMonth = 0; this.displayYear++; }
        else this.displayMonth++;
        await this.render();
      };
    }

    // Refresh icon button at end of nav row
    const refreshBtn = nav.createEl("button", { cls: "gh-nav-btn gh-refresh-icon", text: "↻" });
    refreshBtn.title = "Refresh";
    refreshBtn.onclick = () => this.render();
  }

  private renderStats(container: HTMLElement, info: {
    totalGH: number; totalLocal: number; streaks: StreakInfo;
    sinceCommit: number | null; recentRepo: string | null;
  }) {
    const s = this.plugin.settings;
    const style = s.statsStyle ?? "default";
    const total = info.totalGH + info.totalLocal;
    const showLocal = s.dataSource === "local" || s.dataSource === "both";

    if (style === "compact") {
      // Single row, icon + number, no labels
      const row = container.createDiv({ cls: "gh-stats-compact" });
      const items: [string, string, string][] = [
        ["↑", String(total), "Total contributions"],
        ["🔥", info.streaks.current + "d", "Current streak"],
        ["⭐", info.streaks.longest + "d", "Best streak"],
      ];
      if (showLocal && info.sinceCommit !== null) {
        const sinceLabel = info.sinceCommit === 0 ? "committed today" : info.sinceCommit + "d ago";
        items.push(["⏱", info.sinceCommit === 0 ? "today" : info.sinceCommit + "d", sinceLabel]);
      }
      if (info.recentRepo)
        items.push(["📁", info.recentRepo, info.recentRepo]);
      for (const [icon, val, title] of items) {
        const chip = row.createEl("span", { cls: "gh-chip", title });
        chip.createEl("span", { cls: "gh-chip-icon", text: icon });
        chip.createEl("span", { cls: "gh-chip-val", text: val });
      }
    } else if (style === "grid") {
      const stats = container.createDiv({ cls: "gh-stats gh-stats--grid" });
      this.pill(stats, String(total), "contributions");
      this.pill(stats, info.streaks.current + "d", "streak");
      this.pill(stats, info.streaks.longest + "d", "best");
      if (showLocal && info.sinceCommit !== null)
        this.pill(stats, info.sinceCommit === 0 ? "today" : info.sinceCommit + "d ago", info.sinceCommit === 0 ? "committed" : "since commit");
      if (info.recentRepo) {
        const maxLen = 16;
        const name = info.recentRepo.length > maxLen ? info.recentRepo.slice(0, maxLen-1) + "\u2026" : info.recentRepo;
        const pill = stats.createDiv({ cls: "gh-stat gh-stat--wide" });
        pill.title = info.recentRepo;
        pill.createEl("span", { cls: "gh-stat-val", text: name });
        pill.createEl("span", { cls: "gh-stat-lbl", text: "recent repo" });
      }
    } else {
      // Default: tight vertical list with icons
      const list = container.createDiv({ cls: "gh-stats-list" });
      const items: [string, string, string][] = [
        ["↑", String(total), "contributions"],
        ["🔥", info.streaks.current + "d", "streak"],
        ["⭐", info.streaks.longest + "d", "best"],
      ];
      if (showLocal && info.sinceCommit !== null) {
        const val = info.sinceCommit === 0 ? "today" : info.sinceCommit + "d ago";
        const lbl = info.sinceCommit === 0 ? "committed today" : "since commit";
        items.push(["⏱", val, lbl]);
      }
      for (const [icon, val, label] of items) {
        const row = list.createDiv({ cls: "gh-stats-list-row" });
        row.createEl("span", { cls: "gh-stats-list-icon", text: icon });
        row.createEl("span", { cls: "gh-stats-list-val", text: val });
        row.createEl("span", { cls: "gh-stats-list-lbl", text: " " + label });
      }
    }
  }

  private pill(parent: HTMLElement, value: string, label: string) {
    const p = parent.createDiv({ cls: "gh-stat" });
    p.createEl("span", { cls: "gh-stat-val", text: value });
    p.createEl("span", { cls: "gh-stat-lbl", text: label });
  }

  private renderYearGrid(container: HTMLElement, weeks: DayData[][]) {
    const { cell, gap } = this.getCellSize();
    const graphWrap = container.createDiv({ cls: "gh-graph-wrap" });
    graphWrap.style.overflowX = "auto";

    // Month labels
    const monthRow = graphWrap.createDiv({ cls: "gh-month-row" });
    monthRow.style.cssText = `display:grid;grid-template-columns:repeat(${weeks.length},${cell}px);gap:${gap}px;margin-bottom:3px`;

    let lastMonth = -1;
    weeks.forEach((week, wi) => {
      const first = week.find(d => d.date);
      if (!first) return;
      const m = new Date(first.date).getUTCMonth();
      if (m !== lastMonth) {
        lastMonth = m;
        const lbl = monthRow.createEl("span", { cls: "gh-month-lbl", text: MONTHS_SHORT[m] });
        lbl.style.gridColumn = String(wi + 1);
        lbl.style.fontSize = Math.max(8, cell - 2) + "px";
      }
    });

    // Grid
    const grid = graphWrap.createDiv({ cls: "gh-grid" });
    grid.style.cssText = `display:flex;gap:${gap}px`;
    weeks.forEach(week => {
      const col = grid.createDiv({ cls: "gh-col" });
      col.style.cssText = `display:flex;flex-direction:column;gap:${gap}px`;
      week.forEach(day => this.renderCell(col, day, cell));
    });
  }

  private renderMonthGrid(container: HTMLElement, weeks: DayData[][]) {
    const { cell, gap } = this.getCellSize();
    const graphWrap = container.createDiv({ cls: "gh-graph-wrap" });
    const colTemplate = `repeat(7,${cell}px)`;

    // Day-of-week headers - use same grid columns as cells so they align
    const dowRow = graphWrap.createDiv({ cls: "gh-dow-row" });
    dowRow.style.cssText = `display:grid;grid-template-columns:${colTemplate};gap:${gap}px;margin-bottom:4px`;
    ["Su","Mo","Tu","We","Th","Fr","Sa"].forEach(d => {
      const lbl = dowRow.createEl("span", { cls: "gh-dow-lbl", text: d });
      lbl.style.cssText = `font-size:10px;color:var(--text-faint);text-align:center;overflow:hidden`;
    });

    // Grid - rows are weeks, also grid for perfect alignment
    const grid = graphWrap.createDiv({ cls: "gh-month-grid" });
    grid.style.cssText = `display:flex;flex-direction:column;gap:${gap}px`;
    weeks.forEach(week => {
      const row = grid.createDiv({ cls: "gh-month-row-cells" });
      row.style.cssText = `display:grid;grid-template-columns:${colTemplate};gap:${gap}px`;
      week.forEach(day => this.renderCell(row, day, cell));
    });
  }

  private renderCell(parent: HTMLElement, day: DayData, size: number) {
    const cell = parent.createDiv({ cls: "gh-cell" });
    cell.style.cssText = `width:${size}px;height:${size}px`;

    if (!day.date) {
      cell.addClass("gh-cell--empty");
      return;
    }

    const today = moment().format("YYYY-MM-DD");
    cell.dataset.level = String(countToLevel(day.count));
    if (day.date === today) cell.addClass("gh-today");

    cell.addEventListener("mouseenter", (e: MouseEvent) => this.showTooltip(e, day));
    cell.addEventListener("mouseleave", () => { if (this.tooltipEl) this.tooltipEl.style.display = "none"; });
    cell.addEventListener("click", () => this.openOrCreateDailyNote(day.date));
  }

  private showTooltip(e: MouseEvent, day: DayData) {
    if (!this.tooltipEl) return;
    const s = this.plugin.settings;
    const showSources = s.dataSource === "both" || s.demoMode;
    const repoEntries = Object.entries(day.repos).sort((a, b) => b[1] - a[1]);

    this.tooltipEl.empty();
    this.tooltipEl.removeClass("gh-tooltip--console", "gh-tooltip--modern");

    if (s.tooltipStyle === "simple") {
      this.renderSimpleTooltip(day, showSources);
    } else {
      this.renderStandardTooltip(day, showSources, repoEntries);
    }

    // Measure then position — render hidden first to get real dimensions
    this.tooltipEl.style.display = "block";
    this.tooltipEl.style.visibility = "hidden";

    const tooltipWidth  = this.tooltipEl.offsetWidth  || 180;
    const tooltipHeight = this.tooltipEl.offsetHeight || 80;

    const spaceOnRight = window.innerWidth - e.pageX;
    const left = spaceOnRight < tooltipWidth + 20
      ? e.pageX - tooltipWidth - 12
      : e.pageX + 12;

    const spaceBelow = window.innerHeight - e.pageY;
    const top = spaceBelow < tooltipHeight + 20
      ? e.pageY - tooltipHeight - 8
      : e.pageY - 34;

    this.tooltipEl.style.left       = left + "px";
    this.tooltipEl.style.top        = top  + "px";
    this.tooltipEl.style.visibility = "visible";
  }

  private renderSimpleTooltip(day: DayData, showSources: boolean) {
    const t = this.tooltipEl!;
    t.addClass("gh-tooltip--modern");

    t.createEl("div", { cls: "gh-tip-date", text: moment(day.date).format("MMM D, YYYY") });

    if (day.count === 0) {
      t.createEl("div", { cls: "gh-tip-no-contrib", text: "No contributions" });
      return;
    }

    const countRow = t.createDiv({ cls: "gh-tip-count-row" });
    countRow.createEl("span", { cls: "gh-tip-count", text: String(day.count) });
    countRow.createEl("span", { cls: "gh-tip-count-lbl", text: ` contribution${day.count !== 1 ? "s" : ""}` });

    if (showSources && (day.githubCount > 0 || day.localCount > 0)) {
      const sources = t.createDiv({ cls: "gh-tip-sources" });
      if (day.githubCount > 0) {
        const row = sources.createDiv({ cls: "gh-tip-source-row" });
        const ghIco = row.createEl("span", { cls: "gh-tip-source-icon" });
        ghIco.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>`;
        row.createEl("span", { cls: "gh-tip-source-lbl", text: "GitHub" });
        row.createEl("span", { cls: "gh-tip-source-val", text: String(day.githubCount) });
      }
      if (day.localCount > 0) {
        const row = sources.createDiv({ cls: "gh-tip-source-row" });
        const localIco = row.createEl("span", { cls: "gh-tip-source-icon" });
        localIco.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="12" x="3" y="4" rx="2" ry="2"/><line x1="2" x2="22" y1="20" y2="20"/></svg>`;
        row.createEl("span", { cls: "gh-tip-source-lbl", text: "Local" });
        row.createEl("span", { cls: "gh-tip-source-val", text: String(day.localCount) });
      }
    }
  }

  private renderStandardTooltip(day: DayData, showSources: boolean, repoEntries: [string, number][]) {
    const t = this.tooltipEl!;
    t.addClass("gh-tooltip--modern");

    t.createEl("div", { cls: "gh-tip-date", text: moment(day.date).format("MMM D, YYYY") });

    if (day.count === 0) {
      t.createEl("div", { cls: "gh-tip-no-contrib", text: "No contributions" });
        return;
    }

    const countRow = t.createDiv({ cls: "gh-tip-count-row" });
    countRow.createEl("span", { cls: "gh-tip-count", text: String(day.count) });
    countRow.createEl("span", { cls: "gh-tip-count-lbl", text: ` contribution${day.count !== 1 ? "s" : ""}` });

    const ghSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>`;
    const localSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="12" x="3" y="4" rx="2" ry="2"/><line x1="2" x2="22" y1="20" y2="20"/></svg>`;

    if (showSources && (day.githubCount > 0 || day.localCount > 0)) {
      const sources = t.createDiv({ cls: "gh-tip-sources" });
      if (day.githubCount > 0) {
        const row = sources.createDiv({ cls: "gh-tip-source-row" });
        const ico = row.createEl("span", { cls: "gh-tip-source-icon" });
        ico.innerHTML = ghSvg;
        row.createEl("span", { cls: "gh-tip-source-lbl", text: "GitHub" });
        row.createEl("span", { cls: "gh-tip-source-val", text: String(day.githubCount) });
      }
      if (day.localCount > 0) {
        const row = sources.createDiv({ cls: "gh-tip-source-row" });
        const ico = row.createEl("span", { cls: "gh-tip-source-icon" });
        ico.innerHTML = localSvg;
        row.createEl("span", { cls: "gh-tip-source-lbl", text: "Local" });
        row.createEl("span", { cls: "gh-tip-source-val", text: String(day.localCount) });
      }
    }

    if (repoEntries.length > 0) {
      t.createDiv({ cls: "gh-tip-divider" });
      const repoColors = ["#3fb950", "#3b82f6", "#a855f7", "#f59e0b", "#ef4444"];
      repoEntries.forEach(([repo, count], i) => {
        const row = t.createDiv({ cls: "gh-tip-repo-row" });
        const dot = row.createEl("span", { cls: "gh-tip-dot" });
        dot.style.background = repoColors[i % repoColors.length];
        row.createEl("span", { cls: "gh-tip-repo-name", text: repo });
        row.createEl("span", { cls: "gh-tip-repo-count", text: `(${count})` });
      });
    }

  }

  private renderLegend(container: HTMLElement) {
    const { cell, gap } = this.getCellSize();
    const legend = container.createDiv({ cls: "gh-legend" });
    legend.createEl("span", { cls: "gh-legend-lbl", text: "Less" });
    for (let i = 0; i <= 4; i++) {
      const sq = legend.createDiv({ cls: "gh-cell gh-legend-cell" });
      sq.dataset.level = String(i);
      sq.style.cssText = `width:${cell}px;height:${cell}px`;
    }
    legend.createEl("span", { cls: "gh-legend-lbl", text: "More" });
  }

  private renderEmpty(container: HTMLElement, missing: "github" | "local") {
    const wrap = container.createDiv({ cls: "gh-empty" });
    wrap.createEl("div", { cls: "gh-empty-icon", text: "🐙" });
    const msg = missing === "github"
      ? "Connect your GitHub account in Settings to see your contribution graph."
      : "Set a local repo root folder in Settings to scan for git commits.";
    wrap.createEl("p", { text: msg });
    const btn = wrap.createEl("button", { cls: "gh-btn", text: "Open Settings" });
    btn.onclick = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.app as any).setting.open();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.app as any).setting.openTabById("github-contributions");
    };
  }

  private renderSkeleton(container: HTMLElement) {
    const wrap = container.createDiv({ cls: "gh-skeleton-wrap" });
    wrap.createDiv({ cls: "gh-skeleton gh-skeleton-header" });
    wrap.createDiv({ cls: "gh-skeleton gh-skeleton-stats" });
    const grid = wrap.createDiv({ cls: "gh-skeleton-grid" });
    const cols = this.viewMode === "year" ? 53 : 7;
    const rows = this.viewMode === "year" ? 7 : 6;
    const { cell, gap } = this.getCellSize();
    grid.style.cssText = `display:grid;grid-template-columns:repeat(${cols},${cell}px);grid-template-rows:repeat(${rows},${cell}px);gap:${gap}px`;
    for (let i = 0; i < cols * rows; i++) grid.createDiv({ cls: "gh-skeleton gh-skeleton-cell" });
  }

  private renderError(container: HTMLElement, msg: string) {
    container.createDiv({ cls: "gh-error", text: `⚠ ${msg}` });
  }

  private async openOrCreateDailyNote(date: string) {
    const s = this.plugin.settings;
    const fmt = s.dailyNoteDateFormat || "YYYY-MM-DD";
    const folder = s.dailyNoteFolder ? s.dailyNoteFolder.replace(/\/$/, "") + "/" : "";
    const name = moment(date).format(fmt);
    const filePath = `${folder}${name}.md`;

    let file = this.app.vault.getAbstractFileByPath(filePath) as TFile | null;
    if (!file) {
      try {
        file = await this.app.vault.create(filePath, `# ${name}\n\n`);
        new Notice(`Created: ${name}`);
      } catch (err) {
        new Notice(`Error creating note: ${(err as Error).message}`);
        return;
      }
    }
    await this.app.workspace.getLeaf(false).openFile(file as TFile);
  }
}

// ########################################################################
// Helpers
// ########################################################################
// Maps a contribution count to a colour level 0–4.
// These thresholds roughly mirror GitHub's own contribution graph levels.
// Level 0 = empty, level 4 = most active. Adjust thresholds here to change
// how aggressively the graph colours — useful if your commit volume is very
// high or very low compared to the defaults.
function countToLevel(n: number): number {
  if (n === 0) return 0;
  if (n <= 2) return 1;
  if (n <= 5) return 2;
  if (n <= 9) return 3;
  return 4;
}

// ########################################################################
// Settings Tab
// ########################################################################
class GitHubContributionsSettingTab extends PluginSettingTab {
  plugin: GitHubContributionsPlugin;
  constructor(app: App, plugin: GitHubContributionsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "GitHub Contributions" });

    // ── Data Sources
    containerEl.createEl("h3", { text: "Data Sources" });

    new Setting(containerEl)
      .setName("Source")
      .setDesc("Which contributions to display")
      .addDropdown(d => d
        .addOption("github", "GitHub only")
        .addOption("local", "Local git only")
        .addOption("both", "Both")
        .setValue(this.plugin.settings.dataSource)
        .onChange(async (v) => { this.plugin.settings.dataSource = v as DataSource; await this.plugin.saveSettings(); this.display(); })
      );

    const src = this.plugin.settings.dataSource;

    if (src === "github" || src === "both") {
      // Auth method toggle
      new Setting(containerEl)
        .setName("Authentication")
        .setDesc("Connect GitHub to fetch your contribution data")
        .addDropdown(d => d
          .addOption("oauth", "Connect with GitHub (recommended)")
          .addOption("pat",   "Personal Access Token (advanced)")
          .setValue(this.plugin.settings.authMethod)
          .onChange(async v => {
            this.plugin.settings.authMethod = v as "oauth" | "pat";
            await this.plugin.saveSettings();
            this.display();
          })
        );

      if (this.plugin.settings.authMethod === "oauth") {
        const isConnected = !!this.plugin.settings.githubToken && !!this.plugin.settings.githubUsername;

        if (isConnected) {
          new Setting(containerEl)
            .setName("Connected as " + this.plugin.settings.githubUsername)
            .setDesc("Your GitHub account is connected via OAuth")
            .addButton(btn => btn
              .setButtonText("Disconnect")
              .setWarning()
              .onClick(async () => {
                this.plugin.settings.githubToken = "";
                this.plugin.settings.githubUsername = "";
                await this.plugin.saveSettings();
                this.display();
              })
            );
        } else {
          // OAuth connect button + status area
          let cancelled = false;
          const oauthSetting = new Setting(containerEl)
            .setName("Connect GitHub account")
            .setDesc("Click to start the authorization flow");

          oauthSetting.addButton(btn => btn
            .setButtonText("Connect GitHub")
            .setCta()
            .onClick(async () => {
              btn.setButtonText("Connecting...").setDisabled(true);
              cancelled = false;
              try {
                const device = await requestDeviceCode();

                // Show the user code prominently
                const expiryMins = Math.floor(device.expires_in / 60);
                oauthSetting.setDesc(
                  createFragment(f => {
                    f.appendText("Enter this code at ");
                    f.createEl("strong", { text: "github.com/login/device" });
                    f.createEl("br");
                    f.createEl("span", { cls: "gh-oauth-code", text: device.user_code });
                    f.createEl("br");
                    f.createEl("em", { text: `Waiting for approval… (code expires in ${expiryMins} minutes)` });
                  })
                );

                // Open browser
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (window as any).open(device.verification_uri);

                // Poll for token
                const token = await pollForToken(device.device_code, device.interval, device.expires_in, () => cancelled);
                const username = await fetchGitHubUsername(token);

                this.plugin.settings.githubToken = token;
                this.plugin.settings.githubUsername = username;
                await this.plugin.saveSettings();
                new Notice("Connected to GitHub as " + username);
                this.display();
              } catch (e) {
                const msg = (e as Error).message;
                if (msg === "Cancelled") {
                  oauthSetting.setDesc("Connection cancelled. Click Connect GitHub to try again.");
                } else {
                  oauthSetting.setDesc("⚠ " + msg);
                  new Notice("GitHub connection failed: " + msg);
                }
                btn.setButtonText("Connect GitHub").setDisabled(false);
              }
            })
          );

          oauthSetting.addButton(btn => btn
            .setButtonText("Cancel")
            .onClick(() => { cancelled = true; oauthSetting.setDesc("Cancelled."); btn.setDisabled(true); })
          );
        }
      } else {
        // PAT mode
        new Setting(containerEl)
          .setName("GitHub username")
          .addText(t => t.setPlaceholder("username").setValue(this.plugin.settings.githubUsername)
            .onChange(async v => { this.plugin.settings.githubUsername = v.trim(); await this.plugin.saveSettings(); }));

        new Setting(containerEl)
          .setName("Personal Access Token")
          .setDesc("PAT with read:user scope — github.com/settings/tokens")
          .addText(t => {
            t.inputEl.type = "password";
            t.setPlaceholder("ghp_…").setValue(this.plugin.settings.githubToken)
              .onChange(async v => { this.plugin.settings.githubToken = v.trim(); await this.plugin.saveSettings(); });
          });
      }
    }

    if (src === "local" || src === "both") {
      if (!isDesktop) {
        containerEl.createEl("p", { cls: "gh-settings-notice", text: "⚠ Local git scanning is not available on mobile." });
      } else {
        new Setting(containerEl)
          .setName("Local repo root")
          .setDesc("Folder to scan for git repositories")
          .addText(t => {
            t.setPlaceholder("C:\\Users\\You\\Projects").setValue(this.plugin.settings.localRepoRoot);
            // Store value in memory as user types but don't save/scan yet
            t.onChange(v => { this.plugin.settings.localRepoRoot = v.trim(); });
          })
          .addButton(btn => btn
            .setButtonText("Scan")
            .setTooltip("Save path and scan for repositories")
            .onClick(async () => {
              btn.setButtonText("Scanning…").setDisabled(true);
              await this.plugin.saveSettings();
              btn.setButtonText("Scan").setDisabled(false);
              new Notice("Repo scan complete — refresh the panel to see results");
            })
          );

        new Setting(containerEl)
          .setName("Scan depth")
          .setDesc("How many folder levels deep to search for git repos")
          .addDropdown(d => d
            .addOption("2", "2 levels")
            .addOption("3", "3 levels")
            .addOption("4", "4 levels")
            .addOption("5", "5 levels")
            .addOption("0", "Unlimited (slow on large drives)")
            .setValue(String(this.plugin.settings.scanDepth))
            .onChange(async v => { this.plugin.settings.scanDepth = parseInt(v); await this.plugin.saveSettings(); })
          );
      }
    }

    // ── Display
    containerEl.createEl("h3", { text: "Display" });

    new Setting(containerEl)
      .setName("Sidebar side")
      .addDropdown(d => d.addOption("left","Left").addOption("right","Right")
        .setValue(this.plugin.settings.sidebarSide)
        .onChange(async v => { this.plugin.settings.sidebarSide = v as "left"|"right"; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Stats display")
      .setDesc("How the stats bar is shown")
      .addDropdown(d => d
        .addOption("default", "Default (pills with labels)")
        .addOption("compact", "Compact (icons + numbers)")
        .addOption("grid",    "Grid (2-column)")
        .setValue(this.plugin.settings.statsStyle)
        .onChange(async v => { this.plugin.settings.statsStyle = v as StatsStyle; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Colour palette")
      .setDesc("Colour scheme for contribution cells")
      .addDropdown(d => d
        .addOption("classic",       "Classic (GitHub greens)")
        .addOption("high-contrast", "High contrast (vivid greens)")
        .addOption("cobalt",        "Cobalt (blue to cyan)")
        .addOption("neon",          "Neon (purple to yellow)")
        .addOption("ember",         "Ember (amber to gold)")
        .setValue(this.plugin.settings.palette)
        .onChange(async v => { this.plugin.settings.palette = v as Palette; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Size")
      .setDesc("Cell size. \"Fit to sidebar\" auto-sizes to fill the panel width.")
      .addDropdown(d => d
        .addOption("ultra-compact", "Ultra compact")
        .addOption("compact", "Compact")
        .addOption("medium", "Medium")
        .addOption("large", "Large")
        .addOption("fit", "Fit to sidebar")
        .setValue(this.plugin.settings.sizePreset)
        .onChange(async v => { this.plugin.settings.sizePreset = v as SizePreset; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Default view")
      .addDropdown(d => d.addOption("year","Year").addOption("month","Month")
        .setValue(this.plugin.settings.defaultView)
        .onChange(async v => { this.plugin.settings.defaultView = v as ViewMode; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Default year")
      .addText(t => t.setPlaceholder(String(new Date().getFullYear()))
        .setValue(String(this.plugin.settings.selectedYear))
        .onChange(async v => {
          const y = parseInt(v);
          if (!isNaN(y) && y >= 2008 && y <= new Date().getFullYear()) {
            this.plugin.settings.selectedYear = y; await this.plugin.saveSettings();
          }
        }));

    // ── Daily Notes
    new Setting(containerEl)
      .setName("Tooltip style")
      .setDesc("Console — compact monospace. Modern — larger, with colored repo markers.")
      .addDropdown(d => d
        .addOption("standard", "Standard (with repos)")
        .addOption("simple",   "Simple (no repos)")
        .setValue(this.plugin.settings.tooltipStyle)
        .onChange(async v => { this.plugin.settings.tooltipStyle = v as TooltipStyle; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Demo mode")
      .setDesc("Show fake contribution data — useful for screenshots or testing")
      .addToggle(t => t.setValue(this.plugin.settings.demoMode)
        .onChange(async v => { this.plugin.settings.demoMode = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Show legend")
      .setDesc("Show the Less / More colour legend below the graph")
      .addToggle(t => t.setValue(this.plugin.settings.showLegend)
        .onChange(async v => { this.plugin.settings.showLegend = v; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "Daily Notes" });

    new Setting(containerEl)
      .setName("Daily notes folder")
      .setDesc("Leave blank for vault root")
      .addText(t => {
        t.setPlaceholder("Daily Notes/").setValue(this.plugin.settings.dailyNoteFolder);
        t.onChange(debounce(async (v: unknown) => { this.plugin.settings.dailyNoteFolder = v as string; await this.plugin.saveSettings(); }, 800));
      });

    new Setting(containerEl)
      .setName("Date format")
      .setDesc("Moment.js format for filenames. Default: YYYY-MM-DD")
      .addText(t => {
        t.setPlaceholder("YYYY-MM-DD").setValue(this.plugin.settings.dailyNoteDateFormat);
        t.onChange(debounce(async (v: unknown) => { this.plugin.settings.dailyNoteDateFormat = v as string; await this.plugin.saveSettings(); }, 800));
      });
  }
}

// ########################################################################
// Plugin
// ########################################################################
export default class GitHubContributionsPlugin extends Plugin {
  settings: GitHubContributionsSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new GitHubContributionsSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new ContributionsView(leaf, this));
    this.addRibbonIcon("github", "GitHub Contributions", () => this.activateView());
    this.addCommand({ id: "open-github-contributions", name: "Open GitHub Contributions panel", callback: () => this.activateView() });
    this.injectStyles();
    this.injectPaletteStyles();
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    document.getElementById("gh-contributions-styles")?.remove();
    document.getElementById("gh-palette-styles")?.remove();
    document.querySelectorAll(".gh-tooltip").forEach(el => el.remove());
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) { this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.settings.sidebarSide === "left"
      ? this.app.workspace.getLeftLeaf(false)
      : this.app.workspace.getRightLeaf(false);
    if (leaf) { await leaf.setViewState({ type: VIEW_TYPE, active: true }); this.app.workspace.revealLeaf(leaf); }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (this.settings.selectedYear > new Date().getFullYear()) this.settings.selectedYear = new Date().getFullYear();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.injectPaletteStyles();
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => {
      if (leaf.view instanceof ContributionsView) leaf.view.refresh();
    });
  }

  injectPaletteStyles() {
    const existing = document.getElementById("gh-palette-styles");
    if (existing) existing.remove();
    const p = PALETTES[this.settings.palette] ?? PALETTES["classic"];
    const style = document.createElement("style");
    style.id = "gh-palette-styles";
    // Use body instead of :root for reliability in Obsidian's DOM
    style.textContent = `
body{--gh-c0:${p.dark[0]};--gh-c1:${p.dark[1]};--gh-c2:${p.dark[2]};--gh-c3:${p.dark[3]};--gh-c4:${p.dark[4]}}
body.theme-light{--gh-c0:${p.light[0]};--gh-c1:${p.light[1]};--gh-c2:${p.light[2]};--gh-c3:${p.light[3]};--gh-c4:${p.light[4]}}
    `;
    document.head.appendChild(style);
  }

  private injectStyles() {
    if (document.getElementById("gh-contributions-styles")) return;
    const style = document.createElement("style");
    style.id = "gh-contributions-styles";
    style.textContent = `
.gh-contributions-view{padding:12px 10px 16px;overflow-y:auto;overflow-x:hidden;user-select:none}
.gh-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:6px}
.gh-username{font-size:13px;font-weight:600;color:var(--text-normal);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.gh-nav{display:flex;align-items:center;gap:3px;flex-shrink:0}
.gh-nav-label{font-size:12px;color:var(--text-muted);min-width:52px;text-align:center;white-space:nowrap}
.gh-nav-btn{background:none;border:1px solid var(--background-modifier-border);border-radius:4px;color:var(--text-muted);cursor:pointer;font-size:14px;line-height:1;padding:1px 6px;transition:background .15s}
.gh-nav-btn:hover:not(:disabled){background:var(--background-modifier-hover);color:var(--text-normal)}
.gh-nav-btn:disabled{opacity:.3;cursor:default}
.gh-stats{display:flex;gap:5px;margin-bottom:10px;flex-wrap:wrap}
.gh-stats--grid{display:grid!important;grid-template-columns:1fr 1fr}
.gh-stat{display:flex;flex-direction:column;align-items:center;background:var(--background-secondary);border-radius:6px;padding:5px 7px;flex:1;min-width:0}
.gh-stats--grid .gh-stat{flex:unset}
.gh-stat--wide{grid-column:1 / -1}
.gh-stat-val{font-size:13px;font-weight:700;color:var(--interactive-accent);line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.gh-stat-lbl{font-size:9px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.04em;margin-top:2px;text-align:center}
.gh-stats-compact{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;align-items:center}
.gh-chip{display:inline-flex;align-items:center;gap:3px;background:var(--background-secondary);border-radius:4px;padding:3px 6px;font-size:11px;white-space:nowrap}
.gh-chip-icon{font-size:10px}
.gh-chip-val{font-weight:700;color:var(--interactive-accent)}
.gh-stats-list{display:flex;flex-direction:column;gap:1px;margin-bottom:8px}
.gh-stats-list-row{display:flex;align-items:baseline;gap:4px;font-size:11px;line-height:1.6}
.gh-stats-list-icon{font-size:10px;width:14px;text-align:center;flex-shrink:0}
.gh-stats-list-val{font-weight:700;color:var(--interactive-accent);font-size:12px}
.gh-stats-list-lbl{color:var(--text-muted);font-size:11px}
.gh-oauth-code{display:inline-block;font-size:22px;font-weight:700;letter-spacing:4px;color:var(--interactive-accent);font-family:var(--font-monospace);margin:6px 0;padding:4px 8px;background:var(--background-secondary);border-radius:6px}
.gh-repo-line{margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid var(--background-modifier-border)}
.gh-repo-line-icon{font-size:10px;color:var(--text-faint)}
.gh-repo-line-name{font-size:11px;color:var(--text-muted)}
.gh-graph-wrap{overflow-x:auto;padding-bottom:4px}
.gh-month-lbl{font-size:9px;color:var(--text-faint)}
.gh-cell{border-radius:2px;cursor:pointer;transition:transform .1s;flex-shrink:0;box-sizing:border-box}
.gh-cell:hover{transform:scale(1.3);z-index:1;position:relative}
.gh-cell--empty{background:transparent!important;cursor:default!important}
.gh-cell--empty:hover{transform:none!important}
.gh-today{outline:2px solid var(--interactive-accent)!important;outline-offset:1px}
.gh-cell[data-level="0"]{background:var(--gh-c0)}
.gh-cell[data-level="1"]{background:var(--gh-c1)}
.gh-cell[data-level="2"]{background:var(--gh-c2)}
.gh-cell[data-level="3"]{background:var(--gh-c3)}
.gh-cell[data-level="4"]{background:var(--gh-c4)}
.gh-legend{display:flex;align-items:center;gap:3px;margin-top:8px;justify-content:flex-end}
.gh-legend-lbl{font-size:9px;color:var(--text-faint)}
.gh-legend-cell{cursor:default!important}
.gh-legend-cell:hover{transform:none!important}
.gh-refresh-icon{margin-left:2px;font-size:13px!important}
.gh-empty{display:flex;flex-direction:column;align-items:center;padding:24px 12px;text-align:center;gap:10px}
.gh-empty-icon{font-size:32px}
.gh-empty p{font-size:12px;color:var(--text-muted);line-height:1.5;margin:0}
.gh-btn{background:var(--interactive-accent);border:none;border-radius:6px;color:var(--text-on-accent);cursor:pointer;font-size:12px;padding:6px 14px}
.gh-btn:hover{filter:brightness(1.1)}
.gh-error{padding:10px 12px;background:var(--background-modifier-error);border-radius:6px;color:var(--text-error);font-size:12px;margin:8px 0}
.gh-skeleton-wrap{padding:4px 0}
.gh-skeleton-header{height:14px;width:55%;margin-bottom:10px;border-radius:4px}
.gh-skeleton-stats{height:44px;width:100%;margin-bottom:10px;border-radius:6px}
.gh-skeleton-cell{border-radius:2px}
.gh-skeleton{animation:gh-shimmer 1.4s infinite linear;background:linear-gradient(90deg,var(--background-modifier-border) 25%,var(--background-secondary) 50%,var(--background-modifier-border) 75%);background-size:200% 100%}
@keyframes gh-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.gh-tooltip{position:fixed;background:#1a1a1a;color:#eee;border-radius:6px;padding:7px 10px;font-size:11px;line-height:1.6;pointer-events:none;display:none;z-index:9999;white-space:pre;box-shadow:0 2px 10px rgba(0,0,0,.35);font-family:var(--font-monospace)}
.gh-tooltip strong{color:#fff;display:block;margin-bottom:2px;font-family:var(--font-interface)}
.theme-light .gh-tooltip{background:#222}
/* Console tooltip */
.gh-tooltip--console{background:#161b22;border:1px solid rgba(255,255,255,0.18);border-radius:8px;padding:10px 13px;font-family:var(--font-monospace);min-width:180px;white-space:normal;box-shadow:0 0 0 1px rgba(255,255,255,0.06),0 8px 24px rgba(0,0,0,.4)}
.gh-con-date{font-size:11px;font-weight:600;color:#3fb950;margin-bottom:4px}
.gh-con-dash{border-top:1px dashed rgba(255,255,255,0.15);margin:6px 0}
.gh-con-count-row{display:flex;align-items:baseline;gap:4px;margin-bottom:5px}
.gh-con-count{font-size:15px;font-weight:700;color:#3fb950}
.gh-con-count-lbl{font-size:11px;color:#8b949e}
.gh-con-source-row{display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:3px}
.gh-con-source-icon{color:#8b949e;width:14px;display:flex;align-items:center;flex-shrink:0}
.gh-con-source-icon svg{display:block}
.gh-con-source-lbl{color:#cdd9e5;flex:1}
.gh-con-source-val{color:#fff;font-weight:700;min-width:16px;text-align:right}
.gh-con-repo-row{display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:3px}
.gh-con-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.gh-con-repo-name{color:#8b949e;flex:1}
.gh-con-repo-count{color:#8b949e;font-size:10px}
.gh-con-hint{font-size:9px;color:#484f58;margin-top:6px;font-style:italic}
.gh-con-no-contrib{font-size:12px;color:#8b949e}
.gh-tooltip--modern{white-space:normal;padding:12px 14px;border-radius:10px;background:#161b22;border:1px solid rgba(255,255,255,0.12);box-shadow:0 8px 32px rgba(0,0,0,.6);min-width:190px;font-family:var(--font-interface)}
.theme-light .gh-tooltip--modern{background:#1c2128;border-color:rgba(255,255,255,0.15)}
/* Date */
.gh-tip-date{font-size:13px;font-weight:600;color:#fff;margin-bottom:6px}
/* Count row */
.gh-tip-count-row{display:flex;align-items:baseline;gap:4px;margin-bottom:10px}
.gh-tip-count{font-size:18px;font-weight:700;color:#3fb950}
.gh-tip-count-lbl{font-size:13px;color:#fff;margin-left:3px;font-weight:400}
/* Source section */
.gh-tip-section{margin-bottom:8px}
.gh-tip-source-row{display:flex;align-items:center;gap:8px;font-size:13px}
.gh-tip-source-icon{color:#6e7681;width:14px;display:flex;align-items:center;flex-shrink:0}
.gh-tip-source-icon svg{display:block}
.gh-tip-source-lbl{flex:1;color:#fff;font-weight:400}
.gh-tip-source-val{color:#fff;font-weight:500;min-width:16px;text-align:right}
/* Repo rows — colored dot, monospace name, gray count */
.gh-tip-repo-row{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:5px}
.gh-tip-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.gh-tip-repo-name{color:#fff;flex:1;font-family:var(--font-monospace);font-size:11px}
.gh-tip-repo-count{color:#6e7681;font-size:11px}
/* Divider */
.gh-tip-divider{height:1px;background:rgba(255,255,255,0.1);margin:8px 0}
/* Hint */
.gh-tip-no-contrib{font-size:12px;color:#6e7681}
    `;
    document.head.appendChild(style);
  }
}
