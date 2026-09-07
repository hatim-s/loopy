export type ProjectRecord = { id: string; name: string; path: string; lastOpened: string };
export type ProjectSummary = ProjectRecord & { current: boolean; running: boolean; url?: string };
export type ProjectList = { current: string; projects: ProjectSummary[] };
