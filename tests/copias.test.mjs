// Detecção de cópias da LP (CÓPIAS DA PÁGINA em cloudflare/worker.js).
// Rodar com: node --test tests/copias.test.mjs  (Node 22.5+, por causa do node:sqlite)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker from "../cloudflare/worker.js";

const raiz = new URL("../", import.meta.url);
const schema = readFileSync(new URL("cloudflare/schema.sql", raiz), "utf8");
const codigoWorker = readFileSync(new URL("cloudflare/worker.js", raiz), "utf8");
const pagina = readFileSync(new URL("index.html", raiz), "utf8");

const OFICIAL = "https://blacknovember.contabilidadefacilitada.com";

// D1 sobre o node:sqlite, só com o que o Worker usa nestas rotas
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const preparar = (sql) => {
    let valores = [];
    const comando = {
      bind(...v) { valores = v; return comando; },
      async run() { db.prepare(sql).run(...valores); return {}; },
      async all() { return { results: db.prepare(sql).all(...valores).map((l) => ({ ...l })) }; },
      async first() { const l = db.prepare(sql).get(...valores); return l ? { ...l } : null; },
    };
    return comando;
  };
  return {
    sqlite: db,
    prepare: preparar,
    async batch(lista) { for (const c of lista) await c.run(); return []; },
  };
}

async function pedir(env, endereco, init = {}) {
  const pendentes = [];
  const ctx = { waitUntil: (p) => pendentes.push(p) };
  const r = await worker.fetch(new Request(endereco, init), env, ctx);
  await Promise.all(pendentes);
  return r;
}

function ambiente() {
  const DB = d1();
  const ASSETS = { fetch: async () => new Response("arquivo") };
  return { DB, ASSETS, linhas: () => DB.sqlite.prepare("SELECT * FROM copias_pf ORDER BY dominio").all().map((l) => ({ ...l })) };
}

test("o aviso do script registra o domínio da cópia, o endereço e de onde veio o visitante", async () => {
  const env = ambiente();
  const r = await pedir(env, `${OFICIAL}/api/endereco`, {
    method: "POST",
    headers: { Origin: "https://black-novembro.example" },
    body: JSON.stringify({ u: "https://black-novembro.example/?utm_source=x", r: "https://l.instagram.com/" }),
  });
  assert.equal(r.status, 204);
  await pedir(env, `${OFICIAL}/api/endereco`, {
    method: "POST",
    headers: { Origin: "https://black-novembro.example" },
    body: JSON.stringify({ u: "https://black-novembro.example/", r: "" }),
  });
  const [l] = env.linhas();
  assert.deepEqual(
    [l.dominio, l.sinais, l.visitas, l.exemplo, l.vindo_de],
    ["black-novembro.example", "script", 2, "https://black-novembro.example/", "l.instagram.com"],
  );
});

test("domínios da empresa, workers.dev do Worker, tradutor e teste local não viram cópia", async () => {
  const env = ambiente();
  for (const origem of [
    OFICIAL,
    "https://contabilidadefacilitada.com",
    "https://www.contabilidadefacilitada.com.br",
    "https://lp-black-institucional.gabrielrabelo87.workers.dev",
    "https://abc123-lp-black-institucional.gabrielrabelo87.workers.dev",
    "https://blacknovember-contabilidadefacilitada-com.translate.goog",
    "http://localhost:8787",
  ]) {
    await pedir(env, `${OFICIAL}/api/endereco`, { method: "POST", headers: { Origin: origem }, body: "{}" });
    await pedir(env, `${OFICIAL}/assets/img/fundo.gif`, { headers: { Referer: `${origem}/`, "Sec-Fetch-Dest": "image" } });
  }
  // domínio parecido, mas de outra pessoa
  await pedir(env, `${OFICIAL}/api/endereco`, { method: "POST", headers: { Origin: "https://contabilidadefacilitada.com.golpe.example" }, body: "{}" });
  assert.deepEqual(env.linhas().map((l) => l.dominio), ["contabilidadefacilitada.com.golpe.example"]);
});

test("gif do CSS e arquivos pedidos por outro domínio somam sinais; a abertura da LP vinda do Google não conta", async () => {
  const env = ambiente();
  const gif = await pedir(env, `${OFICIAL}/assets/img/fundo.gif`, {
    headers: { Referer: "https://copia.example/assets/css/style.css", "Sec-Fetch-Dest": "image" },
  });
  assert.equal(gif.headers.get("Content-Type"), "image/gif");
  assert.equal(new TextDecoder().decode((await gif.arrayBuffer()).slice(0, 6)), "GIF89a");
  await pedir(env, `${OFICIAL}/assets/img/logo-cf-branco.webp`, {
    headers: { Referer: "https://copia.example/", "Sec-Fetch-Dest": "image" },
  });
  // navegação: o Referer é de onde a pessoa veio
  await pedir(env, `${OFICIAL}/`, { headers: { Referer: "https://www.google.com/", "Sec-Fetch-Dest": "document" } });
  await pedir(env, `${OFICIAL}/assets/js/main.js`, { headers: { Referer: "https://www.google.com/", Accept: "text/html" } });
  const linhas = env.linhas();
  assert.deepEqual(linhas.map((l) => [l.dominio, l.sinais, l.visitas]), [["copia.example", "estilo,arquivo", 0]]);
});

test("o mesmo sinal de arquivo só regrava a linha depois de um minuto", async () => {
  const env = ambiente();
  const pedido = () => pedir(env, `${OFICIAL}/assets/img/simbolo-cf.png`, {
    headers: { Referer: "https://copia.example/", "Sec-Fetch-Dest": "image" },
  });
  await pedido();
  const antes = env.linhas()[0].ultimo_ts;
  env.DB.sqlite.exec(`UPDATE copias_pf SET ultimo_ts = ${antes - 30000}`);
  await pedido();
  assert.equal(env.linhas()[0].ultimo_ts, antes - 30000);
  env.DB.sqlite.exec(`UPDATE copias_pf SET ultimo_ts = ${antes - 61000}`);
  await pedido();
  assert.ok(env.linhas()[0].ultimo_ts >= antes);
});

test("envio de outro domínio para a coleta é recusado e registrado; o da própria LP passa", async () => {
  const env = ambiente();
  const fora = await pedir(env, `${OFICIAL}/api/coleta`, {
    method: "POST", headers: { Origin: "https://copia.example" }, body: "{}",
  });
  assert.equal(fora.status, 403);
  const workersDev = await pedir(env, `${OFICIAL}/api/coleta`, {
    method: "POST", headers: { Origin: "https://lp-black-institucional.gabrielrabelo87.workers.dev" }, body: "{}",
  });
  assert.equal(workersDev.status, 403);
  const daLp = await pedir(env, `${OFICIAL}/api/coleta`, {
    method: "POST", headers: { Origin: OFICIAL, "User-Agent": "Mozilla/5.0 (Windows NT 10.0)" }, body: JSON.stringify({ eventos: [] }),
  });
  assert.equal(daLp.status, 204);
  assert.deepEqual(env.linhas().map((l) => [l.dominio, l.sinais]), [["copia.example", "envio"]]);
});

test("o painel não quebra sem a tabela copias_pf", async () => {
  const env = ambiente();
  env.DB.sqlite.exec("DROP TABLE copias_pf");
  const r = await pedir(env, `${OFICIAL}/api/endereco`, {
    method: "POST", headers: { Origin: "https://copia.example" }, body: "{}",
  });
  assert.equal(r.status, 204);
});

test("a lista de domínios próprios é a mesma no Worker e no trecho do <head>", () => {
  const doWorker = codigoWorker.match(/const DOMINIOS_PROPRIOS = (\/.+\/);/)[1];
  const daPagina = pagina.match(/if\(!h\|\|(\/.+\/)\.test\(h\)\)return;/)[1];
  assert.equal(daPagina, doWorker);
});
