import type { AppState, Branch, Visitor } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

export const api = {
  state: () => request<AppState>("/api/state"),
  createVisitor: (branchId: string, serviceCategory: string) =>
    request<{ visitor: Visitor }>("/api/visitors", {
      method: "POST",
      body: JSON.stringify({ branchId, serviceCategory }),
    }),
  updateVisitor: (id: string, action: "call" | "serve" | "walkaway") =>
    request<{ visitor: Visitor }>(`/api/visitors/${encodeURIComponent(id)}/action`, {
      method: "PATCH",
      body: JSON.stringify({ action }),
    }),
  updateBranch: (branch: Branch, changes: Partial<Pick<Branch, "staffCount" | "targetWaitMinutes">>) =>
    request<{ branch: Branch }>(`/api/branches/${encodeURIComponent(branch.id)}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    }),
  createBranch: (input: { name: string; city: string; region: string; prefix: string }) =>
    request<{ branch: Branch }>("/api/branches", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
