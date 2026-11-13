export type VisitStatus = "WAITING" | "CALLED" | "SERVED" | "WALK_AWAY";

export interface Branch {
  id: string;
  name: string;
  city: string;
  region: string;
  prefix: string;
  staffCount: number;
  targetWaitMinutes: number;
}

export interface Visitor {
  id: string;
  branchId: string;
  ticket: string;
  serviceCategory: string;
  status: VisitStatus;
  createdAt: string;
  calledAt: string | null;
  completedAt: string | null;
  waitSeconds: number | null;
  serviceSeconds: number | null;
}

export interface AppState {
  branches: Branch[];
  visitors: Visitor[];
}

export const SERVICE_CATEGORIES = [
  "Civil registration",
  "Permits & licensing",
  "Land services",
  "Social services",
];
