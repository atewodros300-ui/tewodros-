import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const serviceCategories = [
  "Civil registration",
  "Permits & licensing",
  "Land services",
  "Social services",
];

function minutesAgo(now, minutes) {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

export function createSeedState(now = new Date()) {
  const branches = [
    { id: "central", name: "Central Service Centre", city: "Addis Ababa", region: "Central", prefix: "CT", staffCount: 18, targetWaitMinutes: 15 },
    { id: "bole", name: "Bole Public Service Office", city: "Addis Ababa", region: "Central", prefix: "BL", staffCount: 12, targetWaitMinutes: 12 },
    { id: "kirkos", name: "Kirkos Branch Office", city: "Addis Ababa", region: "Central", prefix: "KR", staffCount: 10, targetWaitMinutes: 15 },
    { id: "hawassa", name: "Hawassa Service Centre", city: "Hawassa", region: "South", prefix: "HW", staffCount: 14, targetWaitMinutes: 20 },
    { id: "adama", name: "Adama Branch Office", city: "Adama", region: "Oromia", prefix: "AD", staffCount: 9, targetWaitMinutes: 18 },
  ];

  const visitorSeeds = [
    ["central", "CT-104", "Civil registration", "WAITING", 8],
    ["central", "CT-103", "Land services", "CALLED", 17],
    ["central", "CT-102", "Permits & licensing", "SERVED", 34],
    ["central", "CT-101", "Social services", "SERVED", 49],
    ["central", "CT-100", "Civil registration", "WALK_AWAY", 62],
    ["bole", "BL-082", "Permits & licensing", "WAITING", 5],
    ["bole", "BL-081", "Civil registration", "WAITING", 13],
    ["bole", "BL-080", "Social services", "CALLED", 20],
    ["bole", "BL-079", "Land services", "SERVED", 39],
    ["kirkos", "KR-057", "Land services", "WAITING", 11],
    ["kirkos", "KR-056", "Civil registration", "CALLED", 23],
    ["kirkos", "KR-055", "Permits & licensing", "SERVED", 47],
    ["hawassa", "HW-091", "Social services", "WAITING", 7],
    ["hawassa", "HW-090", "Civil registration", "WAITING", 18],
    ["hawassa", "HW-089", "Land services", "SERVED", 42],
    ["adama", "AD-036", "Permits & licensing", "WAITING", 9],
    ["adama", "AD-035", "Civil registration", "SERVED", 37],
  ];

  const visitors = visitorSeeds.map(([branchId, ticket, serviceCategory, status, age], index) => {
    const createdAt = minutesAgo(now, age);
    const calledAt = status === "CALLED" || status === "SERVED"
      ? minutesAgo(now, Math.max(0, age - 6))
      : null;
    const completedAt = status === "SERVED" ? minutesAgo(now, Math.max(0, age - 16)) : null;
    const waitSeconds = status === "SERVED" ? 600 + (index % 4) * 165 : null;
    return {
      id: `seed-${index + 1}`,
      branchId,
      ticket,
      serviceCategory,
      status,
      createdAt,
      calledAt,
      completedAt,
      waitSeconds,
      serviceSeconds: status === "SERVED" ? 420 + (index % 3) * 120 : null,
    };
  });

  return { branches, visitors };
}

export function createStore(filePath, clock = () => new Date()) {
  const resolvedPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  let state;
  try {
    state = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = createSeedState(clock());
    persist();
  }

  function persist() {
    const temporaryPath = `${resolvedPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(temporaryPath, resolvedPath);
  }

  function snapshot() {
    return structuredClone(state);
  }

  function createVisitor(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Visitor details must be a JSON object.");
    }
    const { branchId, serviceCategory } = input;
    const branch = state.branches.find((item) => item.id === branchId);
    if (!branch) throw new Error("Branch not found.");
    if (!serviceCategories.includes(serviceCategory)) throw new Error("Select a valid service category.");

    const dayPrefix = clock().toISOString().slice(0, 10).replaceAll("-", "");
    const todaysTickets = state.visitors.filter(
      (item) => item.branchId === branchId && item.ticket.startsWith(`${branch.prefix}-${dayPrefix}-`),
    ).length;
    const ticket = `${branch.prefix}-${dayPrefix}-${String(todaysTickets + 1).padStart(3, "0")}`;
    const visitor = {
      id: `${branchId}-${dayPrefix}-${todaysTickets + 1}`,
      branchId,
      ticket,
      serviceCategory,
      status: "WAITING",
      createdAt: clock().toISOString(),
      calledAt: null,
      completedAt: null,
      waitSeconds: null,
      serviceSeconds: null,
    };
    state.visitors.unshift(visitor);
    persist();
    return structuredClone(visitor);
  }

  function updateVisitor(id, action) {
    const visitor = state.visitors.find((item) => item.id === id);
    if (!visitor) throw new Error("Visitor ticket not found.");
    const now = clock();

    if (action === "call" && visitor.status === "WAITING") {
      visitor.status = "CALLED";
      visitor.calledAt = now.toISOString();
    } else if (action === "serve" && visitor.status === "CALLED") {
      visitor.status = "SERVED";
      visitor.completedAt = now.toISOString();
      visitor.waitSeconds = Math.max(0, Math.round((now.getTime() - new Date(visitor.createdAt).getTime()) / 1000));
      visitor.serviceSeconds = Math.max(0, Math.round((now.getTime() - new Date(visitor.calledAt).getTime()) / 1000));
    } else if (action === "walkaway" && ["WAITING", "CALLED"].includes(visitor.status)) {
      visitor.status = "WALK_AWAY";
      visitor.completedAt = now.toISOString();
      visitor.waitSeconds = Math.max(0, Math.round((now.getTime() - new Date(visitor.createdAt).getTime()) / 1000));
    } else {
      throw new Error("That action is not available for this ticket.");
    }

    persist();
    return structuredClone(visitor);
  }

  function updateBranch(id, changes) {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      throw new Error("Branch changes must be a JSON object.");
    }
    const branch = state.branches.find((item) => item.id === id);
    if (!branch) throw new Error("Branch not found.");
    if (changes.staffCount !== undefined) {
      if (!Number.isInteger(changes.staffCount) || changes.staffCount < 1 || changes.staffCount > 500) {
        throw new Error("Staff count must be between 1 and 500.");
      }
      branch.staffCount = changes.staffCount;
    }
    if (changes.targetWaitMinutes !== undefined) {
      if (!Number.isInteger(changes.targetWaitMinutes) || changes.targetWaitMinutes < 1 || changes.targetWaitMinutes > 240) {
        throw new Error("Target wait must be between 1 and 240 minutes.");
      }
      branch.targetWaitMinutes = changes.targetWaitMinutes;
    }
    persist();
    return structuredClone(branch);
  }

  function createBranch(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Branch details must be a JSON object.");
    }
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const city = typeof input.city === "string" ? input.city.trim() : "";
    const prefix = typeof input.prefix === "string" ? input.prefix.trim().toUpperCase() : "";
    if (typeof name !== "string" || !name || name.length > 80
      || typeof city !== "string" || !city || city.length > 80
      || !/^[A-Z]{2,4}$/.test(prefix)
      || (input.region !== undefined && (typeof input.region !== "string" || input.region.trim().length > 80))) {
      throw new Error("Provide a branch name, city, and a 2–4 letter ticket prefix.");
    }
    if (state.branches.some((branch) => branch.prefix === prefix)) {
      throw new Error("That ticket prefix is already in use.");
    }
    const branch = {
      id: `branch-${randomUUID()}`,
      name,
      city,
      region: input.region?.trim() || "Unassigned",
      prefix,
      staffCount: 1,
      targetWaitMinutes: 15,
    };
    state.branches.push(branch);
    persist();
    return structuredClone(branch);
  }

  return { snapshot, createVisitor, updateVisitor, updateBranch, createBranch };
}
