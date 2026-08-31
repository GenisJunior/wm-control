const JSON_HEADERS = { "content-type": "application/json; charset=UTF-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function projectFromRow(row) {
  return {
    id: String(row.id),
    name: row.name,
    werks: row.werks,
    lgnum: row.lgnum,
    created_at: row.created_at
  };
}

function validateProjectInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Corpo da requisição inválido." };
  }

  const project = {
    name: typeof body.name === "string" ? body.name.trim() : "",
    werks: typeof body.werks === "string" ? body.werks.trim() : "",
    lgnum: typeof body.lgnum === "string" ? body.lgnum.trim() : ""
  };

  if (!project.name || !project.werks || !project.lgnum) {
    return { error: "Os campos name, werks e lgnum são obrigatórios." };
  }

  if (project.name.length > 200 || project.werks.length > 50 || project.lgnum.length > 50) {
    return { error: "Um ou mais campos excedem o tamanho permitido." };
  }

  return { project };
}

async function handleApi(request, env, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true, message: "WM Control API online" });
  }

  if (request.method === "GET" && url.pathname === "/api/projects") {
    const result = await env.DB.prepare(
      "SELECT id, name, werks, lgnum, created_at FROM projects ORDER BY created_at DESC"
    ).all();
    return json({ projects: result.results.map(projectFromRow) });
  }

  if (request.method === "POST" && url.pathname === "/api/projects") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "JSON inválido." }, 400);
    }

    const validation = validateProjectInput(body);
    if (validation.error) return json({ error: validation.error }, 400);

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const { name, werks, lgnum } = validation.project;

    await env.DB.prepare(
      "INSERT INTO projects (id, name, werks, lgnum, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, name, werks, lgnum, createdAt).run();

    return json({ project: { id, name, werks, lgnum, created_at: createdAt } }, 201);
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (request.method === "GET" && projectMatch) {
    let id;
    try {
      id = decodeURIComponent(projectMatch[1]);
    } catch {
      return json({ error: "Identificador de projeto inválido." }, 400);
    }

    const row = await env.DB.prepare(
      "SELECT id, name, werks, lgnum, created_at FROM projects WHERE id = ? LIMIT 1"
    ).bind(id).first();

    if (!row) return json({ error: "Projeto não encontrado." }, 404);
    return json({ project: projectFromRow(row) });
  }

  return json({ error: "Rota da API não encontrada." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        console.error("WM Control API error", error);
        return json({ error: "Não foi possível processar a solicitação." }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
