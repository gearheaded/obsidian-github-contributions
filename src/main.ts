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
} from "obsidian";

// ── Constants ────────────────────────────────────────────────────────────────
const VIEW_TYPE = "github-contributions";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ── Types ────────────────────────────────────────────────────────────────────
type SizePreset = "ultra-compact" | "compact" | "medium" | "large" | "fit";
type ViewMode = "year" | "month";
type DataSource = "github" | "local" | "both";

interface DayData {
  date: string;
  count: number;
  githubCount: number;
  localCount: number;
  repos: Record<string, number>; // repoName -> commit count
}

interface StreakInfo {
  current: number;
  longest: number;
}

interface LocalRepo {
  name: string;
  path: string;
  lastCommit: string | null; // ISO date
}

interface GitHubContributionsSettings {
  // Auth
  githubToken: string;
  githubUsername: string;
  // Data sources
  dataSource: DataSource;
  localRepoRoot: string;
  // Display
  sidebarSide: "left" | "right";
  selectedYear: number;
  sizePreset: SizePreset;
  defaultView: ViewMode;
  palette: Palette;
  statsStyle: StatsStyle;
  // Daily notes
  dailyNoteFolder: string;
  dailyNoteDateFormat: string;
}

const DEFAULT_SETTINGS: GitHubContributionsSettings = {
  githubToken: "",
  githubUsername: "",
  dataSource: "github",
  localRepoRoot: "",
  sidebarSide: "right",
  selectedYear: new Date().getFullYear(),
  sizePreset: "medium",
  defaultView: "year",
  palette: "default",
  statsStyle: "default",
  dailyNoteFolder: "",
  dailyNoteDateFormat: "YYYY-MM-DD",
};

// Cell sizes per preset
const PRESET_SIZES: Record<SizePreset, { cell: number; gap: number }> = {
  "ultra-compact": { cell: 7,  gap: 1 },
  "compact":       { cell: 9,  gap: 1 },
  "medium":        { cell: 11, gap: 2 },
  "large":         { cell: 14, gap: 3 },
  "fit":           { cell: 0,  gap: 2 }, // calculated at render time
};

// ── Palettes ─────────────────────────────────────────────────────────────────
type Palette = "default" | "high-contrast" | "colorblind" | "neon";
type StatsStyle = "compact" | "default" | "grid";

interface PaletteColors {
  dark:  [string, string, string, string, string]; // levels 0-4
  light: [string, string, string, string, string];
}

const PALETTES: Record<Palette, PaletteColors> = {
  "default": {
    dark:  ["var(--background-modifier-border)", "#0e4429", "#006d32", "#26a641", "#39d353"],
    light: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
  },
  "high-contrast": {
    dark:  ["var(--background-modifier-border)", "#1a5e2a", "#21a045", "#32d463", "#7fffb0"],
    light: ["#ebedf0", "#b6f0c2", "#3dd668", "#1a9e40", "#0a5c25"],
  },
  "colorblind": {
    dark:  ["var(--background-modifier-border)", "#0a3a6b", "#0e6eb5", "#1ab3d8", "#57e8f5"],
    light: ["#edf4fb", "#b3d4f0", "#4aa8e0", "#1478c8", "#064a8a"],
  },
  "neon": {
    dark:  ["var(--background-modifier-border)", "#2d0a4e", "#7b00c2", "#e0008c", "#ffe600"],
    light: ["#f5eaff", "#c97df5", "#9400d3", "#d4006a", "#c8a800"],
  },
};

// ── GitHub API ───────────────────────────────────────────────────────────────
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

// ── Local Git ────────────────────────────────────────────────────────────────

// Use Obsidian's adapter to run shell commands (desktop only via child_process via require)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isDesktop = !!(window as any).require;

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

async function discoverRepos(rootPath: string): Promise<LocalRepo[]> {
  if (!isDesktop) return [];
  const repos: LocalRepo[] = [];
  // Use find-like approach: list subdirectories up to 2 levels deep that contain .git
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fs = (window as any).require("fs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const path = (window as any).require("path");

    const scanDir = (dir: string, depth: number) => {
      if (depth > 2) return;
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

function fetchLocalCommits(repo: LocalRepo, year: number): Map<string, number> {
  const map = new Map<string, number>();
  // Use day before/after to make range inclusive (--after/--before are exclusive in git)
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

// ── Build unified day map ────────────────────────────────────────────────────
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

// ── Generate full year week structure ────────────────────────────────────────
function buildYearWeeks(year: number, days: Map<string, DayData>): DayData[][] {
  // Build array of all dates in the year, padded to start on Sunday
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

function buildMonthDays(year: number, month: number, days: Map<string, DayData>): DayData[][] {
  // month is 0-indexed
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

// ── Streaks ──────────────────────────────────────────────────────────────────
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

function mostRecentRepo(repos: LocalRepo[]): string | null {
  if (!repos.length) return null;
  const sorted = [...repos].filter(r => r.lastCommit).sort((a,b) => (b.lastCommit ?? "").localeCompare(a.lastCommit ?? ""));
  return sorted[0]?.name ?? null;
}

// ── View ─────────────────────────────────────────────────────────────────────
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
        repos = await discoverRepos(s.localRepoRoot);
      }

      const { days, totalGH, totalLocal } = await buildDayMap(s, this.displayYear, repos);
      container.empty();

      const streaks = calculateStreaks(days, this.displayYear);
      const sinceCommit = daysSinceLastCommit(days);
      const recentRepo = mostRecentRepo(repos);

      this.renderHeader(container);
      this.renderStats(container, { totalGH, totalLocal, streaks, sinceCommit, recentRepo });

      if (this.viewMode === "year") {
        const weeks = buildYearWeeks(this.displayYear, days);
        this.renderYearGrid(container, weeks);
      } else {
        const weeks = buildMonthDays(this.displayYear, this.displayMonth, days);
        this.renderMonthGrid(container, weeks);
      }

      this.renderLegend(container);
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
      if (showLocal && info.sinceCommit !== null)
        items.push(["⏱", info.sinceCommit + "d", "Days since last commit"]);
      if (info.recentRepo)
        items.push(["📁", info.recentRepo.length > 20 ? info.recentRepo.slice(0,19) + "\u2026" : info.recentRepo, info.recentRepo]);
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
        this.pill(stats, info.sinceCommit + "d", "since commit");
      if (info.recentRepo) {
        const maxLen = 16;
        const name = info.recentRepo.length > maxLen ? info.recentRepo.slice(0, maxLen-1) + "\u2026" : info.recentRepo;
        const pill = stats.createDiv({ cls: "gh-stat gh-stat--wide" });
        pill.title = info.recentRepo;
        pill.createEl("span", { cls: "gh-stat-val", text: name });
        pill.createEl("span", { cls: "gh-stat-lbl", text: "recent repo" });
      }
    } else {
      // Default: flex row, wraps
      const stats = container.createDiv({ cls: "gh-stats" });
      this.pill(stats, String(total), "contributions");
      this.pill(stats, info.streaks.current + "d", "streak");
      this.pill(stats, info.streaks.longest + "d", "best");
      if (showLocal && info.sinceCommit !== null)
        this.pill(stats, info.sinceCommit + "d", "since commit");
      if (info.recentRepo) {
        const maxLen = 20;
        const name = info.recentRepo.length > maxLen ? info.recentRepo.slice(0, maxLen-1) + "\u2026" : info.recentRepo;
        const pill = stats.createDiv({ cls: "gh-stat gh-stat--wide" });
        pill.title = info.recentRepo;
        pill.createEl("span", { cls: "gh-stat-val", text: name });
        pill.createEl("span", { cls: "gh-stat-lbl", text: "recent repo" });
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
    const dateStr = moment(day.date).format("YYYY-MM-DD");
    const lines: string[] = [dateStr];

    if (day.count === 0) {
      lines.push("No contributions");
    } else {
      lines.push(`${day.count} contribution${day.count !== 1 ? "s" : ""}`);
      // Per-source breakdown
      if (s.dataSource === "both") {
        if (day.githubCount > 0) lines.push(`  GitHub: ${day.githubCount}`);
        if (day.localCount > 0) lines.push(`  Local: ${day.localCount}`);
      }
      // Per-repo breakdown
      const repoEntries = Object.entries(day.repos).sort((a,b) => b[1]-a[1]);
      for (const [repo, count] of repoEntries) {
        lines.push(`  ${repo} (${count})`);
      }
    }

    this.tooltipEl.empty();
    lines.forEach((line, i) => {
      if (i > 0) this.tooltipEl!.createEl("br");
      if (i === 0) {
        this.tooltipEl!.createEl("strong", { text: line });
      } else {
        this.tooltipEl!.appendText(line);
      }
    });

    this.tooltipEl.style.display = "block";
    this.tooltipEl.style.left = e.pageX + 12 + "px";
    this.tooltipEl.style.top  = e.pageY - 34 + "px";
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
      ? "Add your GitHub username and Personal Access Token in Settings."
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function countToLevel(n: number): number {
  if (n === 0) return 0;
  if (n <= 2) return 1;
  if (n <= 5) return 2;
  if (n <= 9) return 3;
  return 4;
}

// ── Settings Tab ─────────────────────────────────────────────────────────────
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

    if (src === "local" || src === "both") {
      if (!isDesktop) {
        containerEl.createEl("p", { cls: "gh-settings-notice", text: "⚠ Local git scanning is not available on mobile." });
      } else {
        new Setting(containerEl)
          .setName("Local repo root")
          .setDesc("Folder to scan for git repositories (searches 2 levels deep)")
          .addText(t => t.setPlaceholder("C:\\Users\\Peter\\Projects").setValue(this.plugin.settings.localRepoRoot)
            .onChange(async v => { this.plugin.settings.localRepoRoot = v.trim(); await this.plugin.saveSettings(); }));
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
        .addOption("default",       "Default (GitHub greens)")
        .addOption("high-contrast", "High contrast (vivid greens)")
        .addOption("colorblind",    "Colorblind friendly (blue to cyan)")
        .addOption("neon",          "Neon (purple to yellow)")
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
    containerEl.createEl("h3", { text: "Daily Notes" });

    new Setting(containerEl)
      .setName("Daily notes folder")
      .setDesc("Leave blank for vault root")
      .addText(t => t.setPlaceholder("Daily Notes/").setValue(this.plugin.settings.dailyNoteFolder)
        .onChange(async v => { this.plugin.settings.dailyNoteFolder = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Date format")
      .setDesc("Moment.js format for filenames. Default: YYYY-MM-DD")
      .addText(t => t.setPlaceholder("YYYY-MM-DD").setValue(this.plugin.settings.dailyNoteDateFormat)
        .onChange(async v => { this.plugin.settings.dailyNoteDateFormat = v; await this.plugin.saveSettings(); }));
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────
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
    const p = PALETTES[this.settings.palette] ?? PALETTES["default"];
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
    `;
    document.head.appendChild(style);
  }
}
