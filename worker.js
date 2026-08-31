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

function executionFromRow(row) {
  return {
    id: Number(row.id),
    project_id: Number(row.project_id),
    name: row.name,
    status: row.status,
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

function validateExecutionInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Corpo da requisição inválido." };
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "O campo name é obrigatório." };
  if (name.length > 200) return { error: "O nome da execução excede o tamanho permitido." };
  return { execution: { name } };
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

    const createdAt = new Date().toISOString();
    const { name, werks, lgnum } = validation.project;

    const result = await env.DB.prepare(
      "INSERT INTO projects (name, werks, lgnum, created_at) VALUES (?, ?, ?, ?)"
    ).bind(name, werks, lgnum, createdAt).run();
    const id = result.meta.last_row_id;

    return json({ project: { id, name, werks, lgnum, created_at: createdAt } }, 201);
  }

  const projectExecutionsMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/executions$/);
  if (projectExecutionsMatch) {
    const projectId = Number(projectExecutionsMatch[1]);
    const project = await env.DB.prepare(
      "SELECT id FROM projects WHERE id = ? LIMIT 1"
    ).bind(projectId).first();
    if (!project) return json({ error: "Projeto não encontrado." }, 404);

    if (request.method === "GET") {
      const result = await env.DB.prepare(
        "SELECT id, project_id, name, status, created_at FROM executions WHERE project_id = ? ORDER BY created_at DESC, id DESC"
      ).bind(projectId).all();
      return json({ executions: result.results.map(executionFromRow) });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "JSON inválido." }, 400);
      }

      const validation = validateExecutionInput(body);
      if (validation.error) return json({ error: validation.error }, 400);

      const result = await env.DB.prepare(
        "INSERT INTO executions (project_id, name) VALUES (?, ?)"
      ).bind(projectId, validation.execution.name).run();
      const row = await env.DB.prepare(
        "SELECT id, project_id, name, status, created_at FROM executions WHERE id = ? LIMIT 1"
      ).bind(result.meta.last_row_id).first();

      return json({ execution: executionFromRow(row) }, 201);
    }
  }

  const executionMatch = url.pathname.match(/^\/api\/executions\/(\d+)$/);
  if (request.method === "GET" && executionMatch) {
    const row = await env.DB.prepare(
      "SELECT id, project_id, name, status, created_at FROM executions WHERE id = ? LIMIT 1"
    ).bind(Number(executionMatch[1])).first();
    if (!row) return json({ error: "Execução não encontrada." }, 404);
    return json({ execution: executionFromRow(row) });
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
