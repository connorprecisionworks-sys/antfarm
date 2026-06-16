// Honest derived-math facts for the Wrapped view.
// Every number here is deterministic arithmetic from real backend data.
// NO fabricated percentiles, NO global comparisons — only vs the user's own history.

export type Period = 'week' | 'month' | 'all_time';

export const PERIOD_LABELS: Record<Period, string> = {
  week: 'week',
  month: 'month',
  all_time: 'all time',
};

// tokens × 0.75 ≈ words (well-established LLM approximation)
export function tokensToWords(tokens: number): number {
  return Math.round(tokens * 0.75);
}

// average novel ≈ 90,000 words
export function wordsToNovels(words: number): number {
  return words / 90_000;
}

// rough: 50 lines changed per focused hour (mix of new code + refactor)
export function linesToHours(linesChanged: number): number {
  return linesChanged / 50;
}

// est. 15 min avg dispatch run → 0.25 agent-hours per run
export function runsToAgentHours(runs: number): number {
  return runs * 0.25;
}

// Format a number as k/M shorthand
export function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

// vs-own-history comparison: pure ratio, no invented cohort
// Returns null when there's no prior period data (e.g. all_time or first week)
export function vsHistory(
  current: number,
  prev: number,
  period: Period,
): string | null {
  if (prev === 0 || current === 0) return null;
  const mult = current / prev;
  const label = period === 'week' ? 'prev week' : period === 'month' ? 'prev month' : 'prev period';
  if (mult >= 1.05) return `${mult.toFixed(1)}× your ${label}`;
  if (mult <= 0.95) return `${(1 / mult).toFixed(1)}× below your ${label}`;
  return `on pace with your ${label}`;
}

// Format a date string (YYYY-MM-DD) as "Jun 12"
export function fmtDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
