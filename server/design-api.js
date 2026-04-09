import { generateDesignArtifact } from "./design-engine.js";

export function createDesignApiPlugin() {
  return {
    name: "design-api",
    configureServer(server) {
      attachDesignRoute(server.middlewares);
    },
    configurePreviewServer(server) {
      attachDesignRoute(server.middlewares);
    },
  };
}

function attachDesignRoute(middlewares) {
  middlewares.use(async (request, response, next) => {
    const pathname = getPathname(request.url);
    if (pathname !== "/api/design") {
      next();
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    if (request.method !== "POST") {
      respondJson(response, 405, { error: "Method not allowed." });
      return;
    }

    try {
      const body = await readJsonBody(request);
      const artifact = await generateDesignArtifact(body.url ?? "");

      respondJson(response, 200, artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to generate DESIGN.md.";
      respondJson(response, 400, { error: message });
    }
  });
}

function getPathname(url) {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function corsHeaders() {
  return {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": "*",
  };
}

function respondJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(),
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}
