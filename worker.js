const JSON_HEADERS = { "content-type": "application/json; charset=UTF-8" };
const ALLOWED_FILE_EXTENSIONS = new Set(["xls", "xlsx", "csv", "txt"]);
const FILE_TYPES = new Set([
  "A classificar", "Balanceamento", "LGPLA", "LQUA Inicial", "MLGT Atual", "MARC",
  "MLGN Pós-Carga", "MLGT Pós-Carga", "LQUA Pós-Saldo", "LQUA Recuperação",
  "Tabela 20 Antiga", "Tabela 20 Atual", "Range Caixa / Separador"
]);

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

function fileFromRow(row, object = null) {
  return {
    id: Number(row.id), execution_id: Number(row.execution_id), file_name: row.file_name,
    file_type: row.file_type || "A classificar", uploaded_by: row.uploaded_by,
    created_at: row.created_at, size: object?.size || 0
  };
}

function sanitizeFileName(name) {
  const sanitized = name.normalize("NFKC").replace(/[\\/\x00-\x1F\x7F]+/g, "-").replace(/\s+/g, " ").trim();
  return (sanitized || "arquivo").slice(-180);
}

function fileExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

async function findExecution(env, executionId) {
  return env.DB.prepare("SELECT id, project_id, name, status, created_at FROM executions WHERE id = ? LIMIT 1").bind(executionId).first();
}

async function findFile(env, fileId) {
  return env.DB.prepare(
    "SELECT f.id AS id, f.execution_id AS execution_id, f.file_name AS file_name, f.file_type AS file_type, f.storage_key AS storage_key, f.uploaded_by AS uploaded_by, f.created_at AS created_at, e.project_id AS project_id FROM files f JOIN executions e ON e.id = f.execution_id WHERE f.id = ? LIMIT 1"
  ).bind(fileId).first();
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

      const row = await env.DB.prepare(
        "INSERT INTO executions (project_id, name) VALUES (?, ?) RETURNING id, project_id, name, status, created_at"
      ).bind(projectId, validation.execution.name).first();

      return json({ execution: executionFromRow(row) }, 201);
    }
  }

  const executionFilesMatch = url.pathname.match(/^\/api\/executions\/(\d+)\/files$/);
  if (executionFilesMatch) {
    const executionId = Number(executionFilesMatch[1]);
    const execution = await findExecution(env, executionId);
    if (!execution) return json({ error: "Execução não encontrada." }, 404);

    if (request.method === "GET") {
      const result = await env.DB.prepare(
        "SELECT id, execution_id, file_name, file_type, storage_key, uploaded_by, created_at FROM files WHERE execution_id = ? ORDER BY created_at DESC, id DESC"
      ).bind(executionId).all();
      const files = await Promise.all(result.results.map(async row => {
        let object = null;
        if (row.storage_key) {
          try { object = await env.FILES.head(row.storage_key); }
          catch (error) { console.error("R2 metadata lookup failed", row.storage_key, error); }
        }
        return fileFromRow(row, object);
      }));
      return json({ files });
    }

    if (request.method === "POST") {
      let form;
      try { form = await request.formData(); }
      catch { return json({ error: "Formulário de upload inválido." }, 400); }

      const uploadedFile = form.get("file");
      if (!uploadedFile || typeof uploadedFile.name !== "string" || typeof uploadedFile.stream !== "function") {
        return json({ error: "O campo file é obrigatório." }, 400);
      }
      if (!ALLOWED_FILE_EXTENSIONS.has(fileExtension(uploadedFile.name))) {
        return json({ error: "Formato não permitido. Envie XLS, XLSX, CSV ou TXT." }, 400);
      }
      const requestedType = String(form.get("file_type") || "A classificar");
      if (!FILE_TYPES.has(requestedType)) return json({ error: "Tipo de arquivo inválido." }, 400);

      const safeName = sanitizeFileName(uploadedFile.name);
      const storageKey = `projects/${execution.project_id}/executions/${executionId}/${crypto.randomUUID()}-${safeName}`;
      await env.FILES.put(storageKey, uploadedFile.stream(), {
        httpMetadata: { contentType: uploadedFile.type || "application/octet-stream" }
      });
      try {
        const row = await env.DB.prepare(
          "INSERT INTO files (execution_id, file_name, file_type, storage_key, uploaded_by) VALUES (?, ?, ?, ?, ?) RETURNING id, execution_id, file_name, file_type, storage_key, uploaded_by, created_at"
        ).bind(executionId, uploadedFile.name, requestedType, storageKey, "Você").first();
        return json({ file: fileFromRow(row, { size: uploadedFile.size }) }, 201);
      } catch (error) {
        try { await env.FILES.delete(storageKey); }
        catch (cleanupError) { console.error("R2 upload compensation failed", storageKey, cleanupError); }
        throw error;
      }
    }
  }

  const fileDownloadMatch = url.pathname.match(/^\/api\/files\/(\d+)\/download$/);
  if (request.method === "GET" && fileDownloadMatch) {
    const row = await findFile(env, Number(fileDownloadMatch[1]));
    if (!row) return json({ error: "Arquivo não encontrado." }, 404);
    if (!row.storage_key) return json({ error: "Arquivo sem objeto associado." }, 404);
    const object = await env.FILES.get(row.storage_key);
    if (!object) return json({ error: "Objeto do arquivo não encontrado." }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("content-length", String(object.size));
    const fallbackName = row.file_name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    headers.set("content-disposition", `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`);
    return new Response(object.body, { headers });
  }

  const fileMatch = url.pathname.match(/^\/api\/files\/(\d+)$/);
  if (fileMatch) {
    const fileId = Number(fileMatch[1]);
    const row = await findFile(env, fileId);
    if (!row) return json({ error: "Arquivo não encontrado." }, 404);

    if (request.method === "PATCH") {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: "JSON inválido." }, 400); }
      const fileType = typeof body?.file_type === "string" ? body.file_type.trim() : "";
      if (!FILE_TYPES.has(fileType)) return json({ error: "Tipo de arquivo inválido." }, 400);
      const updated = await env.DB.prepare(
        "UPDATE files SET file_type = ? WHERE id = ? RETURNING id, execution_id, file_name, file_type, storage_key, uploaded_by, created_at"
      ).bind(fileType, fileId).first();
      return json({ file: fileFromRow(updated) });
    }

    if (request.method === "DELETE") {
      if (row.storage_key) await env.FILES.delete(row.storage_key);
      await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(fileId).run();
      return json({ ok: true });
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
