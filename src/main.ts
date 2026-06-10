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

// ## Constants ################################################################
const VIEW_TYPE = "github-contributions";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";

// ## Types ####################################################################
interface ContributionDay {
  date: string;
  contributionCount: number;
}
interface ContributionWeek {
  contributionDays: ContributionDay[];
}
interface ContributionStats {
  totalContributions: number;
  weeks: ContributionWeek[];
}
interface StreakInfo {
  current: number;
  longest: number;
}
interface GitHubContributionsSettings {
  githubToken: string;
  githubUsername: string;
  sidebarSide: "left" | "right";
  selectedYear: number;
  dailyNoteFolder: string;
  dailyNoteDateFormat: string;
}

const DEFAULT_SETTINGS: GitHubContributionsSettings = {
  githubToken: "",
  githubUsername: "",
  sidebarSide: "right",
  selectedYear: new Date().getFullYear(),
  dailyNoteFolder: "",
  dailyNoteDateFormat: "YYYY-MM-DD",
};

// ## GitHub API ##############################################################─
async function fetchContributions(
  username: string,
  token: string,
  year: number
): Promise<ContributionStats> {
  const from = `${year}-01-01T00:00:00Z`;
  const to = `${year}-12-31T23:59:59Z`;
  const query = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}`;
  const response = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { login: username, from, to } }),
  });
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  const json = await response.json();
  if (json.errors) throw new Error(json.errors[0]?.message ?? "GitHub API error");
  const cal = json?.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw new Error("No contribution data returned. Check username.");
  return cal as ContributionStats;
}

// ## Streak calc ##############################################################
function calculateStreaks(weeks: ContributionWeek[]): StreakInfo {
  const days = weeks.flatMap((w) => w.contributionDays).sort((a, b) => a.date.localeCompare(b.date));
  const today = moment().format("YYYY-MM-DD");

  // Longest streak
  let longest = 0, run = 0;
  for (const d of days) {
    if (d.contributionCount > 0) { run++; if (run > longest) longest = run; }
    else run = 0;
  }

  // Current streak (backwards from today)
  let current = 0;
  const pastDays = days.filter((d) => d.date <= today).reverse();
  // Allow today to be empty (in progress)
  let skipFirst = pastDays.length > 0 && pastDays[0].contributionCount === 0;
  for (const d of pastDays) {
    if (skipFirst) { skipFirst = false; continue; }
    if (d.contributionCount > 0) current++;
    else break;
  }
  return { current, longest };
}

// ## View ####################################################################─
export class ContributionsView extends ItemView {
  plugin: GitHubContributionsPlugin;
  displayYear: number;
  tooltipEl: HTMLDivElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GitHubContributionsPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.displayYear = plugin.settings.selectedYear;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "GitHub Contributions"; }
  getIcon() { return "github"; }

  async onOpen() { await this.render(); }
  async onClose() { this.tooltipEl?.remove(); this.tooltipEl = null; }

  async refresh() {
    this.displayYear = this.plugin.settings.selectedYear;
    await this.render();
  }

  private async render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("gh-contributions-view");

    // Shared tooltip
    if (!this.tooltipEl) {
      this.tooltipEl = document.body.createDiv({ cls: "gh-tooltip" });
    }

    if (!this.plugin.settings.githubToken || !this.plugin.settings.githubUsername) {
      this.renderEmpty(container); return;
    }

    this.renderSkeleton(container);

    try {
      const data = await fetchContributions(
        this.plugin.settings.githubUsername,
        this.plugin.settings.githubToken,
        this.displayYear
      );
      container.empty();
      this.renderGraph(container, data);
    } catch (e) {
      container.empty();
      this.renderError(container, (e as Error).message);
    }
  }

  private renderEmpty(container: HTMLElement) {
    const wrap = container.createDiv({ cls: "gh-empty" });
    wrap.createEl("div", { cls: "gh-empty-icon", text: "🐙" });
    wrap.createEl("p", { text: "Add your GitHub username and a Personal Access Token in Settings to see your contribution graph." });
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
    for (let i = 0; i < 53 * 7; i++) {
      grid.createDiv({ cls: "gh-skeleton gh-skeleton-cell" });
    }
  }

  private renderGraph(container: HTMLElement, data: ContributionStats) {
    const s = this.plugin.settings;
    const streaks = calculateStreaks(data.weeks);
    const currentYear = new Date().getFullYear();

    // ## Header row
    const header = container.createDiv({ cls: "gh-header" });
    header.createEl("span", { cls: "gh-username", text: s.githubUsername });

    const yearWrap = header.createDiv({ cls: "gh-year-wrap" });
    const prevBtn = yearWrap.createEl("button", { cls: "gh-year-btn", text: "‹" });
    yearWrap.createEl("span", { cls: "gh-year-label", text: String(this.displayYear) });
    const nextBtn = yearWrap.createEl("button", { cls: "gh-year-btn", text: "›" });
    nextBtn.disabled = this.displayYear >= currentYear;
    prevBtn.onclick = async () => { this.displayYear--; await this.render(); };
    nextBtn.onclick = async () => { if (this.displayYear < currentYear) { this.displayYear++; await this.render(); } };

    // ## Stats
    const stats = container.createDiv({ cls: "gh-stats" });
    this.pill(stats, String(data.totalContributions), "contributions");
    this.pill(stats, streaks.current + "d", "streak");
    this.pill(stats, streaks.longest + "d", "best streak");

    // ## Graph
    const graphWrap = container.createDiv({ cls: "gh-graph-wrap" });
    const monthRow = graphWrap.createDiv({ cls: "gh-month-row" });
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let lastMonth = -1;
    data.weeks.forEach((week, wi) => {
      const first = week.contributionDays[0];
      if (!first) return;
      const m = new Date(first.date).getUTCMonth();
      if (m !== lastMonth) {
        lastMonth = m;
        const lbl = monthRow.createEl("span", { cls: "gh-month-lbl", text: MONTHS[m] });
        lbl.style.gridColumn = String(wi + 1);
      }
    });

    const grid = graphWrap.createDiv({ cls: "gh-grid" });
    const today = moment().format("YYYY-MM-DD");

    data.weeks.forEach((week) => {
      const col = grid.createDiv({ cls: "gh-col" });
      week.contributionDays.forEach((day) => {
        const cell = col.createDiv({ cls: "gh-cell" });
        cell.dataset.level = String(this.countToLevel(day.contributionCount));
        if (day.date === today) cell.addClass("gh-today");

        cell.addEventListener("mouseenter", (e: MouseEvent) => this.showTip(e, day));
        cell.addEventListener("mouseleave", () => { if (this.tooltipEl) this.tooltipEl.style.display = "none"; });
        cell.addEventListener("click", () => this.openOrCreateDailyNote(day.date));
      });
    });

    // ## Legend
    const legend = container.createDiv({ cls: "gh-legend" });
    legend.createEl("span", { cls: "gh-legend-lbl", text: "Less" });
    for (let i = 0; i <= 4; i++) {
      const sq = legend.createDiv({ cls: "gh-cell gh-legend-cell" });
      sq.dataset.level = String(i);
    }
    legend.createEl("span", { cls: "gh-legend-lbl", text: "More" });

    // ## Refresh
    const footer = container.createDiv({ cls: "gh-footer" });
    const rb = footer.createEl("button", { cls: "gh-refresh-btn", text: "↻ Refresh" });
    rb.onclick = () => this.render();
  }

  private pill(parent: HTMLElement, value: string, label: string) {
    const p = parent.createDiv({ cls: "gh-stat" });
    p.createEl("span", { cls: "gh-stat-val", text: value });
    p.createEl("span", { cls: "gh-stat-lbl", text: label });
  }

  private countToLevel(n: number): number {
    if (n === 0) return 0;
    if (n <= 2) return 1;
    if (n <= 5) return 2;
    if (n <= 9) return 3;
    return 4;
  }

  private showTip(e: MouseEvent, day: ContributionDay) {
    if (!this.tooltipEl) return;
    const d = moment(day.date).format("MMM D, YYYY");
    const c = day.contributionCount;
    this.tooltipEl.textContent = c === 0 ? `No contributions on ${d}` : `${c} contribution${c !== 1 ? "s" : ""} on ${d}`;
    this.tooltipEl.style.display = "block";
    this.tooltipEl.style.left = e.pageX + 12 + "px";
    this.tooltipEl.style.top = e.pageY - 34 + "px";
  }

  private async openOrCreateDailyNote(date: string) {
    const s = this.plugin.settings;
    const fmt = s.dailyNoteDateFormat || "YYYY-MM-DD";
    const folder = s.dailyNoteFolder ? s.dailyNoteFolder.replace(/\/$/, "") + "/" : "";
    const name = moment(date).format(fmt);
    const path = `${folder}${name}.md`;

    let file = this.app.vault.getAbstractFileByPath(path) as TFile | null;
    if (!file) {
      try {
        file = await this.app.vault.create(path, `# ${name}\n\n`);
        new Notice(`Created: ${name}`);
      } catch (err) {
        new Notice(`Error creating note: ${(err as Error).message}`);
        return;
      }
    }
    await this.app.workspace.getLeaf(false).openFile(file as TFile);
  }

  private renderError(container: HTMLElement, msg: string) {
    container.createDiv({ cls: "gh-error", text: `⚠ ${msg}` });
    const btn = container.createDiv({ cls: "gh-footer" }).createEl("button", { cls: "gh-refresh-btn", text: "↻ Retry" });
    btn.onclick = () => this.render();
  }
}

// ## Settings Tab ############################################################─
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

    new Setting(containerEl)
      .setName("GitHub username")
      .setDesc("Your GitHub username (e.g. torvalds)")
      .addText((t) => t.setPlaceholder("username").setValue(this.plugin.settings.githubUsername)
        .onChange(async (v) => { this.plugin.settings.githubUsername = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Personal Access Token")
      .setDesc("A GitHub PAT with read:user scope. Generate at github.com/settings/tokens")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("ghp_…").setValue(this.plugin.settings.githubToken)
          .onChange(async (v) => { this.plugin.settings.githubToken = v.trim(); await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName("Sidebar side")
      .setDesc("Which sidebar the panel opens in")
      .addDropdown((d) => d.addOption("left", "Left").addOption("right", "Right")
        .setValue(this.plugin.settings.sidebarSide)
        .onChange(async (v) => { this.plugin.settings.sidebarSide = v as "left" | "right"; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Default year")
      .setDesc("Year shown when first opening the panel")
      .addText((t) => t.setPlaceholder(String(new Date().getFullYear()))
        .setValue(String(this.plugin.settings.selectedYear))
        .onChange(async (v) => {
          const y = parseInt(v);
          if (!isNaN(y) && y >= 2008 && y <= new Date().getFullYear()) {
            this.plugin.settings.selectedYear = y; await this.plugin.saveSettings();
          }
        }));

    containerEl.createEl("h3", { text: "Daily Notes" });

    new Setting(containerEl)
      .setName("Daily notes folder")
      .setDesc("Leave blank for vault root")
      .addText((t) => t.setPlaceholder("Daily Notes/").setValue(this.plugin.settings.dailyNoteFolder)
        .onChange(async (v) => { this.plugin.settings.dailyNoteFolder = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Date format")
      .setDesc("Moment.js format for daily note filenames. Default: YYYY-MM-DD")
      .addText((t) => t.setPlaceholder("YYYY-MM-DD").setValue(this.plugin.settings.dailyNoteDateFormat)
        .onChange(async (v) => { this.plugin.settings.dailyNoteDateFormat = v; await this.plugin.saveSettings(); }));
  }
}

// ## Plugin ##################################################################─
export default class GitHubContributionsPlugin extends Plugin {
  settings: GitHubContributionsSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new GitHubContributionsSettingTab(this.app, this));

    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new ContributionsView(leaf, this));

    this.addRibbonIcon("github", "GitHub Contributions", () => this.activateView());

    this.addCommand({
      id: "open-github-contributions",
      name: "Open GitHub Contributions panel",
      callback: () => this.activateView(),
    });

    this.injectStyles();
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    document.getElementById("gh-contributions-styles")?.remove();
    document.querySelectorAll(".gh-tooltip").forEach((el) => el.remove());
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
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof ContributionsView) (leaf.view as ContributionsView).refresh();
    });
  }

  private injectStyles() {
    if (document.getElementById("gh-contributions-styles")) return;
    const style = document.createElement("style");
    style.id = "gh-contributions-styles";
    style.textContent = `
.gh-contributions-view{padding:12px 10px 16px;overflow-y:auto;overflow-x:hidden;user-select:none}
.gh-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.gh-username{font-size:13px;font-weight:600;color:var(--text-normal);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gh-year-wrap{display:flex;align-items:center;gap:4px;flex-shrink:0}
.gh-year-label{font-size:12px;color:var(--text-muted);min-width:34px;text-align:center}
.gh-year-btn{background:none;border:1px solid var(--background-modifier-border);border-radius:4px;color:var(--text-muted);cursor:pointer;font-size:14px;line-height:1;padding:1px 6px;transition:background 0.15s}
.gh-year-btn:hover:not(:disabled){background:var(--background-modifier-hover);color:var(--text-normal)}
.gh-year-btn:disabled{opacity:.3;cursor:default}
.gh-stats{display:flex;gap:6px;margin-bottom:10px}
.gh-stat{display:flex;flex-direction:column;align-items:center;background:var(--background-secondary);border-radius:6px;padding:5px 8px;flex:1}
.gh-stat-val{font-size:14px;font-weight:700;color:var(--interactive-accent);line-height:1.2}
.gh-stat-lbl{font-size:9px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.04em;margin-top:2px;text-align:center}
.gh-graph-wrap{overflow-x:auto;padding-bottom:4px}
.gh-month-row{display:grid;grid-template-columns:repeat(53,11px);gap:2px;margin-bottom:3px}
.gh-month-lbl{font-size:9px;color:var(--text-faint)}
.gh-grid{display:flex;gap:2px}
.gh-col{display:flex;flex-direction:column;gap:2px}
.gh-cell{width:11px;height:11px;border-radius:2px;cursor:pointer;transition:transform .1s,outline .1s;flex-shrink:0}
.gh-cell:hover{transform:scale(1.3)}
.gh-today{outline:2px solid var(--interactive-accent)!important;outline-offset:1px}
.gh-cell[data-level="0"]{background:var(--background-modifier-border)}
.gh-cell[data-level="1"]{background:#0e4429}
.gh-cell[data-level="2"]{background:#006d32}
.gh-cell[data-level="3"]{background:#26a641}
.gh-cell[data-level="4"]{background:#39d353}
.theme-light .gh-cell[data-level="0"]{background:#ebedf0}
.theme-light .gh-cell[data-level="1"]{background:#9be9a8}
.theme-light .gh-cell[data-level="2"]{background:#40c463}
.theme-light .gh-cell[data-level="3"]{background:#30a14e}
.theme-light .gh-cell[data-level="4"]{background:#216e39}
.gh-legend{display:flex;align-items:center;gap:3px;margin-top:8px;justify-content:flex-end}
.gh-legend-lbl{font-size:9px;color:var(--text-faint)}
.gh-legend-cell{cursor:default!important;width:10px;height:10px}
.gh-legend-cell:hover{transform:none!important}
.gh-footer{display:flex;justify-content:flex-end;margin-top:10px}
.gh-refresh-btn{background:none;border:1px solid var(--background-modifier-border);border-radius:4px;color:var(--text-muted);cursor:pointer;font-size:11px;padding:3px 8px;transition:background .15s}
.gh-refresh-btn:hover{background:var(--background-modifier-hover);color:var(--text-normal)}
.gh-empty{display:flex;flex-direction:column;align-items:center;padding:24px 12px;text-align:center;gap:10px}
.gh-empty-icon{font-size:32px}
.gh-empty p{font-size:12px;color:var(--text-muted);line-height:1.5;margin:0}
.gh-btn{background:var(--interactive-accent);border:none;border-radius:6px;color:var(--text-on-accent);cursor:pointer;font-size:12px;padding:6px 14px}
.gh-btn:hover{filter:brightness(1.1)}
.gh-error{padding:10px 12px;background:var(--background-modifier-error);border-radius:6px;color:var(--text-error);font-size:12px;margin:8px 0}
.gh-skeleton-wrap{padding:4px 0}
.gh-skeleton-header{height:14px;width:55%;margin-bottom:10px;border-radius:4px}
.gh-skeleton-stats{height:44px;width:100%;margin-bottom:10px;border-radius:6px}
.gh-skeleton-grid{display:grid;grid-template-columns:repeat(53,11px);grid-template-rows:repeat(7,11px);gap:2px}
.gh-skeleton-cell{width:11px;height:11px;border-radius:2px}
.gh-skeleton{animation:gh-shimmer 1.4s infinite linear;background:linear-gradient(90deg,var(--background-modifier-border) 25%,var(--background-secondary) 50%,var(--background-modifier-border) 75%);background-size:200% 100%}
@keyframes gh-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.gh-tooltip{position:fixed;background:#1a1a1a;color:#fff;border-radius:5px;padding:5px 9px;font-size:11px;pointer-events:none;display:none;z-index:9999;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.theme-light .gh-tooltip{background:#333}
    `;
    document.head.appendChild(style);
  }
}
