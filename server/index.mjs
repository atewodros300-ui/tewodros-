import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const store = createStore(path.join(here, "..", ".data", "state.json"));
const port = Number(process.env.API_PORT || 4000);
const host = process.env.HOST || "127.0.0.1";

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16_384) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Request body must be a JSON object.");
    }
    return body;
  } catch {
    throw new Error("Request body must be a valid JSON object.");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, { status: "ok", mode: "local-demo" });
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      return sendJson(response, 200, store.snapshot());
    }
    if (request.method === "POST" && url.pathname === "/api/visitors") {
      const body = await readJson(request);
      return sendJson(response, 201, { visitor: store.createVisitor(body) });
    }
    if (request.method === "POST" && url.pathname === "/api/branches") {
      const body = await readJson(request);
      return sendJson(response, 201, { branch: store.createBranch(body) });
    }

    const actionMatch = url.pathname.match(/^\/api\/visitors\/([^/]+)\/action$/);
    if (request.method === "PATCH" && actionMatch) {
      const body = await readJson(request);
      return sendJson(response, 200, { visitor: store.updateVisitor(decodeURIComponent(actionMatch[1]), body.action) });
    }
    const branchMatch = url.pathname.match(/^\/api\/branches\/([^/]+)$/);
    if (request.method === "PATCH" && branchMatch) {
      const body = await readJson(request);
      return sendJson(response, 200, { branch: store.updateBranch(decodeURIComponent(branchMatch[1]), body) });
    }

    return sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message.includes("too large") ? 413
      : message.includes("not found") ? 404
        : 400;
    return sendJson(response, status, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`GovFlow demo API listening on http://${host}:${port}`);
});
