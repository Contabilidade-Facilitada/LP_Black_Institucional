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
 *   POST /api/endereco   aviso de cópia da LP aberta em outro domínio (público)
 *   GET  /final/{a|b}/{antecipar|esperar}  páginas finais do Typeform
 *   POST /api/final      acessos e cliques das páginas finais (público)
 *   GET  /api/metricas-gateway agregado sem dados pessoais (token)
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
 * (eventos_pf, cadastros_pf, gravacoes_pf, tentativas_pf, finais_pf; esta
 * última só das páginas finais, para não somar nos números da LP): os dois painéis
 * não se misturam e o Worker da Esquenta Black não precisa mudar. Criar as
 * tabelas uma vez com cloudflare/schema.sql (instruções no arquivo).
 *
 * SEGREDOS (Worker > Settings > Variables and Secrets > tipo Secret, ou
 * npx wrangler secret put NOME):
 *   ADMIN_EMAIL  e-mail que entra no painel
 *   ADMIN_SENHA  senha do painel
 *   ADMIN_CHAVE  texto aleatório longo, que assina a sessão; trocar este
 *                valor (ou a senha) desconecta todo mundo
 *   GATEWAY_METRICAS_CHAVE  texto aleatório longo, exclusivo da leitura do
 *                agregado pelo Data Gateway (o mesmo valor fica lá, em
 *                BLACK_LP_INSTITUCIONAL_METRICAS_CHAVE). Diferente dos de login
 *                e do usado pela Esquenta Black
 *
 * O e-mail e a senha ficam só nos segredos, nunca neste arquivo. Sem algum
 * segredo ou sem o banco, o painel responde 503 (falha fechada), nunca aberto.
 *
 * Contra quem tenta adivinhar a senha: 5 erros seguidos bloqueiam aquele
 * endereço de internet por 15 minutos, e 30 erros numa hora (de qualquer
 * endereço) fecham o login por até 1 hora, inclusive para quem tem a senha.
 *
 * CÓPIAS DA PÁGINA
 * Não há como impedir que alguém copie a LP; o Worker tenta descobrir quando
 * isso acontece e guarda o domínio em copias_pf, que o painel mostra num
 * aviso. Quatro sinais:
 *   script   o trecho no <head> do index.html, numa cópia aberta fora dos
 *            nossos domínios, avisa /api/endereco e leva o visitante para a
 *            LP verdadeira
 *   estilo   o style.css pede /assets/img/fundo.gif pelo endereço completo;
 *            numa cópia que levou o CSS, o pedido chega com o domínio dela
 *   arquivo  imagem, CSS ou script daqui carregado por página de outro domínio
 *            (ou a LP inteira dentro de uma moldura de outro site)
 *   envio    POST de outro domínio nas rotas de coleta
 * Quem copia com cuidado tira o script, troca os endereços e esconde o
 * domínio de origem (Referrer-Policy); estes sinais pegam as cópias feitas
 * às pressas, que são a maioria.
 */

import { LINKS_FINAIS, PAGINAS_FINAIS, TIPOS_LINK, lerPaginaFinal, linkSeguro } from "./finais.js";

// Linhas por resposta da sincronização do painel. A primeira carga pede
// páginas seguidas até alcançar o fim; depois disso cada atualização traz só o
// que chegou desde a anterior.
const LINHAS_POR_PAGINA = 10000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const caminho = url.pathname;

    const copia = arquivoPedidoDeFora(request, caminho);
    if (copia) ctx.waitUntil(registrarCopia(env, copia));

    // A página do painel referencia tudo por caminho relativo ("admin.css").
    // Em /admin, sem barra, o navegador resolveria isso para /admin.css, fora
    // da pasta. Por isso a URL sem barra vai para a versão com barra.
    if (caminho === "/admin") {
      return Response.redirect(`${url.origin}/admin/${url.search}`, 301);
    }

    if (caminho === "/api/coleta" || caminho === "/api/cadastro") {
      return receber(request, env, ctx, url, caminho === "/api/cadastro");
    }

    if (caminho === "/api/gravacao") {
      return receberGravacao(request, env, ctx, url);
    }

    if (caminho === "/api/endereco") {
      return receberEndereco(request, env);
    }

    if (caminho === "/api/final") {
      return receberFinal(request, env, ctx, url);
    }

    const final = lerPaginaFinal(caminho);
    if (final) return paginaFinal(env, url, final);
    // o modelo só sai preenchido, pelos 4 endereços acima (final.css e
    // final.js seguem para os arquivos estáticos)
    if (/^\/final(\/(index(\.html)?)?)?$/i.test(caminho)) return resposta(404);

    // pedido pelo style.css com o endereço completo (ver CÓPIAS DA PÁGINA):
    // um gif transparente de 1 pixel, nunca guardado em cache, para cada
    // visita a uma cópia chegar até aqui
    if (caminho === "/assets/img/fundo.gif") {
      return new Response(GIF_VAZIO, {
        headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" },
      });
    }

    if (caminho === "/api/metricas-gateway") {
      return metricasGateway(request, env);
    }

    if (caminho.startsWith("/admin/")) {
      return painel(request, env, url, caminho);
    }

    // configuração do Worker e do deploy não sai por este domínio (o
    // .assetsignore já deixa esses arquivos de fora; isto é a segunda trava)
    if (/^\/(cloudflare|tests|\.git|\.wrangler|node_modules)(\/|$)|^\/(\.gitignore|\.assetsignore|wrangler\.jsonc?)$/.test(caminho)) {
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
async function receberGravacao(request, env, ctx, url) {
  if (request.method !== "POST") return resposta(405);
  if (!env.DB) return resposta(503);
  if (envioDeFora(request, env, ctx, url)) return resposta(403);
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

async function receber(request, env, ctx, url, ehCadastro) {
  if (request.method !== "POST") return resposta(405);
  if (!env.DB) return resposta(503);

  if (envioDeFora(request, env, ctx, url)) return resposta(403);

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
   Páginas finais do Typeform (ver cloudflare/finais.js)
   --------------------------------------------------------------------------- */

// O modelo final/index.html preenchido para o endereço pedido: atributos do
// <html> (lidos pelo GTM e por final.js), só os blocos cujo data-so-pagina
// (lista separada por espaço) inclui a página, e os links do grupo de
// qualificação. Botão sem link fica visível, mas desativado (final.js avisa
// no console). O modelo é pedido sem os cabeçalhos do navegador e a resposta
// sai sem ETag: os links ficam aqui, e não no arquivo, então um 304 do
// arquivo serviria a página com o link antigo.
async function paginaFinal(env, url, final) {
  const modelo = await env.ASSETS.fetch(new Request(new URL("/final/", url)));
  if (!modelo.ok) return resposta(modelo.status === 404 ? 404 : 502);
  const links = LINKS_FINAIS[final.pagina] || {};

  let pagina = new HTMLRewriter()
    .on("html", {
      element(el) {
        el.setAttribute("data-grupo", final.grupo);
        el.setAttribute("data-intencao", final.intencao);
        el.setAttribute("data-pagina", final.pagina);
      },
    })
    .on("[data-so-pagina]", {
      element(el) {
        if (!el.getAttribute("data-so-pagina").split(/\s+/).includes(final.pagina)) el.remove();
      },
    });
  for (const tipo of TIPOS_LINK) {
    const destino = linkSeguro(links[tipo]);
    pagina = pagina.on(`[data-link='${tipo}']`, {
      element(el) {
        if (destino) {
          el.setAttribute("href", destino);
        } else {
          el.setAttribute("class", `${el.getAttribute("class") || ""} is-pendente`.trim());
          el.setAttribute("aria-disabled", "true");
        }
      },
    });
  }
  const preenchida = pagina.transform(modelo);

  const r = new Response(preenchida.body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  r.headers.set("Cache-Control", "no-store");
  r.headers.set("X-Robots-Tag", "noindex, nofollow");
  return r;
}

// cliques nos botões e aberturas do QR Code de cada link (só no computador)
const EVENTOS_FINAIS = new Set(["page_view", "engajamento", ...TIPOS_LINK.flatMap((t) => [`clique_${t}`, `qr_${t}`])]);

// Medição das páginas finais (final/final.js), na tabela finais_pf. As mesmas
// travas da coleta da LP: só POST, só da própria origem, sem robôs.
async function receberFinal(request, env, ctx, url) {
  if (request.method !== "POST") return resposta(405);
  if (!env.DB) return resposta(503);
  if (envioDeFora(request, env, ctx, url)) return resposta(403);
  const agente = request.headers.get("User-Agent") || "";
  if (ROBOS.test(agente) || ehRoboMeta(agente) || ehRedeMeta(request)) return resposta(204);

  const texto = await request.text();
  if (texto.length > 8000) return resposta(413);
  let dados;
  try { dados = JSON.parse(texto); } catch { return resposta(400); }
  if (!dados || typeof dados !== "object") return resposta(400);
  const pagina = String(dados.p || "").toLowerCase();
  if (!PAGINAS_FINAIS.includes(pagina)) return resposta(400);

  const agora = Date.now();
  const base = { pagina, visitante: corte(dados.v, 64), sessao: corte(dados.s, 64) };
  const linhas = [];
  for (const e of Array.isArray(dados.eventos) ? dados.eventos.slice(0, 20) : []) {
    if (!e || !EVENTOS_FINAIS.has(e.e)) continue;
    const atraso = Math.min(Math.max(Number(e.dt) || 0, 0), 600000);
    const linha = { ts: agora - atraso, evento: e.e, ...base };
    if (e.e === "engajamento" && Number.isFinite(Number(e.n))) {
      linha.valor = Math.min(Math.max(Math.round(Number(e.n)), 0), 86400);
    }
    if (e.e === "page_view") Object.assign(linha, contextoFinal(e.ctx), ambiente(request, agente));
    linhas.push(linha);
  }
  if (!linhas.length) return resposta(204);
  try {
    await inserirVarias(env.DB, "finais_pf", linhas);
  } catch {
    // sem a tabela finais_pf (schema.sql ainda não rodou)
    return resposta(503);
  }
  return resposta(204);
}

function contextoFinal(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const pontuacao = Number(c.pontuacao);
  return {
    referencia: corte(c.ref, 120),
    utm_source: corte(c.utm_source, 150),
    utm_medium: corte(c.utm_medium, 150),
    utm_campaign: corte(c.utm_campaign, 200),
    utm_content: corte(c.utm_content, 200),
    utm_term: corte(c.utm_term, 200),
    lead_origin: corte(c.lead_origin, 120),
    pontuacao: c.pontuacao !== "" && c.pontuacao != null && Number.isFinite(pontuacao)
      ? Math.min(Math.max(Math.round(pontuacao), -100000), 100000) : null,
  };
}

/* ---------------------------------------------------------------------------
   Cópias da página (ver CÓPIAS DA PÁGINA no início do arquivo)
   --------------------------------------------------------------------------- */

// Domínios que podem mostrar a LP ou carregar os arquivos dela: os da empresa,
// o workers.dev deste Worker (e as prévias de versão, "<versão>-lp-black-..."),
// o tradutor e o cache do Google e o teste local. A mesma lista está no trecho
// do <head> do index.html; mudar nos dois lugares.
const DOMINIOS_PROPRIOS = /(^|\.)(contabilidadefacilitada\.com(\.br)?|translate\.goog|googleusercontent\.com)$|^(localhost|127\.0\.0\.1)$|lp-black-institucional\.gabrielrabelo87\.workers\.dev$/;

const GIF_VAZIO = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));

const JANELA_COPIAS_MS = 30 * 86400000;

function dominioDe(endereco) {
  try {
    const u = new URL(endereco);
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

const dominioAlheio = (dominio) => Boolean(dominio) && !DOMINIOS_PROPRIOS.test(dominio);

// Arquivo daqui pedido por página de outro domínio (o Referer diz qual). A
// abertura da própria LP fica de fora: nela o Referer é o site de onde a
// pessoa veio (Google, Instagram), e não quem mostra a página. A LP aberta
// dentro de uma moldura (iframe) de outro site conta.
function arquivoPedidoDeFora(request, caminho) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (caminho === "/" || caminho.endsWith(".html")) return null;
  const destino = request.headers.get("Sec-Fetch-Dest");
  if (destino === "document") return null;
  // navegador sem Sec-Fetch-Dest: a abertura de página pede HTML
  if (!destino && /text\/html/.test(request.headers.get("Accept") || "")) return null;
  if (ROBOS.test(request.headers.get("User-Agent") || "")) return null;
  const referencia = request.headers.get("Referer") || "";
  const dominio = dominioDe(referencia);
  if (!dominioAlheio(dominio)) return null;
  return {
    dominio,
    sinal: caminho === "/assets/img/fundo.gif" ? "estilo" : "arquivo",
    exemplo: referencia,
  };
}

// Envio às rotas de coleta feito por página de outra origem: recusado, como
// antes, e o domínio vai para copias_pf quando não é nosso (o workers.dev é
// outra origem, mas é nosso). Origin "null" ou ausente não vira registro.
function envioDeFora(request, env, ctx, url) {
  const origem = request.headers.get("Origin");
  if (!origem || origem === url.origin) return false;
  const dominio = dominioDe(origem);
  if (dominioAlheio(dominio)) {
    ctx.waitUntil(registrarCopia(env, { dominio, sinal: "envio", exemplo: origem }));
  }
  return true;
}

// Aviso do trecho do <head> numa cópia aberta em outro domínio. O domínio vem
// do Origin, que o navegador preenche e a página não consegue trocar; o corpo
// traz o endereço completo da cópia (u) e de onde o visitante chegou nela (r).
async function receberEndereco(request, env) {
  if (request.method !== "POST") return resposta(405);
  const texto = await request.text();
  if (texto.length > 4000) return resposta(413);
  let d = {};
  try { d = JSON.parse(texto) || {}; } catch { /* vale só o Origin */ }
  const dominio = dominioDe(request.headers.get("Origin") || "") || dominioDe(String(d.u || ""));
  if (dominioAlheio(dominio)) {
    await registrarCopia(env, {
      dominio,
      sinal: "script",
      exemplo: typeof d.u === "string" ? d.u : null,
      vindoDe: dominioDe(String(d.r || "")),
    });
  }
  return resposta(204);
}

// Uma linha por domínio. Os sinais se acumulam ("script,estilo"); "visitas"
// conta os avisos do script, um por visita à cópia. Os outros sinais chegam a
// cada arquivo pedido e só atualizam a linha uma vez por minuto (ou quando
// trazem um sinal novo), para uma cópia muito acessada não gastar gravações.
// O endereço completo enviado pelo script prevalece sobre o dos outros sinais,
// que costuma ter só o domínio.
const SQL_REGISTRAR_COPIA = `
INSERT INTO copias_pf (dominio, primeiro_ts, ultimo_ts, sinais, visitas, exemplo, vindo_de)
VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT (dominio) DO UPDATE SET
  ultimo_ts = excluded.ultimo_ts,
  sinais = CASE WHEN instr(',' || sinais || ',', ',' || excluded.sinais || ',') > 0
                THEN sinais ELSE sinais || ',' || excluded.sinais END,
  visitas = visitas + excluded.visitas,
  exemplo = COALESCE(CASE WHEN excluded.visitas > 0 THEN excluded.exemplo END, exemplo, excluded.exemplo),
  vindo_de = COALESCE(excluded.vindo_de, vindo_de)
WHERE excluded.visitas > 0
   OR instr(',' || copias_pf.sinais || ',', ',' || excluded.sinais || ',') = 0
   OR excluded.ultimo_ts - copias_pf.ultimo_ts > 60000`;

async function registrarCopia(env, c) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(SQL_REGISTRAR_COPIA)
      .bind(corte(c.dominio, 253), Date.now(), c.sinal, c.sinal === "script" ? 1 : 0, corte(c.exemplo, 500), corte(c.vindoDe, 253))
      .run();
  } catch {
    /* sem a tabela copias_pf (schema.sql ainda não rodou), o aviso se perde */
  }
}

// cópias vistas nos últimos 30 dias, para o aviso do painel; sem a tabela, nenhuma
async function copiasRecentes(db) {
  try {
    const { results } = await db
      .prepare("SELECT dominio, primeiro_ts, ultimo_ts, sinais, visitas, exemplo, vindo_de FROM copias_pf WHERE ultimo_ts > ? ORDER BY ultimo_ts DESC LIMIT 50")
      .bind(Date.now() - JANELA_COPIAS_MS)
      .all();
    return results;
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------------------
   Agregado para o Data Gateway (recurso black_lp_institucional_funil_diario,
   que o BI lê). Mesmo formato da rota da Esquenta Black: por dia de Brasília ×
   UTMs × dispositivo, sem nome, e-mail, telefone, visitante ou sessão. A
   coluna "cor" vem sempre nula (esta página não tem teste A/B) para o
   contrato ser o mesmo nos dois lados. Percorre as tabelas inteiras; o teto
   de 10 mil linhas de /admin/api/sync não participa desta leitura.
   --------------------------------------------------------------------------- */

const SQL_METRICAS_GATEWAY = `
WITH primeira_pagina AS (
  SELECT sessao, MIN(id) AS id
  FROM eventos_pf
  WHERE evento = 'page_view' AND sessao IS NOT NULL
  GROUP BY sessao
), contexto_sessao AS (
  SELECT p.sessao, e.utm_source, e.utm_medium, e.utm_campaign, e.dispositivo
  FROM primeira_pagina p JOIN eventos_pf e ON e.id = p.id
), fatos AS (
  SELECT date(e.ts / 1000, 'unixepoch', '-3 hours') AS dia,
         e.utm_source, e.utm_medium, e.utm_campaign, e.dispositivo,
         e.visitante, 'acesso' AS tipo
  FROM eventos_pf e WHERE e.evento = 'page_view'
  UNION ALL
  SELECT date(e.ts / 1000, 'unixepoch', '-3 hours'),
         s.utm_source, s.utm_medium, s.utm_campaign, s.dispositivo,
         e.visitante, 'abertura'
  FROM eventos_pf e LEFT JOIN contexto_sessao s ON s.sessao = e.sessao
  WHERE e.evento = 'lead_form_aberto'
  UNION ALL
  SELECT date(c.ts / 1000, 'unixepoch', '-3 hours'),
         c.utm_source, c.utm_medium, c.utm_campaign, c.dispositivo,
         c.visitante, 'cadastro'
  FROM cadastros_pf c
)
SELECT dia, NULL AS cor, utm_source, utm_medium, utm_campaign, dispositivo,
       SUM(CASE WHEN tipo = 'acesso' THEN 1 ELSE 0 END) AS acessos,
       COUNT(DISTINCT CASE WHEN tipo = 'acesso' THEN visitante END) AS visitantes_unicos,
       COUNT(DISTINCT CASE WHEN tipo = 'abertura' THEN visitante END) AS formularios_abertos,
       SUM(CASE WHEN tipo = 'cadastro' THEN 1 ELSE 0 END) AS cadastros
FROM fatos
GROUP BY dia, utm_source, utm_medium, utm_campaign, dispositivo
ORDER BY dia, utm_source, utm_medium, utm_campaign, dispositivo`;

const SQL_TOTAIS_GATEWAY = `
SELECT
  (SELECT COUNT(*) FROM eventos_pf WHERE evento = 'page_view') AS acessos,
  (SELECT COUNT(DISTINCT visitante) FROM eventos_pf WHERE evento = 'page_view') AS visitantes_unicos,
  (SELECT COUNT(DISTINCT visitante) FROM eventos_pf WHERE evento = 'lead_form_aberto') AS formularios_abertos,
  (SELECT COUNT(*) FROM cadastros_pf) AS cadastros`;

// sem algum segredo ou sem o banco, 503 (falha fechada); token errado, 401
async function metricasGateway(request, env) {
  if (request.method !== "GET") return protegido(resposta(405));
  if (!env.DB || !env.ADMIN_CHAVE || !env.GATEWAY_METRICAS_CHAVE) return protegido(resposta(503));
  const autorizacao = request.headers.get("Authorization") || "";
  const token = autorizacao.startsWith("Bearer ") ? autorizacao.slice(7) : "";
  if (!(await iguais(env, token, env.GATEWAY_METRICAS_CHAVE))) {
    return protegido(resposta(401));
  }

  const [linhas, totais] = await Promise.all([
    env.DB.prepare(SQL_METRICAS_GATEWAY).all(),
    env.DB.prepare(SQL_TOTAIS_GATEWAY).first(),
  ]);
  return protegido(json({ agora: Date.now(), completo: true, totais, linhas: linhas.results }));
}

/* ---------------------------------------------------------------------------
   Aba Campanhas: as mesmas campanhas na LP Esquenta Black
   ---------------------------------------------------------------------------
   As campanhas desta página também mandam gente para a Esquenta (conjuntos
   "_lpfria" aqui, os outros lá). Para comparar as duas páginas, o painel pede
   o funil das mesmas campanhas nas tabelas da Esquenta (eventos e cadastros),
   que estão no mesmo banco. Essas tabelas não têm índice por data e passam de
   1 milhão de linhas: uma busca binária no id (que cresce com o tempo) acha o
   começo do período com umas 60 leituras, e a soma lê só dali em diante.
   A resposta fica 2 minutos no cache do Cloudflare.
   O gasto dos anúncios entra quando houver a chave de leitura do Data
   Gateway; até lá vai nulo e o painel mostra o funil sem custo. */
const MAXIMO_CAMPANHAS = 40;
const CACHE_CAMPANHAS_S = 120;
// folga para eventos gravados fora de ordem (o "dt" do lote ajusta o ts)
const FOLGA_CORTE_MS = 3600000;

const sqlCorte = (tabela) => `WITH RECURSIVE b(lo, hi) AS (
  SELECT 1, (SELECT COALESCE(MAX(id), 0) FROM ${tabela}) + 1
  UNION ALL
  SELECT
    CASE WHEN (SELECT ts FROM ${tabela} WHERE id >= (lo + hi) / 2 ORDER BY id LIMIT 1) < ?1 THEN (lo + hi) / 2 + 1 ELSE lo END,
    CASE WHEN (SELECT ts FROM ${tabela} WHERE id >= (lo + hi) / 2 ORDER BY id LIMIT 1) < ?1 THEN hi ELSE (lo + hi) / 2 END
  FROM b WHERE lo < hi
) SELECT MIN(hi) AS corte FROM b`;

async function campanhas(env, url) {
  const ini = Number(url.searchParams.get("ini")) || 0;
  const fim = Number(url.searchParams.get("fim")) || Date.now() + 1;
  const lista = [...new Set(url.searchParams.getAll("c").map((c) => c.slice(0, 200)).filter(Boolean))]
    .sort().slice(0, MAXIMO_CAMPANHAS);
  if (!lista.length) return json({ esquenta: [], gasto: null });

  // chave do cache arredondada ao minuto: atualizações seguidas reaproveitam
  const chave = new URL("https://cache.interno/admin/api/campanhas");
  chave.searchParams.set("ini", String(Math.floor(ini / 60000)));
  chave.searchParams.set("fim", String(Math.floor(fim / 60000)));
  lista.forEach((c) => chave.searchParams.append("c", c));
  const cache = caches.default;
  const guardada = await cache.match(chave.toString());
  if (guardada) return guardada;

  const [corteEventos, corteCadastros] = await env.DB.batch([
    env.DB.prepare(sqlCorte("eventos")).bind(ini - FOLGA_CORTE_MS),
    env.DB.prepare(sqlCorte("cadastros")).bind(ini - FOLGA_CORTE_MS),
  ]);
  const marcas = lista.map((_, i) => `?${i + 4}`).join(", ");
  const [funil, cadastros] = await env.DB.batch([
    // a abertura do formulário não traz UTMs: vale a da página da sessão
    env.DB.prepare(`WITH pv AS (
        SELECT sessao, MIN(visitante) AS visitante, MIN(utm_campaign) AS campanha, MIN(utm_content) AS conjunto
        FROM eventos WHERE id >= ?1 AND ts >= ?2 AND ts < ?3 AND evento = 'page_view' AND utm_campaign IN (${marcas})
        GROUP BY sessao
      ), aberturas AS (
        SELECT DISTINCT sessao FROM eventos WHERE id >= ?1 AND ts >= ?2 AND ts < ?3 AND evento = 'lead_form_aberto'
      )
      SELECT pv.campanha, pv.conjunto, COUNT(DISTINCT pv.visitante) AS visitantes,
        COUNT(DISTINCT CASE WHEN aberturas.sessao IS NOT NULL THEN pv.visitante END) AS formulario
      FROM pv LEFT JOIN aberturas ON aberturas.sessao = pv.sessao
      GROUP BY 1, 2`)
      .bind(corteEventos.results[0]?.corte || 1, ini, fim, ...lista),
    env.DB.prepare(`SELECT utm_campaign AS campanha, utm_content AS conjunto, COUNT(*) AS cadastros
      FROM cadastros WHERE id >= ?1 AND ts >= ?2 AND ts < ?3 AND utm_campaign IN (${marcas})
      GROUP BY 1, 2`)
      .bind(corteCadastros.results[0]?.corte || 1, ini, fim, ...lista),
  ]);

  const linhas = new Map();
  const linha = (r) => {
    const k = `${r.campanha}\u0000${r.conjunto ?? ""}`;
    if (!linhas.has(k)) linhas.set(k, { campanha: r.campanha, conjunto: r.conjunto ?? null, visitantes: 0, formulario: 0, cadastros: 0 });
    return linhas.get(k);
  };
  for (const r of funil.results) Object.assign(linha(r), { visitantes: r.visitantes, formulario: r.formulario });
  for (const r of cadastros.results) linha(r).cadastros = r.cadastros;

  // a cópia do cache não sai para o navegador (protegido() põe no-store na resposta)
  const r = json({ esquenta: [...linhas.values()], gasto: null });
  const paraCache = r.clone();
  paraCache.headers.set("Cache-Control", `public, max-age=${CACHE_CAMPANHAS_S}`);
  await cache.put(chave.toString(), paraCache);
  return r;
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
const COLUNAS_FINAIS = [
  "id", "ts", "pagina", "evento", "visitante", "sessao", "valor", "referencia",
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  "lead_origin", "pontuacao", "dispositivo", "navegador", "sistema", "pais",
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
    const aposFinais = Math.max(0, Number(url.searchParams.get("finais")) || 0);
    const [eventos, cadastros, copias, finais] = await Promise.all([
      pagina(env.DB, "eventos_pf", COLUNAS_EVENTOS, aposEventos),
      pagina(env.DB, "cadastros_pf", COLUNAS_CADASTROS, aposCadastros),
      copiasRecentes(env.DB),
      // sem a tabela finais_pf (schema.sql ainda não rodou), vazio
      pagina(env.DB, "finais_pf", COLUNAS_FINAIS, aposFinais)
        .catch(() => ({ colunas: COLUNAS_FINAIS, linhas: [], completo: true })),
    ]);
    return protegido(json({ agora: Date.now(), email: env.ADMIN_EMAIL, eventos, cadastros, copias, finais }));
  }

  if (caminho === "/admin/api/campanhas") return protegido(await campanhas(env, url));

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
<link rel="stylesheet" href="admin.css?v=20261101-1">
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
