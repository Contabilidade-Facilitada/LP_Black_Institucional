// Rota /api/metricas-gateway (cloudflare/worker.js), lida pelo Data Gateway.
// Rodar com: node --test tests/metricas-gateway.test.mjs  (Node 22.5+, por causa do node:sqlite)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const worker = readFileSync(new URL("../cloudflare/worker.js", import.meta.url), "utf8");
function sql(nome) {
  const trecho = worker.match(new RegExp(`const ${nome} = \`([^\`]+)\`;`));
  assert.ok(trecho, `${nome} ausente`);
  return trecho[1];
}
const ms = (iso) => Date.parse(iso);
const PESSOAIS = ["nome", "email", "telefone", "visitante", "sessao"];

function banco() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE eventos_pf (
      id INTEGER PRIMARY KEY, ts INTEGER, evento TEXT, visitante TEXT,
      sessao TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
      dispositivo TEXT
    );
    CREATE TABLE cadastros_pf (
      ts INTEGER, visitante TEXT, utm_source TEXT, utm_medium TEXT,
      utm_campaign TEXT, dispositivo TEXT, nome TEXT, email TEXT, telefone TEXT
    );
  `);
  return db;
}

test("agrega todos os eventos além de 10 mil linhas, por dia de Brasília, sem dados pessoais", () => {
  const db = banco();
  const inserir = db.prepare("INSERT INTO eventos_pf VALUES (?, ?, 'page_view', ?, ?, 'meta', 'cpc', 'black', 'celular')");
  db.exec("BEGIN");
  for (let i = 1; i <= 10000; i++) inserir.run(i, ms("2026-10-30T21:00:00Z"), `v${i}`, `s${i}`);
  db.exec("COMMIT");
  // 00:30 UTC de 31/10 ainda é 30/10 em Brasília; 03:30 UTC já é 31/10
  db.prepare("INSERT INTO eventos_pf VALUES (10001, ?, 'page_view', 'v1', 's10001', 'email', 'crm', 'black', 'computador')")
    .run(ms("2026-10-31T03:30:00Z"));
  // a abertura não tem UTMs: herda as da primeira página da sessão
  db.prepare("INSERT INTO eventos_pf (ts, evento, visitante, sessao) VALUES (?, 'lead_form_aberto', 'v1', 's1')")
    .run(ms("2026-10-30T21:00:00Z"));
  db.prepare("INSERT INTO eventos_pf (ts, evento, visitante, sessao) VALUES (?, 'lead_form_aberto', 'v1', 's1')")
    .run(ms("2026-10-31T00:30:00Z"));
  db.prepare("INSERT INTO cadastros_pf VALUES (?, 'v1', 'meta', 'cpc', 'black', 'celular', 'Pessoa Teste', 'pessoa@example.com', '11900000000')")
    .run(ms("2026-10-30T21:00:00Z"));

  const linhas = db.prepare(sql("SQL_METRICAS_GATEWAY")).all();
  const totais = db.prepare(sql("SQL_TOTAIS_GATEWAY")).get();
  assert.deepEqual({ ...totais }, { acessos: 10001, visitantes_unicos: 10000, formularios_abertos: 1, cadastros: 1 });

  const dia30 = linhas.find((l) => l.dia === "2026-10-30");
  assert.deepEqual(
    [dia30.cor, dia30.utm_source, dia30.dispositivo, dia30.acessos, dia30.visitantes_unicos, dia30.formularios_abertos, dia30.cadastros],
    [null, "meta", "celular", 10000, 10000, 1, 1],
  );
  const dia31 = linhas.find((l) => l.dia === "2026-10-31");
  assert.deepEqual([dia31.utm_source, dia31.acessos, dia31.visitantes_unicos], ["email", 1, 1]);
  for (const linha of linhas) {
    assert.deepEqual(Object.keys(linha).sort(), [
      "acessos", "cadastros", "cor", "dia", "dispositivo", "formularios_abertos",
      "utm_campaign", "utm_medium", "utm_source", "visitantes_unicos",
    ]);
  }
  db.close();
});

test("rota exige token e entrega apenas o agregado", async () => {
  const { default: app } = await import(`data:text/javascript;base64,${Buffer.from(worker).toString("base64")}`);
  const db = banco();
  db.prepare("INSERT INTO eventos_pf VALUES (1, ?, 'page_view', 'v1', 's1', 'meta', 'cpc', 'black', 'celular')")
    .run(ms("2026-10-30T12:00:00Z"));
  db.prepare("INSERT INTO cadastros_pf VALUES (?, 'v1', 'meta', 'cpc', 'black', 'celular', 'Pessoa Teste', 'pessoa@example.com', '11900000000')")
    .run(ms("2026-10-30T12:01:00Z"));
  const env = {
    DB: {
      prepare(query) {
        const stmt = db.prepare(query);
        return {
          async all() { return { results: stmt.all() }; },
          async first() { return stmt.get(); },
        };
      },
    },
    ADMIN_CHAVE: "chave-admin-de-teste",
    GATEWAY_METRICAS_CHAVE: "token-de-teste",
  };
  const url = "https://blacknovember.contabilidadefacilitada.com/api/metricas-gateway";

  assert.equal((await app.fetch(new Request(url), env)).status, 401);
  const errado = new Request(url, { headers: { Authorization: "Bearer outro-token" } });
  assert.equal((await app.fetch(errado, env)).status, 401);
  const semSegredo = new Request(url, { headers: { Authorization: "Bearer token-de-teste" } });
  assert.equal((await app.fetch(semSegredo, { ...env, GATEWAY_METRICAS_CHAVE: undefined })).status, 503);

  const resposta = await app.fetch(new Request(url, { headers: { Authorization: "Bearer token-de-teste" } }), env);
  assert.equal(resposta.status, 200);
  assert.equal(resposta.headers.get("Cache-Control"), "no-store");
  const corpo = await resposta.json();
  assert.equal(corpo.completo, true);
  assert.equal(typeof corpo.agora, "number");
  assert.equal(corpo.totais.acessos, 1);
  assert.equal(corpo.totais.cadastros, 1);
  assert.equal(corpo.linhas[0].cadastros, 1);
  assert.equal(corpo.linhas[0].cor, null);
  for (const pessoal of PESSOAIS) {
    assert.equal(Object.hasOwn(corpo.linhas[0], pessoal), false);
    assert.equal(JSON.stringify(corpo).includes("pessoa@example.com"), false);
  }
  db.close();
});
