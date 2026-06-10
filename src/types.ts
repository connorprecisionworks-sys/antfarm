export interface Project {
  slug: string;
  name: string;
  status: string | null;
  last_activity: number | null;
  idea_count: number;
  decision_count: number;
  repos: string[];
}
