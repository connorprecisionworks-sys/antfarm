export interface Project {
  slug: string;
  name: string;
  status: string | null;
  last_activity: number | null;
  idea_count: number;
  decision_count: number;
  repos: string[];
}

export interface ProjectDetail {
  slug: string;
  name: string;
  status: string | null;
  last_activity: number | null;
  repos: string[];
  readme: string | null;
  ideas: string | null;
  notes_files: string[];
}

export interface DayUsage {
  date: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  est_dollars: number;
  total_tokens: number;
}

export interface ProjectUsage {
  slug: string;
  name: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  est_dollars: number;
  total_tokens: number;
}

export interface WeekTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  est_dollars: number;
  total_tokens: number;
  week_start: string;
  today: string;
  days_until_reset: number;
}

export interface UsageRollup {
  days: DayUsage[];
  week: WeekTotals;
  by_project: ProjectUsage[];
  cached_files: number;
  parsed_files: number;
}

export interface Settings {
  weekly_cap_tokens: number;
  reset_weekday: number; // 0=Mon … 6=Sun
}

export interface TokenTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  est_dollars: number;
}

export interface SessionMeta {
  id: string;
  provider: "claude-code" | "cowork";
  repo_path: string | null;
  title: string | null;
  started_at: number | null;
  last_activity: number;
  token_totals: TokenTotals | null;
  status: "running" | "idle" | "needs_permission" | "waiting" | "done";
  project_slug: string | null;
  attention: boolean;
}

export interface GitPeriodMetrics {
  commits: number;
  lines_added: number;
  lines_removed: number;
  files_changed: number;
}

export interface ProjectGitMetrics {
  slug: string;
  week: GitPeriodMetrics;
  all_time: GitPeriodMetrics;
  last_commit_ts: number | null;
  last_commit_subject: string | null;
  no_data: boolean;
}

export interface RepoResolution {
  basename: string;
  path: string | null;
  status: string;
}

export interface GitMetricsRollup {
  by_project: ProjectGitMetrics[];
  week_total: GitPeriodMetrics;
  resolutions: RepoResolution[];
}

export interface DirtyFile {
  path: string;
  state: string;
  mtime: number | null;
}

export interface ProjectWorkingTree {
  slug: string;
  dirty_count: number;
  files: DirtyFile[];
  no_data: boolean;
}

export interface WorkingTreeRollup {
  by_project: ProjectWorkingTree[];
}
