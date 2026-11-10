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

import { LINKS_FINAIS, PAGINAS_FINAIS, TIPOS_LINK, lerPaginaFinal, linkSeguro } from "../cloudflare/finais.js";
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
  assert.deepEqual(Object.keys(LINKS_FINAIS).sort(), [...PAGINAS_FINAIS].sort());
});

test("link de botão só aceita http(s)", () => {
  assert.equal(linkSeguro("https://chat.whatsapp.com/abc"), "https://chat.whatsapp.com/abc");
  assert.equal(linkSeguro("javascript:alert(1)"), "");
  assert.equal(linkSeguro(""), "");
  assert.equal(linkSeguro("chat.whatsapp.com/abc"), "");
});

// blocos com data-so-pagina, na ordem do modelo: [lista de páginas, html do bloco]
function blocosDoModelo() {
  return [...modelo.matchAll(/<section class="bloco" data-so-pagina="([^"]+)"[\s\S]*?<\/section>/g)]
    .map((m) => [m[1].split(/\s+/), m[0]]);
}

test("cada página tem exatamente um bloco de texto; nas \"antecipar\" o especialista vem antes do grupo", () => {
  const blocos = blocosDoModelo();
  for (const p of PAGINAS_FINAIS) {
    const dela = blocos.filter(([lista]) => lista.includes(p));
    assert.equal(dela.length, 1, p);
    const [, html] = dela[0];
    assert.match(html, /data-link="grupo"/, `${p}: botão do grupo`);
    const antecipar = p.endsWith("antecipar");
    assert.equal(/data-link="especialista"/.test(html), antecipar, `${p}: especialista`);
    if (antecipar) assert.ok(html.indexOf('data-link="especialista"') < html.indexOf('data-link="grupo"'), p);
  }
  // cada botão com link tem ao lado o ícone do QR Code do mesmo link
  const acoes = [...modelo.matchAll(/<div class="acao">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.equal(acoes.length, (modelo.match(/<a [^>]*data-link=/g) || []).length);
  for (const a of acoes) {
    const tipo = a.match(/data-link="([a-z]+)"/)[1];
    assert.match(a, new RegExp(`<button class="qr-botao" type="button" data-qr-para="${tipo}"[^>]* hidden>`), tipo);
  }
  // uma janela flutuante só, preenchida na hora do clique
  assert.equal((modelo.match(/<dialog class="qr-janela"/g) || []).length, 1);
  // nenhum link pronto no modelo: todos vêm de cloudflare/finais.js
  assert.doesNotMatch(modelo, /<a [^>]*data-link="[^"]+"[^>]*href=/);
  assert.match(modelo, /No grupo você receberá:/);
  assert.match(modelo, /GTM-ND2S8C9/);
  assert.match(modelo, /<meta name="robots" content="noindex, nofollow">/);
});

test("lista \"No grupo você receberá\": uma por página, com os itens do documento", () => {
  const listas = [...modelo.matchAll(/<ul class="beneficios__lista[^"]*" data-so-pagina="([^"]+)">([\s\S]*?)<\/ul>/g)]
    .map((m) => [m[1].split(/\s+/), [...m[2].matchAll(/<\/span>([^<]+)<\/li>/g)].map((i) => i[1])]);
  const itens = (p) => {
    const dela = listas.filter(([lista]) => lista.includes(p));
    assert.equal(dela.length, 1, p);
    return dela[0][1];
  };
  const base = ["Materiais e ferramentas de bônus", "Possibilidade de antecipação da matrícula", "Informações e links importantes"];
  assert.deepEqual(itens("a/antecipar"), [...base, "Tabela CST", "Ebook da Reforma Tributária", "Consulta Alíquota ISS"]);
  assert.deepEqual(itens("b/antecipar"), base);
  for (const p of ["a/esperar", "b/esperar"]) assert.deepEqual(itens(p), [base[0], base[2]]);
});

test("cada página tem exatamente os links dos botões dela, todos válidos (https)", () => {
  assert.deepEqual(TIPOS_LINK, ["grupo", "especialista"]);
  assert.deepEqual(Object.keys(LINKS_FINAIS).sort(), [...PAGINAS_FINAIS].sort());
  const blocos = blocosDoModelo();
  for (const p of PAGINAS_FINAIS) {
    const [, html] = blocos.find(([lista]) => lista.includes(p));
    const tipos = [...html.matchAll(/data-link="([a-z]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(Object.keys(LINKS_FINAIS[p]).sort(), tipos, p);
    for (const t of tipos) assert.match(linkSeguro(LINKS_FINAIS[p][t]), /^https:\/\//, `${p} ${t}`);
  }
  // os links que o time enviou, por página (o grupo muda de página para página)
  assert.equal(LINKS_FINAIS["a/antecipar"].grupo, "https://sndflw.pro/i/black-november-2026-antecipacao");
  assert.equal(LINKS_FINAIS["a/esperar"].grupo, "https://sndflw.pro/i/black-november-2026");
  assert.equal(LINKS_FINAIS["b/antecipar"].grupo, "https://cfaci.me/black-november-2026-antecipacao");
  assert.equal(LINKS_FINAIS["b/esperar"].grupo, "https://ec.cfaci.me/black-november-2026");
});

test("frase de apoio uma vez só, no rodapé (igual nas 4 páginas), e não nos blocos", () => {
  const frase = /Essa é a oportunidade para você <strong>transformar<\/strong> sua carreira com as melhores condições que já fizemos\./g;
  assert.equal((modelo.match(frase) || []).length, 1);
  assert.match(modelo, /<footer class="rodape">\s*<p class="rodape__texto">Essa é a oportunidade/);
  for (const [, html] of blocosDoModelo()) assert.doesNotMatch(html, /Essa é a oportunidade/);
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
      { e: "clique_especialista", dt: 0 },
      { e: "qr_grupo", dt: 0 },
      { e: "clique_grupo", dt: 0 },
      { e: "engajamento", n: 42.4, dt: 0 },
      // fora da lista: ignorado
      { e: "lead_esquenta_black", dt: 0 },
      { e: "clique_compra", dt: 0 },
    ],
  }, { "CF-IPCountry": "BR" });
  assert.equal(r.status, 204);

  const gravadas = linhas(env.DB, "finais_pf");
  assert.deepEqual(gravadas.map((l) => l.evento), ["page_view", "clique_especialista", "qr_grupo", "clique_grupo", "engajamento"]);
  assert.ok(gravadas.every((l) => l.pagina === "b/antecipar" && l.visitante === "vis-1" && l.sessao === "ses-1"));
  const pv = gravadas[0];
  assert.equal(pv.utm_source, "meta");
  assert.equal(pv.utm_campaign, "bfn_black");
  assert.equal(pv.lead_origin, "lp_black_november_2026_frios");
  assert.equal(pv.pontuacao, 131);
  assert.equal(pv.dispositivo, "celular");
  assert.equal(gravadas[4].valor, 42);
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
