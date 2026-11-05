// Rota /admin/api/campanhas (cloudflare/worker.js): o funil das mesmas
// campanhas na LP Esquenta Black, para a aba Campanhas do painel.
// Rodar com: node --test tests/campanhas.test.mjs  (Node 22.5+, por causa do node:sqlite)
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const worker = readFileSync(new URL("../cloudflare/worker.js", import.meta.url), "utf8");
const { default: app } = await import(new URL(`../cloudflare/worker.js?instancia=${Date.now()}`, import.meta.url).href);
const ms = (iso) => Date.parse(iso);

// cache do Cloudflare (caches.default) em memória
const guardadas = new Map();
globalThis.caches = {
  default: {
    async match(chave) { return guardadas.get(chave)?.clone(); },
    async put(chave, r) { guardadas.set(chave, r.clone()); },
  },
};

function banco() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, evento TEXT NOT NULL,
      visitante TEXT, sessao TEXT, utm_campaign TEXT, utm_content TEXT);
    CREATE TABLE cadastros (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, nome TEXT, email TEXT,
      visitante TEXT, sessao TEXT, utm_campaign TEXT, utm_content TEXT);
  `);
  return db;
}

// o suficiente da API do D1, contando as linhas lidas como o D1 cobra
function d1(db, lidas) {
  const preparar = (sql) => {
    let params = [];
    const executar = () => {
      const stmt = db.prepare(sql);
      const linhas = stmt.all(...params);
      lidas.push(sql);
      return { results: linhas };
    };
    const st = {
      bind(...p) { params = p; return st; },
      async all() { return executar(); },
      async first() { return executar().results[0] ?? null; },
      executar,
    };
    return st;
  };
  return { prepare: preparar, async batch(lista) { return lista.map((s) => s.executar()); } };
}

const env = (DB) => ({ DB, ADMIN_EMAIL: "painel@example.com", ADMIN_SENHA: "senha-de-teste", ADMIN_CHAVE: "chave-de-teste" });

function cookieValido(e) {
  const validade = String(Math.floor(Date.now() / 1000) + 3600);
  const assinatura = createHmac("sha256", e.ADMIN_CHAVE).update(`sessao|${validade}|${e.ADMIN_SENHA}`).digest("base64url");
  return `cf_black_pf_painel=${validade}.${assinatura}`;
}

function pedido(e, consulta) {
  return new Request(`https://blacknovember.contabilidadefacilitada.com/admin/api/campanhas?${consulta}`, {
    headers: { Cookie: cookieValido(e) },
  });
}

test("funil das campanhas na Esquenta, só no período, com a abertura herdando a UTM da sessão", async () => {
  guardadas.clear();
  const db = banco();
  const ev = db.prepare("INSERT INTO eventos (ts, evento, visitante, sessao, utm_campaign, utm_content) VALUES (?, ?, ?, ?, ?, ?)");
  const cad = db.prepare("INSERT INTO cadastros (ts, nome, email, visitante, sessao, utm_campaign, utm_content) VALUES (?, 'Pessoa', 'p@example.com', ?, ?, ?, ?)");
  db.exec("BEGIN");
  // histórico antigo e grande: não pode entrar na soma (os ids crescem com o tempo)
  cad.run(ms("2026-10-01T12:00:00Z"), "antigo1", "sa1", "camp", "conj_agrupado");
  for (let i = 0; i < 5000; i++) ev.run(ms("2026-10-01T12:00:00Z") + i * 1000, "page_view", `antigo${i}`, `sa${i}`, "camp", "conj_agrupado");
  // período: 3 visitantes no conjunto agrupado, 1 no outro; 2 abrem o formulário
  const t = ms("2026-10-31T12:00:00Z");
  ev.run(t, "page_view", "v1", "s1", "camp", "conj_agrupado");
  ev.run(t + 1, "lead_form_aberto", "v1", "s1", null, null);
  ev.run(t + 2, "page_view", "v2", "s2", "camp", "conj_agrupado");
  ev.run(t + 3, "page_view", "v2", "s2b", "camp", "conj_agrupado"); // segunda visita, mesma pessoa
  ev.run(t + 4, "page_view", "v3", "s3", "camp", "conj_agrupado");
  ev.run(t + 5, "lead_form_aberto", "v3", "s3", null, null);
  ev.run(t + 6, "page_view", "v4", "s4", "camp", "conj_motion");
  ev.run(t + 7, "page_view", "v5", "s5", "outra", "x"); // campanha que não foi pedida
  cad.run(t + 8, "v1", "s1", "camp", "conj_agrupado");
  db.exec("COMMIT");

  const lidas = [];
  const e = env(d1(db, lidas));
  const consulta = `ini=${ms("2026-10-30T03:00:00Z")}&fim=${ms("2026-11-02T03:00:00Z")}&c=camp`;
  const r = await app.fetch(pedido(e, consulta), e);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  const corpo = await r.json();
  assert.equal(corpo.gasto, null);
  const linhas = Object.fromEntries(corpo.esquenta.map((l) => [l.conjunto, l]));
  assert.deepEqual(linhas.conj_agrupado, { campanha: "camp", conjunto: "conj_agrupado", visitantes: 3, formulario: 2, cadastros: 1 });
  assert.deepEqual(linhas.conj_motion, { campanha: "camp", conjunto: "conj_motion", visitantes: 1, formulario: 0, cadastros: 0 });
  assert.equal(corpo.esquenta.some((l) => l.campanha === "outra"), false);
  assert.equal(JSON.stringify(corpo).includes("p@example.com"), false);

  // a segunda chamada igual sai do cache, sem tocar no banco
  const antes = lidas.length;
  const deNovo = await app.fetch(pedido(e, consulta), e);
  assert.equal(deNovo.status, 200);
  assert.equal(lidas.length, antes);
  assert.deepEqual(await deNovo.json(), corpo);
  db.close();
});

test("a busca binária acha o primeiro id do período", async () => {
  const db = banco();
  const ev = db.prepare("INSERT INTO eventos (ts, evento) VALUES (?, 'page_view')");
  db.exec("BEGIN");
  for (let i = 0; i < 100000; i++) ev.run(1000 + i * 10);
  db.exec("COMMIT");
  const sqlCorte = worker.match(/const sqlCorte = \(tabela\) => `([^`]+)`;/)[1].replaceAll("${tabela}", "eventos");
  for (const [limite, esperado] of [[0, 1], [1000, 1], [1005, 2], [500990, 50000], [1000990, 100000], [2000000, 100001]]) {
    assert.equal(db.prepare(sqlCorte).get(limite).corte, esperado, `limite ${limite}`);
  }
  db.close();
});

test("sem sessão, 401; sem campanhas, lista vazia sem consultar o banco", async () => {
  const db = banco();
  const lidas = [];
  const e = env(d1(db, lidas));
  const semSessao = await app.fetch(new Request("https://blacknovember.contabilidadefacilitada.com/admin/api/campanhas?c=camp"), e);
  assert.equal(semSessao.status, 401);
  const vazia = await app.fetch(pedido(e, "ini=0&fim=1"), e);
  assert.deepEqual(await vazia.json(), { esquenta: [], gasto: null });
  assert.equal(lidas.length, 0);
  db.close();
});
