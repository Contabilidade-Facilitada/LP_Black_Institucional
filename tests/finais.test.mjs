// Páginas finais do Typeform (cloudflare/finais.js e as rotas /final/... e
// /api/final em cloudflare/worker.js).
// Rodar com: node --test tests/finais.test.mjs  (Node 22.5+, por causa do node:sqlite)
//
// O preenchimento da página (HTMLRewriter) só existe no Cloudflare; aqui
// ficam a coleta, a separação das tabelas e a leitura pelo painel.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LINKS_FINAIS, PAGINAS_FINAIS, lerPaginaFinal, linkSeguro } from "../cloudflare/finais.js";
import worker from "../cloudflare/worker.js";

const raiz = new URL("../", import.meta.url);
const schema = readFileSync(new URL("cloudflare/schema.sql", raiz), "utf8");
const modelo = readFileSync(new URL("final/index.html", raiz), "utf8");
const ORIGEM = "https://blacknovember.contabilidadefacilitada.com";
const NAVEGADOR = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

// D1 sobre o node:sqlite, só com o que o Worker usa nestas rotas
function d1(sql = schema) {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  const preparar = (texto) => {
    let valores = [];
    const comando = {
      bind(...v) { valores = v; return comando; },
      async run() { db.prepare(texto).run(...valores); return {}; },
      async all() { return { results: db.prepare(texto).all(...valores).map((l) => ({ ...l })) }; },
      async first() { const l = db.prepare(texto).get(...valores); return l ? { ...l } : null; },
      async raw() { const p = db.prepare(texto); p.setReturnArrays?.(true); return p.all(...valores).map((l) => (Array.isArray(l) ? l : Object.values(l))); },
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

const linhas = (db, tabela) => db.sqlite.prepare(`SELECT * FROM ${tabela} ORDER BY id`).all().map((l) => ({ ...l }));

function enviar(env, corpo, cabecalhos = {}) {
  return pedir(env, `${ORIGEM}/api/final`, {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "User-Agent": NAVEGADOR, Origin: ORIGEM, ...cabecalhos },
  });
}

test("os 4 endereços combinados com o Typeform, e nada além deles", () => {
  assert.deepEqual(PAGINAS_FINAIS, ["a/antecipar", "a/esperar", "b/antecipar", "b/esperar"]);
  assert.deepEqual(lerPaginaFinal("/final/b/esperar/"), { grupo: "b", intencao: "esperar", pagina: "b/esperar" });
  assert.deepEqual(lerPaginaFinal("/final/A/Antecipar"), { grupo: "a", intencao: "antecipar", pagina: "a/antecipar" });
  for (const c of ["/final/c/antecipar", "/final/a/sim", "/final/a", "/final/", "/final/final.js", "/lq/antecipar"]) {
    assert.equal(lerPaginaFinal(c), null, c);
  }
  assert.deepEqual(Object.keys(LINKS_FINAIS).sort(), ["a", "b"]);
});

test("link de botão só aceita http(s)", () => {
  assert.equal(linkSeguro("https://chat.whatsapp.com/abc"), "https://chat.whatsapp.com/abc");
  assert.equal(linkSeguro("javascript:alert(1)"), "");
  assert.equal(linkSeguro(""), "");
  assert.equal(linkSeguro("chat.whatsapp.com/abc"), "");
});

test("modelo tem um bloco por intenção, botão do grupo e link de compra só para antecipar", () => {
  assert.match(modelo, /data-so-intencao="antecipar"[^>]*aria-labelledby="titulo-antecipar"/);
  assert.match(modelo, /data-so-intencao="esperar"[^>]*aria-labelledby="titulo-esperar"/);
  assert.match(modelo, /data-link="grupo"/);
  assert.match(modelo, /data-link="compra" data-so-intencao="antecipar"/);
  assert.match(modelo, /GTM-ND2S8C9/);
  assert.match(modelo, /<meta name="robots" content="noindex, nofollow">/);
});

test("o modelo não sai sozinho, só pelos 4 endereços", async () => {
  const env = { DB: d1(), ASSETS: { fetch: async () => new Response("arquivo") } };
  for (const c of ["/final", "/final/", "/final/index.html", "/final/index"]) {
    assert.equal((await pedir(env, `${ORIGEM}${c}`)).status, 404, c);
  }
  // o CSS e o script da página seguem para os arquivos estáticos
  assert.equal(await (await pedir(env, `${ORIGEM}/final/final.css`)).text(), "arquivo");
});

test("acesso e cliques vão para finais_pf, sem tocar nas tabelas da LP", async () => {
  const env = { DB: d1() };
  const r = await enviar(env, {
    v: "vis-1",
    s: "ses-1",
    p: "b/antecipar",
    eventos: [
      {
        e: "page_view",
        dt: 0,
        ctx: { utm_source: "meta", utm_campaign: "bfn_black", lead_origin: "lp_black_november_2026_frios", pontuacao: "131", ref: "3rng23rvpr3.typeform.com" },
      },
      { e: "clique_grupo", dt: 0 },
      { e: "engajamento", n: 42.4, dt: 0 },
      // fora da lista: ignorado
      { e: "lead_esquenta_black", dt: 0 },
    ],
  }, { "CF-IPCountry": "BR" });
  assert.equal(r.status, 204);

  const gravadas = linhas(env.DB, "finais_pf");
  assert.deepEqual(gravadas.map((l) => l.evento), ["page_view", "clique_grupo", "engajamento"]);
  assert.ok(gravadas.every((l) => l.pagina === "b/antecipar" && l.visitante === "vis-1" && l.sessao === "ses-1"));
  const pv = gravadas[0];
  assert.equal(pv.utm_source, "meta");
  assert.equal(pv.utm_campaign, "bfn_black");
  assert.equal(pv.lead_origin, "lp_black_november_2026_frios");
  assert.equal(pv.pontuacao, 131);
  assert.equal(pv.dispositivo, "celular");
  assert.equal(gravadas[2].valor, 42);
  // contexto só no page_view
  assert.equal(gravadas[1].utm_source, null);

  assert.equal(linhas(env.DB, "eventos_pf").length, 0);
  assert.equal(linhas(env.DB, "cadastros_pf").length, 0);
});

test("coleta recusa página desconhecida, outra origem, GET e robôs", async () => {
  const env = { DB: d1() };
  const corpo = { v: "v", s: "s", p: "c/antecipar", eventos: [{ e: "page_view" }] };
  assert.equal((await enviar(env, corpo)).status, 400);
  assert.equal((await enviar(env, { ...corpo, p: "a/esperar" }, { Origin: "https://golpe.example" })).status, 403);
  assert.equal((await pedir(env, `${ORIGEM}/api/final`)).status, 405);
  assert.equal((await enviar(env, { ...corpo, p: "a/esperar" }, { "User-Agent": "Googlebot/2.1" })).status, 204);
  assert.equal(linhas(env.DB, "finais_pf").length, 0);
  // o envio de outro domínio fica registrado como possível cópia
  assert.deepEqual(todas(env.DB, "copias_pf").map((l) => l.dominio), ["golpe.example"]);
});

function todas(db, tabela) {
  return db.sqlite.prepare(`SELECT * FROM ${tabela}`).all().map((l) => ({ ...l }));
}

test("pontuação que não é número fica nula", async () => {
  const env = { DB: d1() };
  await enviar(env, { v: "v", s: "s", p: "a/esperar", eventos: [{ e: "page_view", ctx: { pontuacao: "abc" } }] });
  await enviar(env, { v: "v", s: "s2", p: "a/esperar", eventos: [{ e: "page_view", ctx: { pontuacao: "" } }] });
  assert.deepEqual(linhas(env.DB, "finais_pf").map((l) => l.pontuacao), [null, null]);
});

test("sem a tabela finais_pf (schema.sql ainda não rodou), a coleta responde 503", async () => {
  // banco criado antes desta versão do schema.sql
  const antigo = schema.slice(0, schema.indexOf("CREATE TABLE IF NOT EXISTS finais_pf"));
  const DB = d1(antigo);
  assert.equal((await enviar({ DB }, { v: "v", s: "s", p: "a/esperar", eventos: [{ e: "page_view" }] })).status, 503);
  assert.equal(linhas(DB, "eventos_pf").length, 0);
});
