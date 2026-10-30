/**
 * Cloudflare Worker — serve a landing page da Black November 2026 (PF) e o
 * painel dela.
 *
 * A página é publicada pelo próprio Cloudflare (Workers com arquivos
 * estáticos, ver wrangler.jsonc na raiz): os arquivos do repositório chegam
 * aqui por env.ASSETS. O Worker roda antes deles em toda requisição, para
 * guardar a medição própria da LP e proteger o painel:
 *
 *   POST /api/coleta     acessos e eventos do dataLayer (público)
 *   POST /api/cadastro   cópia de cada cadastro da Lista VIP (público)
 *   POST /api/gravacao   partes da gravação de uma visita (público)
 *   GET  /admin/         painel (exige login)
 *   GET  /admin/api/sync dados do painel (idem)
 *   GET  /admin/entrar   tela de login (e-mail e senha)
 *   GET  /admin/sair     encerra a sessão
 *
 * Mesmo desenho do Worker da LP Esquenta Black (repositório
 * LP_EsquentaBlack2026), sem o teste A/B e sem o desvio para a DigitalOcean.
 *
 * BANCO
 * Usa o mesmo D1 da Esquenta Black ("lp-black"), com tabelas próprias
 * (eventos_pf, cadastros_pf, gravacoes_pf, tentativas_pf): os dois painéis
 * não se misturam e o Worker da Esquenta Black não precisa mudar. Criar as
 * tabelas uma vez com cloudflare/schema.sql (instruções no arquivo).
 *
 * SEGREDOS (Worker > Settings > Variables and Secrets > tipo Secret, ou
 * npx wrangler secret put NOME):
 *   ADMIN_EMAIL  e-mail que entra no painel
 *   ADMIN_SENHA  senha do painel
 *   ADMIN_CHAVE  texto aleatório longo, que assina a sessão; trocar este
 *                valor (ou a senha) desconecta todo mundo
 *
 * O e-mail e a senha ficam só nos segredos, nunca neste arquivo. Sem algum
 * segredo ou sem o banco, o painel responde 503 (falha fechada), nunca aberto.
 *
 * Contra quem tenta adivinhar a senha: 5 erros seguidos bloqueiam aquele
 * endereço de internet por 15 minutos, e 30 erros numa hora (de qualquer
 * endereço) fecham o login por até 1 hora, inclusive para quem tem a senha.
 */

// Linhas por resposta da sincronização do painel. A primeira carga pede
// páginas seguidas até alcançar o fim; depois disso cada atualização traz só o
// que chegou desde a anterior.
const LINHAS_POR_PAGINA = 10000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const caminho = url.pathname;

    // A página do painel referencia tudo por caminho relativo ("admin.css").
    // Em /admin, sem barra, o navegador resolveria isso para /admin.css, fora
    // da pasta. Por isso a URL sem barra vai para a versão com barra.
    if (caminho === "/admin") {
      return Response.redirect(`${url.origin}/admin/${url.search}`, 301);
    }

    if (caminho === "/api/coleta" || caminho === "/api/cadastro") {
      return receber(request, env, url, caminho === "/api/cadastro");
    }

    if (caminho === "/api/gravacao") {
      return receberGravacao(request, env, url);
    }

    if (caminho.startsWith("/admin/")) {
      return painel(request, env, url, caminho);
    }

    // configuração do Worker e do deploy não sai por este domínio (o
    // .assetsignore já deixa esses arquivos de fora; isto é a segunda trava)
    if (/^\/(cloudflare|\.git|\.wrangler|node_modules)(\/|$)|^\/(\.gitignore|\.assetsignore|wrangler\.jsonc?)$/.test(caminho)) {
      return resposta(404);
    }

    // A LP vista pelo mapa de cliques do painel: sem nenhum script nem o
    // <noscript> do GTM, para abrir o mapa não contar como acesso nem
    // disparar tags. Sem script a página fica na versão "sem-js", com todo o
    // conteúdo visível (ver style.css). As animações também saem: as de
    // entrada deslocam os elementos por um instante, e o painel mediria a
    // posição errada.
    if ((caminho === "/" || caminho === "/index.html") && url.searchParams.get("mapa") === "1") {
      const pagina = await env.ASSETS.fetch(new Request(new URL("/", url), request));
      const limpa = new HTMLRewriter()
        .on("script", { element: (el) => el.remove() })
        .on("noscript", { element: (el) => el.remove() })
        .on("head", {
          element: (el) => el.append(
            // a LP encaixa a rolagem nas seções (scroll-snap) e rola suave:
            // o painel precisa levar a página ao pixel exato da gravação
            "<style>*,*::before,*::after{animation:none!important;transition:none!important}" +
            "html{scroll-snap-type:none!important;scroll-behavior:auto!important}</style>",
            { html: true },
          ),
        })
        .transform(pagina);
      const r = new Response(limpa.body, limpa);
      r.headers.set("Cache-Control", "no-store");
      r.headers.set("X-Robots-Tag", "noindex, nofollow");
      return r;
    }

    return env.ASSETS.fetch(request);
  },
};

/* ---------------------------------------------------------------------------
   Coleta pública: acessos, eventos e cadastros vindos de assets/js/main.js
   --------------------------------------------------------------------------- */

const ROBOS = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp|python|curl|wget/i;
const NOME_EVENTO = /^[\w.\-:]{1,60}$/;
const RETENCAO_GRAVACOES_MS = 15 * 86400000;

// Partes da gravação de uma visita (ver main.js). A primeira parte também
// vira um evento "gravacao", para o painel saber quais visitas foram gravadas
// sem precisar baixar as gravações; cada uma só é baixada quando aberta.
async function receberGravacao(request, env, url) {
  if (request.method !== "POST") return resposta(405);
  if (!env.DB) return resposta(503);
  const origemDeclarada = request.headers.get("Origin");
  if (origemDeclarada && origemDeclarada !== url.origin) return resposta(403);
  const agente = request.headers.get("User-Agent") || "";
  if (ROBOS.test(agente) || ehRoboMeta(agente) || ehRedeMeta(request)) return resposta(204);

  const texto = await request.text();
  if (texto.length > 24000) return resposta(413);
  let g;
  try { g = JSON.parse(texto); } catch { return resposta(400); }
  const sessao = corte(g?.s, 64);
  const seq = Number(g?.seq);
  if (!sessao || !Number.isInteger(seq) || seq < 0 || seq > 300 || typeof g.d !== "string") return resposta(400);

  const agora = Date.now();
  const inteiro = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const visitante = corte(g.v, 64);
  const comandos = [
    env.DB.prepare("INSERT INTO gravacoes_pf (ts, sessao, visitante, seq, inicio, largura, altura, altura_doc, dados) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(agora, sessao, visitante, seq, inteiro(g.ini), inteiro(g.w), inteiro(g.h), inteiro(g.dh), g.d.slice(0, 20000)),
  ];
  if (seq === 0) {
    comandos.push(env.DB.prepare("INSERT INTO eventos_pf (ts, evento, visitante, sessao) VALUES (?, 'gravacao', ?, ?)")
      .bind(agora, visitante, sessao));
  }
  // de vez em quando, apaga as gravações vencidas
  if (Math.random() < 0.01) {
    comandos.push(env.DB.prepare("DELETE FROM gravacoes_pf WHERE ts < ?").bind(agora - RETENCAO_GRAVACOES_MS));
  }
  await env.DB.batch(comandos);
  return resposta(204);
}

// A revisão automática de anúncios da Meta abre a página com um agente que se
// diz Facebook mas não informa sistema operacional (vista nos dados da
// Esquenta Black vinda de centros de dados nos EUA, na Irlanda e na Suécia).
const ehRoboMeta = (agente) => /FBAN|FBAV|FB_IAB/i.test(agente)
  && !/iPhone|iPad|iPod|Android|Windows|Mac OS X|Macintosh|Linux|CrOS/i.test(agente);

// Outros robôs da Meta se passam por celular (Instagram no Android, por
// exemplo) mas saem da rede da própria Meta (ASN 32934). Pessoas de verdade
// não navegam por essa rede.
const ehRedeMeta = (request) => request.cf?.asn === 32934;

async function receber(request, env, url, ehCadastro) {
  if (request.method !== "POST") return resposta(405);
  if (!env.DB) return resposta(503);

  // os envios saem da própria LP; qualquer outra origem declarada é recusada
  const origemDeclarada = request.headers.get("Origin");
  if (origemDeclarada && origemDeclarada !== url.origin) return resposta(403);

  const agente = request.headers.get("User-Agent") || "";
  if (ROBOS.test(agente) || ehRoboMeta(agente) || ehRedeMeta(request)) return resposta(204);

  const texto = await request.text();
  if (texto.length > 16000) return resposta(413);
  let dados;
  try { dados = JSON.parse(texto); } catch { return resposta(400); }
  if (!dados || typeof dados !== "object") return resposta(400);

  const agora = Date.now();
  const base = {
    visitante: corte(dados.v, 64),
    sessao: corte(dados.s, 64),
  };

  if (ehCadastro) {
    const c = dados.cadastro || {};
    // a tabela de cadastros guarda a URL completa (url) em vez da página
    const { pagina, ...origem } = contexto(dados.ctx);
    await inserir(env.DB, "cadastros_pf", {
      ts: agora,
      ...base,
      nome: corte(c.nome, 120),
      email: corte(String(c.email || "").toLowerCase(), 160),
      telefone: corte(String(c.telefone || "").replace(/\D/g, ""), 20),
      cta: corte(c.cta, 60),
      url: corte(c.url, 1000),
      ...origem,
      ...ambiente(request, agente),
    });
    return resposta(204);
  }

  const lista = Array.isArray(dados.eventos) ? dados.eventos.slice(0, 25) : [];
  const linhas = [];
  for (const e of lista) {
    if (!e || !NOME_EVENTO.test(e.e || "")) continue;
    // "dt" é há quantos milissegundos o evento aconteceu no navegador (a fila
    // espera um pouco antes de enviar); limitado a 10 minutos
    const atraso = Math.min(Math.max(Number(e.dt) || 0, 0), 600000);
    const linha = {
      ts: agora - atraso,
      evento: e.e,
      ...base,
      // o clique leva o caminho do elemento e a posição (ver main.js)
      detalhe: corte(e.d, e.e === "clique" ? 700 : 200),
      valor: Number.isFinite(Number(e.n)) ? Math.round(Number(e.n)) : null,
    };
    if (e.e === "page_view") Object.assign(linha, contexto(e.ctx), ambiente(request, agente));
    linhas.push(linha);
  }
  if (linhas.length) await inserirVarias(env.DB, "eventos_pf", linhas);
  return resposta(204);
}

function contexto(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  return {
    pagina: corte(c.pagina, 300),
    referencia: corte(c.ref, 120),
    utm_source: corte(c.utm_source, 150),
    utm_medium: corte(c.utm_medium, 150),
    utm_campaign: corte(c.utm_campaign, 200),
    utm_content: corte(c.utm_content, 200),
    utm_term: corte(c.utm_term, 200),
    clique: corte(c.clique, 20),
  };
}

// dispositivo e navegador pelo User-Agent; local pela geolocalização do
// Cloudflare (país, sigla do estado e cidade)
function ambiente(request, agente) {
  const geo = request.cf || {};
  return {
    // Android sem "Mobile" em lugar nenhum é tablet. Não basta olhar o que vem
    // depois de "Android": o navegador do Instagram repete "Android" no fim do
    // texto, depois do "Mobile", e celulares passavam por tablet.
    dispositivo: /iPad|Tablet/i.test(agente) || (/Android/i.test(agente) && !/Mobi/i.test(agente)) ? "tablet"
      : /Mobi|iPhone|Android/i.test(agente) ? "celular" : "computador",
    navegador: /Instagram/i.test(agente) ? "Instagram"
      : /FBAN|FBAV|FB_IAB/i.test(agente) ? "Facebook"
      : /Edg\//i.test(agente) ? "Edge"
      : /OPR\//i.test(agente) ? "Opera"
      : /SamsungBrowser/i.test(agente) ? "Samsung"
      : /CriOS|Chrome/i.test(agente) ? "Chrome"
      : /FxiOS|Firefox/i.test(agente) ? "Firefox"
      : /Safari/i.test(agente) ? "Safari" : "Outro",
    sistema: /Windows/i.test(agente) ? "Windows"
      : /iPhone|iPad|iPod/i.test(agente) ? "iOS"
      : /Android/i.test(agente) ? "Android"
      : /Mac OS X|Macintosh/i.test(agente) ? "macOS"
      : /Linux|CrOS/i.test(agente) ? "Linux" : "Outro",
    pais: corte(geo.country, 4),
    estado: corte(geo.regionCode, 8),
    cidade: corte(geo.city, 80),
  };
}

function corte(valor, limite) {
  if (valor === undefined || valor === null || valor === "") return null;
  return String(valor).slice(0, limite);
}

function inserir(db, tabela, linha) {
  const colunas = Object.keys(linha);
  return db
    .prepare(`INSERT INTO ${tabela} (${colunas.join(",")}) VALUES (${colunas.map(() => "?").join(",")})`)
    .bind(...colunas.map((c) => linha[c] ?? null))
    .run();
}

function inserirVarias(db, tabela, linhas) {
  return db.batch(linhas.map((linha) => {
    const colunas = Object.keys(linha);
    return db
      .prepare(`INSERT INTO ${tabela} (${colunas.join(",")}) VALUES (${colunas.map(() => "?").join(",")})`)
      .bind(...colunas.map((c) => linha[c] ?? null));
  }));
}

/* ---------------------------------------------------------------------------
   Painel: login por e-mail e senha, e sincronização dos dados
   --------------------------------------------------------------------------- */

const COLUNAS_EVENTOS = [
  "id", "ts", "evento", "visitante", "sessao", "detalhe", "valor",
  "pagina", "referencia", "utm_source", "utm_medium", "utm_campaign",
  "utm_content", "utm_term", "clique", "dispositivo", "navegador", "sistema",
  "pais", "estado", "cidade",
];
const COLUNAS_CADASTROS = [
  "id", "ts", "nome", "email", "telefone", "visitante", "sessao", "cta",
  "referencia", "utm_source", "utm_medium", "utm_campaign", "utm_content",
  "utm_term", "clique", "url", "dispositivo", "navegador", "sistema", "pais",
  "estado", "cidade",
];

const COOKIE = "cf_black_pf_painel";
const LEMBRAR_S = 90 * 86400; // "lembrar este computador"
const SESSAO_CURTA_S = 12 * 3600; // sem lembrar: até fechar o navegador, no máximo 12 horas
const ERROS_POR_IP = 5;
const JANELA_IP_MS = 15 * 60000;
const ERROS_GERAIS = 30;
const JANELA_GERAL_MS = 60 * 60000;

async function painel(request, env, url, caminho) {
  if (!env.ADMIN_EMAIL || !env.ADMIN_SENHA || !env.ADMIN_CHAVE || !env.DB) {
    return protegido(textoSimples("Painel não configurado: faltam segredos (ADMIN_EMAIL, ADMIN_SENHA, ADMIN_CHAVE) ou o banco (DB).", 503));
  }

  // o estilo também serve à tela de login, que vem antes da sessão
  if (caminho === "/admin/admin.css") return protegido(await env.ASSETS.fetch(request));
  if (caminho === "/admin/entrar") return entrar(request, env, url);
  if (caminho === "/admin/sair") return sair(url);

  if (!(await sessaoValida(request, env))) {
    if (caminho.startsWith("/admin/api/")) return protegido(json({ erro: "Sessão expirada." }, 401));
    return protegido(redirecionar(`${url.origin}/admin/entrar`));
  }

  if (caminho === "/admin/api/gravacao") {
    const sessao = url.searchParams.get("sessao") || "";
    const { results } = await env.DB
      .prepare("SELECT seq, inicio, largura, altura, altura_doc, dados FROM gravacoes_pf WHERE sessao = ? ORDER BY seq, id")
      .bind(sessao)
      .all();
    return protegido(json({ partes: results }));
  }

  if (caminho === "/admin/api/sync") {
    const aposEventos = Math.max(0, Number(url.searchParams.get("eventos")) || 0);
    const aposCadastros = Math.max(0, Number(url.searchParams.get("cadastros")) || 0);
    const [eventos, cadastros] = await Promise.all([
      pagina(env.DB, "eventos_pf", COLUNAS_EVENTOS, aposEventos),
      pagina(env.DB, "cadastros_pf", COLUNAS_CADASTROS, aposCadastros),
    ]);
    return protegido(json({ agora: Date.now(), email: env.ADMIN_EMAIL, eventos, cadastros }));
  }

  if (caminho.startsWith("/admin/api/")) return protegido(json({ erro: "Não encontrado." }, 404));

  // arquivos do painel (admin/index.html, admin.js) vêm dos arquivos estáticos
  return protegido(await env.ASSETS.fetch(request));
}

async function entrar(request, env, url) {
  if (request.method === "GET") {
    if (await sessaoValida(request, env)) return protegido(redirecionar(`${url.origin}/admin/`));
    return protegido(telaLogin());
  }
  if (request.method !== "POST") return protegido(resposta(405));
  const origemDeclarada = request.headers.get("Origin");
  if (origemDeclarada && origemDeclarada !== url.origin) return protegido(resposta(403));

  const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
  const agora = Date.now();
  const erros = await env.DB
    .prepare("SELECT COALESCE(SUM(CASE WHEN ip = ?1 AND ts > ?2 THEN 1 ELSE 0 END), 0) AS doIp, COUNT(*) AS todos FROM tentativas_pf WHERE ts > ?3")
    .bind(ip, agora - JANELA_IP_MS, agora - JANELA_GERAL_MS)
    .first();
  if (erros.doIp >= ERROS_POR_IP || erros.todos >= ERROS_GERAIS) {
    return protegido(telaLogin("Muitas tentativas erradas. Espere 15 minutos e tente de novo.", 429));
  }

  const form = await request.formData().catch(() => new FormData());
  const email = String(form.get("email") || "").trim().toLowerCase();
  const senha = String(form.get("senha") || "");
  const lembrar = form.get("lembrar") === "1";

  // as duas comparações sempre rodam, em tempo constante
  const emailCerto = await iguais(env, email, String(env.ADMIN_EMAIL).trim().toLowerCase());
  const senhaCerta = await iguais(env, senha, String(env.ADMIN_SENHA));
  if (!(emailCerto & senhaCerta)) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tentativas_pf (ip, ts) VALUES (?, ?)").bind(ip, agora),
      env.DB.prepare("DELETE FROM tentativas_pf WHERE ts < ?").bind(agora - 86400000),
    ]);
    return protegido(telaLogin("E-mail ou senha incorretos.", 401, email));
  }

  await env.DB.prepare("DELETE FROM tentativas_pf WHERE ip = ?").bind(ip).run();
  const validade = Math.floor(agora / 1000) + (lembrar ? LEMBRAR_S : SESSAO_CURTA_S);
  const cookie = [
    `${COOKIE}=${validade}.${await assinatura(env, validade)}`,
    "Path=/admin",
    "HttpOnly",
    "Secure",
    // Lax, e não Strict: abrir o painel por um link (e-mail, WhatsApp) mantém a sessão
    "SameSite=Lax",
    lembrar ? `Max-Age=${LEMBRAR_S}` : null,
  ].filter(Boolean).join("; ");
  const r = redirecionar(`${url.origin}/admin/`);
  r.headers.append("Set-Cookie", cookie);
  return protegido(r);
}

function sair(url) {
  const r = redirecionar(`${url.origin}/admin/entrar`);
  r.headers.append("Set-Cookie", `${COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return protegido(r);
}

// sessão = validade + assinatura (HMAC) da validade junto com a senha atual:
// trocar a senha ou a ADMIN_CHAVE invalida as sessões abertas
async function sessaoValida(request, env) {
  const valor = lerCookie(request, COOKIE);
  if (!valor) return false;
  const [validade, recebida = ""] = valor.split(".");
  if (!/^\d{1,12}$/.test(validade) || Number(validade) < Date.now() / 1000) return false;
  return textoIgual(await assinatura(env, validade), recebida);
}

async function assinatura(env, validade) {
  const bytes = await hmac(env, `sessao|${validade}|${env.ADMIN_SENHA}`);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let chaveHmac = null;
let textoChaveHmac = null;
async function hmac(env, texto) {
  if (textoChaveHmac !== env.ADMIN_CHAVE) {
    chaveHmac = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(env.ADMIN_CHAVE), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    textoChaveHmac = env.ADMIN_CHAVE;
  }
  return new Uint8Array(await crypto.subtle.sign("HMAC", chaveHmac, new TextEncoder().encode(texto)));
}

// compara pelo HMAC dos dois textos: mesmo tamanho e tempo constante
async function iguais(env, a, b) {
  const [x, y] = await Promise.all([hmac(env, `cmp|${a}`), hmac(env, `cmp|${b}`)]);
  let diferenca = 0;
  for (let i = 0; i < x.length; i++) diferenca |= x[i] ^ y[i];
  return diferenca === 0 ? 1 : 0;
}

function textoIgual(a, b) {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferenca === 0;
}

function lerCookie(request, nome) {
  for (const parte of (request.headers.get("Cookie") || "").split(";")) {
    const [chave, ...valor] = parte.trim().split("=");
    if (chave === nome) return valor.join("=");
  }
  return null;
}

const ENTIDADES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
const escapar = (t) => String(t).replace(/[&<>"']/g, (c) => ENTIDADES[c]);

// tela de login: usa o admin.css do painel, sem estilo nem script embutido,
// por causa da política de conteúdo (ver protegido)
function telaLogin(erro = "", status = 200, email = "") {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Entrar · Painel Black November</title>
<link rel="icon" type="image/png" href="../assets/img/simbolo-cf.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&family=Squada+One&display=swap" rel="stylesheet">
<link rel="stylesheet" href="admin.css?v=20261030-3">
</head>
<body class="entrar">
<div class="brilho" aria-hidden="true"></div>
<main class="entrar__cartao">
<img class="entrar__logo" src="../assets/img/logo-cf-branco.webp" alt="Contabilidade Facilitada" width="132" height="32">
<h1 class="entrar__titulo">Black November 2026 <span>· Painel</span></h1>
<p class="entrar__texto">Acesso restrito. Entre com o e-mail e a senha do painel.</p>
${erro ? `<p class="entrar__erro" role="alert">${escapar(erro)}</p>` : ""}
<form class="entrar__form" method="post" action="entrar">
<label class="entrar__campo"><span>E-mail</span><input type="email" name="email" value="${escapar(email)}" autocomplete="username" required${email ? "" : " autofocus"}></label>
<label class="entrar__campo"><span>Senha</span><input type="password" name="senha" autocomplete="current-password" required${email ? " autofocus" : ""}></label>
<label class="chave entrar__lembrar"><input type="checkbox" name="lembrar" value="1" checked><span class="chave__trilho" aria-hidden="true"></span>Lembrar este computador por 90 dias</label>
<button class="botao entrar__botao" type="submit">Entrar</button>
</form>
</main>
</body>
</html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// linhas como listas (sem repetir o nome das colunas em cada uma), em ordem de id
async function pagina(db, tabela, colunas, apos) {
  const linhas = await db
    .prepare(`SELECT ${colunas.join(",")} FROM ${tabela} WHERE id > ? ORDER BY id LIMIT ?`)
    .bind(apos, LINHAS_POR_PAGINA)
    .raw();
  return { colunas, linhas, completo: linhas.length < LINHAS_POR_PAGINA };
}

// sem cache em lugar nenhum, fora dos buscadores, sem moldura de outros sites,
// endereço do painel nunca enviado a outros domínios (same-origin: o envio do
// login precisa do cabeçalho Origin, que "no-referrer" transformaria em "null")
// e o navegador só carrega o que vem do próprio domínio (mais as fontes)
function protegido(resposta) {
  const r = new Response(resposta.body, resposta);
  r.headers.set("Cache-Control", "no-store");
  r.headers.set("X-Robots-Tag", "noindex, nofollow");
  r.headers.set("X-Frame-Options", "DENY");
  r.headers.set("Referrer-Policy", "same-origin");
  r.headers.set("X-Content-Type-Options", "nosniff");
  r.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return r;
}

// 303: depois de um POST, o navegador segue com GET
function redirecionar(destino) {
  return new Response(null, { status: 303, headers: { Location: destino } });
}

function textoSimples(texto, status) {
  return new Response(texto, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function json(corpo, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function resposta(status) {
  return new Response(null, { status });
}
