/* =========================================================
   Painel da Black November 2026 (PF)

   Os dados chegam de /admin/api/sync (cloudflare/worker.js) em
   ordem de id. A primeira carga traz tudo; depois, a cada 5 segundos, só o
   que entrou desde a última vez. Todo o cálculo (filtros, totais, gráficos) é
   feito aqui, no navegador, sobre o que já foi baixado: trocar um filtro não
   consulta o banco.

   Tudo o que vem do banco foi digitado ou enviado por visitantes, então entra
   na página sempre como texto (textContent), nunca como HTML.

   As animações de entrada rodam quando a pessoa muda algo (aba, filtro,
   métrica); a atualização ao vivo só ajusta os números, sem redesenhar do zero.
   ========================================================= */
(() => {
  "use strict";

  const HORA = 3600000;
  const DIA = 86400000;
  // Brasília fica em UTC−3 o ano todo (sem horário de verão desde 2019)
  const DESLOCAMENTO = 3 * HORA;
  const FUSO = "America/Sao_Paulo";
  const API = "/admin/api/sync";
  const INTERVALO_MS = 5000;
  const INTERVALO_OCULTO_MS = 30000;
  const ATIVO_MS = 2 * 60000;
  const VAZIO = "__vazio__";
  const CHAVE_PREFERENCIAS = "cf_black_pf_painel_v1";
  const movimentoReduzido = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // valores de data-abrir-lead no index.html da LP
  const CTAS = {
    heroi: "Topo da página",
    "para-quem": "Para quem é",
    escola: "Escola Contábil",
    pos: "Pós-graduações",
    "pos-reforma-tributaria": "Pós · Reforma Tributária",
    "pos-pericia": "Pós · Perícia",
    "pos-aprovacao-contabil": "Pós · Aprovação Contábil",
    "pos-simples-nacional": "Pós · Simples Nacional",
    "pos-setor-publico": "Pós · Setor Público",
    "pos-departamento-pessoal": "Pós · Departamento Pessoal",
    "pos-financas-controladoria": "Pós · Finanças e Controladoria",
    "pos-auditoria-compliance": "Pós · Auditoria e Compliance",
    final: "Fim da página",
    dock: "Barra fixa inferior",
  };
  const EVENTOS = {
    page_view: "Página carregada",
    lead_form_aberto: "Formulário aberto",
    lead_esquenta_black: "Cadastro enviado",
    oferta_heroi_clique: "Clique numa oferta do topo",
    voltar_topo: "Voltar ao topo",
    engajamento: "Pulso de engajamento (a cada minuto e ao sair)",
    clique: "Clique ou toque na página (mapa de cliques)",
    gravacao: "Visita gravada para reprodução (aba Pessoas)",
    carregamento: "Velocidade de carregamento (tempo até a primeira tela aparecer)",
    "gtm.click": "Clique (gatilho do GTM)",
    "gtm.linkClick": "Clique em link (gatilho do GTM)",
    "gtm.scrollDepth": "Rolagem (gatilho do GTM)",
    "gtm.formSubmit": "Envio de formulário (gatilho do GTM)",
    "gtm.video": "Vídeo (gatilho do GTM)",
    "gtm.elementVisibility": "Elemento visível (gatilho do GTM)",
  };
  const DIAS_SEMANA = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
  const DIAS_SEMANA_LONGOS = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
  const ROTULOS_PERIODO_ANTERIOR = {
    hoje: "vs ontem no mesmo horário",
    ontem: "vs anteontem",
    "24h": "vs 24 horas anteriores",
    "7d": "vs 7 dias anteriores",
    "30d": "vs 30 dias anteriores",
    personalizado: "vs período anterior de mesma duração",
  };

  const $ = (seletor, contexto = document) => contexto.querySelector(seletor);
  const $$ = (seletor, contexto = document) => Array.from(contexto.querySelectorAll(seletor));

  // cores das séries lidas do CSS (admin.css), para usar em atributos SVG
  const estilo = getComputedStyle(document.documentElement);
  const cor = (nome) => estilo.getPropertyValue(`--s-${nome}`).trim();
  const CORES = {
    acessos: cor("acessos"),
    visitantes: cor("visitantes"),
    cadastros: cor("cadastros"),
    conversao: cor("conversao"),
    verde: cor("verde"),
    evento: cor("evento"),
    anterior: cor("anterior"),
    funil: [cor("funil-1"), cor("funil-2"), cor("funil-3")],
  };
  const SUPERFICIE = "#15110d";

  /* ---------------------------------------------------------
     Formatação
     --------------------------------------------------------- */
  const numero = new Intl.NumberFormat("pt-BR");
  const fmtNum = (n) => numero.format(Math.round(n));
  const fmtPct = (x, casas = 1) => (Number.isFinite(x)
    ? `${(x * 100).toLocaleString("pt-BR", { maximumFractionDigits: casas })}%`
    : "—");
  const fmtCompacto = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
  const fmtDataHora = new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const fmtHora = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  // tabela de cadastros: dia e hora, sem ano nem segundos (a data completa fica no title)
  const fmtDataCurta = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const fmtDiaSemana = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, weekday: "short", day: "2-digit", month: "2-digit" });
  const plural = (n, um, varios) => `${fmtNum(n)} ${n === 1 ? um : varios}`;

  // partes da data no horário de Brasília (deslocamento fixo, ver DESLOCAMENTO)
  function partes(ts) {
    const d = new Date(ts - DESLOCAMENTO);
    return {
      ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate(),
      hora: d.getUTCHours(), minuto: d.getUTCMinutes(),
      semana: (d.getUTCDay() + 6) % 7, // 0 = segunda
    };
  }
  const doisDigitos = (n) => String(n).padStart(2, "0");
  const inicioDia = (ts) => Math.floor((ts - DESLOCAMENTO) / DIA) * DIA + DESLOCAMENTO;
  // valor para <input type="datetime-local">, no horário de Brasília
  function paraCampoData(ts) {
    const p = partes(ts);
    return `${p.ano}-${doisDigitos(p.mes)}-${doisDigitos(p.dia)}T${doisDigitos(p.hora)}:${doisDigitos(p.minuto)}`;
  }

  function fmtRelativo(ts) {
    const s = Math.max(0, Math.round((relogio() - ts) / 1000));
    if (s < 45) return "agora";
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
    return fmtDataHora.format(ts).slice(0, 5);
  }

  function fmtDuracao(segundos) {
    if (!Number.isFinite(segundos)) return "—";
    const s = Math.round(segundos);
    if (s < 60) return `${s} s`;
    const min = Math.floor(s / 60);
    return s % 60 ? `${min} min ${s % 60} s` : `${min} min`;
  }

  function fmtTelefone(d = "") {
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return d;
  }

  const normalizar = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const capitalizar = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
  const origemMidia = (o) => (o.utm_source || o.utm_medium ? `${o.utm_source || "—"} / ${o.utm_medium || "—"}` : "(sem UTM)");
  const local = (o) => [o.cidade, o.pais && o.pais !== "BR" ? o.pais : o.estado].filter(Boolean).join(" – ");
  const iniciais = (nome) => String(nome || "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0] || "").join("").toUpperCase() || "?";

  function rgba(hex, alfa) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
  }

  /* ---------------------------------------------------------
     DOM
     --------------------------------------------------------- */
  function el(tag, props = {}, ...filhos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      // objeto, e não texto: a política de conteúdo do painel (ver worker.js)
      // bloqueia o atributo style escrito como texto
      else if (k === "style") {
        for (const [p, valor] of Object.entries(v)) {
          if (p.startsWith("--")) n.style.setProperty(p, valor);
          else n.style[p] = valor;
        }
      } else if (k === "dataset") Object.assign(n.dataset, v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const f of filhos.flat()) {
      if (f === null || f === undefined || f === false) continue;
      n.append(f instanceof Node ? f : String(f));
    }
    return n;
  }

  const NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, atributos = {}, texto) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(atributos)) n.setAttribute(k, v);
    if (texto !== undefined) n.textContent = texto;
    return n;
  }

  const texto = (seletor, valor) => { $(seletor).textContent = valor; };

  // o termo buscado em destaque, montado com nós de texto (nunca HTML)
  function destacarTermo(valor, termo) {
    const t = String(valor ?? "");
    if (!termo) return t;
    const i = normalizar(t).indexOf(termo);
    if (i < 0) return t;
    return [t.slice(0, i), el("mark", {}, t.slice(i, i + termo.length)), t.slice(i + termo.length)];
  }

  // número que conta até o novo valor; brilha quando sobe na atualização ao vivo
  function contar(seletor, valor, formatar = fmtNum, aoVivo = false) {
    const n = $(seletor);
    const anterior = n.dataset.valor === undefined ? undefined : Number(n.dataset.valor);
    if (!Number.isFinite(valor)) {
      n.dataset.valor = "NaN";
      n.textContent = "—";
      return;
    }
    n.dataset.valor = String(valor);
    if (anterior === valor) { n.textContent = formatar(valor); return; }
    cancelAnimationFrame(Number(n.dataset.quadro || 0));
    if (aoVivo && Number.isFinite(anterior) && valor > anterior) {
      n.classList.remove("is-subiu");
      void n.offsetWidth;
      n.classList.add("is-subiu");
    }
    const de = Number.isFinite(anterior) ? anterior : 0;
    if (movimentoReduzido) { n.textContent = formatar(valor); return; }
    const inicio = performance.now();
    const duracao = 700;
    const passo = (agora) => {
      // o horário do quadro pode vir antes de "inicio": sem o limite de baixo,
      // o número passa por valores negativos no primeiro quadro
      const t = Math.max(0, Math.min(1, (agora - inicio) / duracao));
      const suave = 1 - (1 - t) ** 3;
      n.textContent = formatar(de + (valor - de) * suave);
      if (t < 1) n.dataset.quadro = String(requestAnimationFrame(passo));
    };
    n.dataset.quadro = String(requestAnimationFrame(passo));
  }

  /* ---------------------------------------------------------
     Filtros e preferências

     As preferências ficam no navegador (conveniência) e os filtros também no
     endereço (#...), para o link copiado abrir o painel no mesmo recorte.
     --------------------------------------------------------- */
  const FILTROS = [
    { k: "utm_source", nome: "Origem" },
    { k: "utm_medium", nome: "Mídia" },
    { k: "utm_campaign", nome: "Campanha" },
    // no Meta, utm_content é o conjunto de anúncios e utm_term é o anúncio
    // (guia interno de UTMs)
    { k: "utm_content", nome: "Conjunto" },
    { k: "utm_term", nome: "Anúncio" },
    { k: "dispositivo", nome: "Dispositivo", mostrar: capitalizar },
    { k: "estado", nome: "Estado" },
  ];
  const CHAVES_FILTRO = FILTROS.map((f) => f.k);
  const PERIODOS = ["hoje", "ontem", "24h", "7d", "30d", "tudo", "personalizado"];

  const prefs = (() => {
    const padrao = {
      aba: "geral", periodo: "tudo", de: "", ate: "", filtros: {},
      dimensao: "utm_source", evento: "", metrica: "acessos", granularidade: "auto",
      comparar: false, calor: "acessos", ranking: "utm_source", porPagina: 50, pulsos: false, mapa: "calor", pessoas: "gravadas", pessoasOrdem: "recentes", finaisMetrica: "volume",
      ordem: {
        cadastros: { campo: "ts", dir: "desc" },
        origens: { campo: "visitantes", dir: "desc" },
        eventos: { campo: "total", dir: "desc" },
      },
    };
    let salvas = {};
    try { salvas = JSON.parse(localStorage.getItem(CHAVE_PREFERENCIAS)) || {}; } catch { /* sem armazenamento */ }
    const p = { ...padrao, ...salvas, ordem: { ...padrao.ordem, ...(salvas.ordem || {}) } };
    p.filtros = {};
    for (const k of CHAVES_FILTRO) if (Array.isArray(salvas.filtros?.[k])) p.filtros[k] = salvas.filtros[k];

    // o endereço tem prioridade: é assim que um link copiado abre igual
    const hash = new URLSearchParams(location.hash.slice(1));
    if ([...hash.keys()].length) {
      if (["geral", "campanhas", "cadastros", "pessoas", "origens", "eventos", "mapa", "finais", "copias"].includes(hash.get("aba"))) p.aba = hash.get("aba");
      p.periodo = PERIODOS.includes(hash.get("periodo")) ? hash.get("periodo") : "tudo";
      p.de = hash.get("de") || "";
      p.ate = hash.get("ate") || "";
      p.filtros = {};
      for (const k of CHAVES_FILTRO) if (hash.get(k)) p.filtros[k] = hash.get(k).split("|");
    }
    if (!PERIODOS.includes(p.periodo)) p.periodo = "tudo";
    return p;
  })();

  function gravarPrefs() {
    try { localStorage.setItem(CHAVE_PREFERENCIAS, JSON.stringify(prefs)); } catch { /* sem armazenamento */ }
    const hash = new URLSearchParams();
    if (prefs.aba !== "geral") hash.set("aba", prefs.aba);
    if (prefs.periodo !== "tudo") hash.set("periodo", prefs.periodo);
    if (prefs.periodo === "personalizado") {
      if (prefs.de) hash.set("de", prefs.de);
      if (prefs.ate) hash.set("ate", prefs.ate);
    }
    for (const k of CHAVES_FILTRO) if (prefs.filtros[k]?.length) hash.set(k, prefs.filtros[k].join("|"));
    const textoHash = hash.toString();
    try {
      history.replaceState(null, "", textoHash ? `#${textoHash}` : location.pathname + location.search);
    } catch { /* aberto do disco: alguns navegadores recusam */ }
  }

  const filtrosAtivos = () => CHAVES_FILTRO.some((k) => prefs.filtros[k]?.length);

  // "excluir": a contagem de um filtro considera todos os outros, menos ele mesmo
  function passaDims(o, excluir) {
    for (const k of CHAVES_FILTRO) {
      if (k === excluir) continue;
      const lista = prefs.filtros[k];
      if (!lista?.length) continue;
      if (!o) return false;
      if (!lista.includes(o[k] || VAZIO)) return false;
    }
    return true;
  }

  function alternarFiltro(k, valor) {
    const v = valor || VAZIO;
    const lista = prefs.filtros[k] || [];
    prefs.filtros[k] = lista.includes(v) ? lista.filter((x) => x !== v) : [...lista, v];
    if (!prefs.filtros[k].length) delete prefs.filtros[k];
    aplicarFiltros();
  }

  /* ---------------------------------------------------------
     Dados
     --------------------------------------------------------- */
  const dados = {
    eventos: [],
    pageviews: [],
    cadastros: [],
    sessoes: new Map(), // sessão -> primeiro page_view (de onde vêm UTMs, dispositivo, local)
    emails: new Map(), // e-mail -> quantos cadastros
    // páginas finais do Typeform (tabela finais_pf): separadas de "eventos",
    // para não entrarem nos números da LP
    finais: [],
    sessoesFinais: new Map(), // sessão -> page_view da página final
    linksFinais: {}, // página -> { grupo } (cloudflare/finais.js)
    ultimo: { eventos: 0, cadastros: 0, finais: 0 },
    desvio: 0, // diferença entre o relógio do servidor e o deste computador
    primeiroTs: Infinity, // registro mais antigo (a ordem por id não garante isso)
    carregado: false,
  };
  const relogio = () => Date.now() + dados.desvio;

  function absorver({ colunas, linhas }, tipo) {
    const novos = [];
    for (const linha of linhas) {
      const o = {};
      for (let i = 0; i < colunas.length; i++) if (linha[i] !== null) o[colunas[i]] = linha[i];
      if (tipo === "eventos") {
        dados.eventos.push(o);
        if (o.evento === "page_view") {
          dados.pageviews.push(o);
          if (o.sessao && !dados.sessoes.has(o.sessao)) dados.sessoes.set(o.sessao, o);
        }
      } else if (tipo === "finais") {
        dados.finais.push(o);
        if (o.evento === "page_view" && o.sessao && !dados.sessoesFinais.has(o.sessao)) dados.sessoesFinais.set(o.sessao, o);
      } else {
        dados.cadastros.push(o);
        if (o.email) dados.emails.set(o.email, (dados.emails.get(o.email) || 0) + 1);
      }
      dados.ultimo[tipo] = o.id;
      if (o.ts < dados.primeiroTs) dados.primeiroTs = o.ts;
      novos.push(o);
    }
    return novos;
  }

  const sessaoDe = (e) => (e.evento === "page_view" ? e : dados.sessoes.get(e.sessao));

  function detalheLegivel(e) {
    if (e.evento === "clique") return lerClique(e)?.l || "(sem texto)";
    return CTAS[e.detalhe] || e.detalhe || "";
  }

  function lerDataLocal(valor) {
    if (!valor) return null;
    const ts = new Date(`${valor}:00-03:00`).getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  const primeiroRegistro = () => Math.min(dados.primeiroTs, relogio() - DIA);

  function intervalo() {
    const agora = relogio();
    const hoje = inicioDia(agora);
    switch (prefs.periodo) {
      case "hoje": return [hoje, agora + 1];
      case "ontem": return [hoje - DIA, hoje];
      case "24h": return [agora - DIA, agora + 1];
      case "7d": return [agora - 7 * DIA, agora + 1];
      case "30d": return [agora - 30 * DIA, agora + 1];
      case "personalizado": {
        const de = lerDataLocal(prefs.de) ?? primeiroRegistro();
        const ate = lerDataLocal(prefs.ate) ?? agora + 1;
        return [de, Math.max(de + 1, ate)];
      }
      default: return [primeiroRegistro(), agora + 1];
    }
  }

  function fatiar(inicio, fim) {
    const dentro = (ts) => ts >= inicio && ts < fim;
    return {
      inicio,
      fim,
      pvs: dados.pageviews.filter((p) => dentro(p.ts) && passaDims(p)),
      eventos: dados.eventos.filter((e) => dentro(e.ts) && passaDims(sessaoDe(e))),
      cadastros: dados.cadastros.filter((c) => dentro(c.ts) && passaDims(c)),
      // cliques e engajamento herdam as UTMs do page_view da mesma sessão
      finais: dados.finais.filter((e) => dentro(e.ts)
        && passaDims(e.evento === "page_view" ? e : dados.sessoesFinais.get(e.sessao))),
    };
  }

  const distintos = (lista, campo) => new Set(lista.map((o) => o[campo]).filter(Boolean));

  function escalaDe(inicio, fim) {
    if (prefs.granularidade === "hora") return HORA;
    if (prefs.granularidade === "dia") return DIA;
    return fim - inicio <= 3 * DIA + HORA ? HORA : DIA;
  }

  // a grade do eixo do tempo: um balde por hora ou por dia, alinhado a Brasília
  function gradeTempo(inicio, fim, escala) {
    const alinhar = escala === DIA ? inicioDia : (ts) => Math.floor(ts / HORA) * HORA;
    const primeiro = alinhar(inicio);
    const n = Math.max(1, Math.min(2000, Math.ceil((fim - primeiro) / escala)));
    const pontos = [];
    for (let i = 0; i < n; i++) {
      const t = primeiro + i * escala;
      const p = partes(t);
      const dia = `${doisDigitos(p.dia)}/${doisDigitos(p.mes)}`;
      pontos.push(escala === DIA
        ? { t, rotulo: dia, dica: fmtDiaSemana.format(t) }
        : { t, rotulo: p.hora === 0 || i === 0 ? dia : `${p.hora}h`, dica: `${dia}, ${p.hora}h–${(p.hora + 1) % 24}h` });
    }
    return { primeiro, n, escala, pontos };
  }

  // "deslocamento" leva o período anterior para cima da grade atual
  function contarPorBalde(grade, lista, deslocamento = 0) {
    const v = new Array(grade.n).fill(0);
    for (const o of lista) {
      const i = Math.floor((o.ts + deslocamento - grade.primeiro) / grade.escala);
      if (i >= 0 && i < grade.n) v[i]++;
    }
    return v;
  }
  function distintosPorBalde(grade, lista, campo, deslocamento = 0) {
    const conjuntos = Array.from({ length: grade.n }, () => new Set());
    for (const o of lista) {
      const i = Math.floor((o.ts + deslocamento - grade.primeiro) / grade.escala);
      if (i >= 0 && i < grade.n && o[campo]) conjuntos[i].add(o[campo]);
    }
    return conjuntos.map((s) => s.size);
  }

  const METRICAS = {
    acessos: { nome: "acessos", cor: () => CORES.acessos, formato: fmtNum },
    visitantes: { nome: "visitantes", cor: () => CORES.visitantes, formato: fmtNum },
    cadastros: { nome: "cadastros", cor: () => CORES.cadastros, formato: fmtNum },
    conversao: { nome: "conversão", cor: () => CORES.conversao, formato: (v) => fmtPct(v), fracao: true },
  };

  function valoresMetrica(metrica, f, grade, deslocamento = 0) {
    if (metrica === "acessos") return contarPorBalde(grade, f.pvs, deslocamento);
    if (metrica === "cadastros") return contarPorBalde(grade, f.cadastros, deslocamento);
    const visitantes = distintosPorBalde(grade, f.pvs, "visitante", deslocamento);
    if (metrica === "visitantes") return visitantes;
    const cadastros = contarPorBalde(grade, f.cadastros, deslocamento);
    return visitantes.map((v, i) => (v ? cadastros[i] / v : 0));
  }

  /* ---------------------------------------------------------
     Gráficos (SVG desenhado aqui; sem biblioteca)
     --------------------------------------------------------- */
  const dica = $("#dica");

  function mostrarDica(x, y, titulo, linhas, acao) {
    dica.replaceChildren(
      el("div", { class: "dica__titulo" }, titulo),
      ...linhas.map((l) => el("div", { class: "dica__linha" },
        el("span", { class: "dica__chave", style: { background: l.cor } }),
        el("span", { class: "dica__valor" }, l.valor),
        el("span", { class: "dica__nome" }, l.nome))),
      ...(acao ? [el("div", { class: "dica__acao" }, acao)] : []),
    );
    dica.hidden = false;
    const r = dica.getBoundingClientRect();
    let esquerda = x + 14;
    let topo = y - r.height - 10;
    if (esquerda + r.width > window.innerWidth - 8) esquerda = x - r.width - 14;
    if (topo < 8) topo = y + 16;
    dica.style.left = `${Math.max(8, esquerda)}px`;
    dica.style.top = `${topo}px`;
  }
  const esconderDica = () => { dica.hidden = true; };

  function escalaBonita(maximo, inteiro = true) {
    if (maximo <= 0) return inteiro ? { topo: 4, passos: [0, 1, 2, 3, 4] } : { topo: 0.04, passos: [0, 0.01, 0.02, 0.03, 0.04] };
    const bruto = maximo / 4;
    const grandeza = 10 ** Math.floor(Math.log10(bruto));
    const norma = bruto / grandeza;
    let passo = (norma <= 1 ? 1 : norma <= 2 ? 2 : norma <= 5 ? 5 : 10) * grandeza;
    if (inteiro) passo = Math.max(1, passo);
    const topo = Math.ceil(maximo / passo - 1e-9) * passo;
    const passos = [];
    for (let i = 0; i * passo <= topo + passo / 1e6; i++) passos.push(i * passo);
    return { topo, passos };
  }

  // coluna com a ponta de dados arredondada (4px) e a base reta
  function caminhoColuna(x, y, w, h, r) {
    const raio = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + raio}A${raio},${raio} 0 0 1 ${x + raio},${y}`
      + `H${x + w - raio}A${raio},${raio} 0 0 1 ${x + w},${y + raio}V${y + h}Z`;
  }

  const configuracoes = new Map();
  const larguras = new WeakMap();
  const observadorTamanho = new ResizeObserver((entradas) => {
    for (const e of entradas) {
      const largura = Math.floor(e.contentRect.width);
      if (larguras.get(e.target) === largura || !configuracoes.has(e.target)) continue;
      const cfg = configuracoes.get(e.target);
      (cfg.desenhar || grafico)(e.target, { ...cfg, animar: false });
    }
  });

  /**
   * pontos: eixo X ([{ rotulo, dica }]); series: [{ nome, cor, valores }].
   * A primeira série é a principal (com área); as outras, linhas de
   * comparação. tipo "area" ou "colunas" (colunas: uma série só).
   */
  function grafico(alvo, cfg) {
    if (!configuracoes.has(alvo)) observadorTamanho.observe(alvo);
    configuracoes.set(alvo, cfg);
    const largura = Math.floor(alvo.clientWidth);
    larguras.set(alvo, largura);
    if (largura < 50) return; // aba oculta: desenha quando aparecer

    const { pontos, series, tipo = "colunas", formato = fmtNum, inteiro = true, aoClicar, acao, animar } = cfg;
    const principal = series[0];
    const altura = alvo.classList.contains("grafico--alto") ? 300 : 220;
    const m = { t: 12, r: 10, b: 26, l: 46 };
    const w = largura - m.l - m.r;
    const h = altura - m.t - m.b;
    const n = Math.max(1, pontos.length);
    const maximo = Math.max(0, ...series.flatMap((s) => s.valores));
    const total = principal.valores.reduce((s, v) => s + v, 0);
    const { topo, passos } = escalaBonita(maximo, inteiro);
    const y = (v) => m.t + h - (v / topo) * h;
    const banda = w / n;
    const x = (i) => m.l + banda * (i + 0.5);
    const formatoEixo = inteiro ? (v) => fmtCompacto.format(v) : (v) => fmtPct(v, 0);

    const svg = svgEl("svg", {
      width: largura, height: altura, viewBox: `0 0 ${largura} ${altura}`,
      role: "img", tabindex: 0, class: animar && !movimentoReduzido ? "anima" : "",
      "aria-label": `${principal.nome}. Use as setas para percorrer os valores.`,
    });

    for (const v of passos) {
      svg.append(svgEl("line", { class: v === 0 ? "base-linha" : "grade-linha", x1: m.l, x2: largura - m.r, y1: y(v), y2: y(v) }));
      svg.append(svgEl("text", { class: "eixo-texto", x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, formatoEixo(v)));
    }
    const cadaRotulo = Math.max(1, Math.ceil(58 / banda));
    pontos.forEach((p, i) => {
      if (i % cadaRotulo) return;
      svg.append(svgEl("text", { class: "eixo-texto", x: x(i), y: altura - 6, "text-anchor": "middle" }, p.rotulo));
    });

    const barras = [];
    const cruz = svgEl("line", { class: "cruz", y1: m.t, y2: m.t + h, visibility: "hidden" });
    const marcadores = series.map((s) => svgEl("circle", { r: 4, fill: s.cor, stroke: SUPERFICIE, "stroke-width": 2, visibility: "hidden" }));

    if (tipo === "colunas") {
      const bw = Math.max(2, Math.min(24, banda - 2));
      principal.valores.forEach((v, i) => {
        if (!v) { barras.push(null); return; }
        const barra = svgEl("path", {
          class: `barra${aoClicar ? " clicavel-barra" : ""}`, fill: principal.cor,
          d: caminhoColuna(x(i) - bw / 2, y(v), bw, y(0) - y(v), 4),
        });
        barra.style.setProperty("--atraso", `${Math.min(i * 18, 500)}ms`);
        barras.push(barra);
        svg.append(barra);
      });
    } else {
      const caminho = (valores) => valores.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("");
      // comparações primeiro, para ficarem por trás da série principal
      for (const s of series.slice(1)) {
        svg.append(svgEl("path", { class: "linha-serie", d: caminho(s.valores), fill: "none", stroke: s.cor, "stroke-width": 1.5, "stroke-linejoin": "round" }));
      }
      const linha = caminho(principal.valores);
      svg.append(svgEl("path", { class: "area-serie", d: `${linha}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`, fill: principal.cor, "fill-opacity": 0.12 }));
      svg.append(svgEl("path", { class: "linha-serie", d: linha, fill: "none", stroke: principal.cor, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      svg.append(cruz);
      const ultimo = principal.valores[n - 1];
      if (ultimo !== undefined) svg.append(svgEl("circle", { class: "ponto-final", cx: x(n - 1), cy: y(ultimo), r: 4, fill: principal.cor, stroke: SUPERFICIE, "stroke-width": 2 }));
      marcadores.forEach((mk) => svg.append(mk));
    }

    if (!total && !series.slice(1).some((s) => s.valores.some(Boolean))) {
      svg.append(svgEl("text", { class: "vazio-texto", x: m.l + w / 2, y: m.t + h / 2, "text-anchor": "middle" }, "Sem dados no período"));
    }

    const camada = svgEl("rect", { x: m.l, y: m.t, width: w, height: h, fill: "transparent", class: aoClicar && tipo === "area" ? "clicavel" : "" });
    svg.append(camada);

    let atual = -1;
    function destacar(i, cx, cy) {
      atual = i;
      if (!pontos[i]) return;
      if (tipo === "colunas") {
        barras.forEach((b, j) => b?.classList.toggle("is-apagada", j !== i));
      } else {
        cruz.setAttribute("x1", x(i));
        cruz.setAttribute("x2", x(i));
        cruz.setAttribute("visibility", "visible");
        series.forEach((s, j) => {
          marcadores[j].setAttribute("cx", x(i));
          marcadores[j].setAttribute("cy", y(s.valores[i]));
          marcadores[j].setAttribute("visibility", "visible");
        });
      }
      mostrarDica(cx, cy, pontos[i].dica, series.map((s) => ({ cor: s.cor, valor: formato(s.valores[i]), nome: s.nome })), aoClicar ? acao : null);
    }
    function apagar() {
      atual = -1;
      barras.forEach((b) => b?.classList.remove("is-apagada"));
      cruz.setAttribute("visibility", "hidden");
      marcadores.forEach((mk) => mk.setAttribute("visibility", "hidden"));
      esconderDica();
    }
    const indiceDe = (clientX) => {
      const r = svg.getBoundingClientRect();
      return Math.min(n - 1, Math.max(0, Math.floor((clientX - r.left - m.l) / banda)));
    };
    function destacarPorTeclado(i) {
      const r = svg.getBoundingClientRect();
      destacar(i, r.left + x(i), r.top + y(principal.valores[i]));
    }

    svg.addEventListener("pointermove", (e) => destacar(indiceDe(e.clientX), e.clientX, e.clientY));
    svg.addEventListener("pointerleave", apagar);
    svg.addEventListener("blur", apagar);
    svg.addEventListener("focus", () => { if (pontos.length) destacarPorTeclado(n - 1); });
    svg.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && aoClicar && atual >= 0) { aoClicar(atual); return; }
      if (!pontos.length || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      const proximo = atual < 0 ? n - 1 : atual + (e.key === "ArrowRight" ? 1 : -1);
      destacarPorTeclado(Math.min(n - 1, Math.max(0, proximo)));
    });
    if (aoClicar) svg.addEventListener("click", (e) => { esconderDica(); aoClicar(indiceDe(e.clientX)); });

    alvo.replaceChildren(svg);
    if (animar && !movimentoReduzido) {
      $$(".linha-serie", svg).forEach((p) => p.style.setProperty("--comprimento", String(Math.ceil(p.getTotalLength()) + 2)));
    }
  }

  // minigráfico dentro do indicador: só a forma da curva, sem eixo
  function faisca(alvo, cfg) {
    if (!configuracoes.has(alvo)) observadorTamanho.observe(alvo);
    configuracoes.set(alvo, { ...cfg, desenhar: faisca });
    const largura = Math.floor(alvo.clientWidth);
    larguras.set(alvo, largura);
    const { valores, corSerie, animar } = cfg;
    if (largura < 20 || valores.length < 2) { alvo.replaceChildren(); return; }
    const altura = 34;
    const maximo = Math.max(...valores) || 1;
    const x = (i) => (i / (valores.length - 1)) * largura;
    const y = (v) => altura - 3 - (v / maximo) * (altura - 6);
    const linha = valores.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const svg = svgEl("svg", { viewBox: `0 0 ${largura} ${altura}`, "aria-hidden": "true", class: animar && !movimentoReduzido ? "anima" : "" });
    svg.append(
      svgEl("path", { class: "area-serie", d: `${linha}L${largura},${altura}L0,${altura}Z`, fill: corSerie, "fill-opacity": 0.12 }),
      svgEl("path", { class: "linha-serie", d: linha, fill: "none", stroke: corSerie, "stroke-width": 1.5, "stroke-linejoin": "round" }),
      svgEl("circle", { class: "ponto-final", cx: x(valores.length - 1), cy: y(valores[valores.length - 1]), r: 2.5, fill: corSerie }),
    );
    alvo.replaceChildren(svg);
    if (animar && !movimentoReduzido) {
      const p = $(".linha-serie", svg);
      p.style.setProperty("--comprimento", String(Math.ceil(p.getTotalLength()) + 2));
    }
  }

  // lista de barras horizontais: [{ nome, valor, rotulo, nota, cor, aoClicar }]
  function listaBarras(alvo, itens, { vazio = "Sem dados no período.", animar = false } = {}) {
    if (!itens.length || !itens.some((i) => i.valor)) {
      alvo.replaceChildren(el("p", { class: "vazio" }, vazio));
      return;
    }
    const maximo = Math.max(...itens.map((i) => i.valor), 1);
    const lista = el("ul", { class: `lista-barras${animar && !movimentoReduzido ? " anima" : ""}` }, itens.map((i, n) => {
      const item = el("li", {
        class: `lista-barras__item${i.aoClicar ? " is-clicavel" : ""}`,
        tabindex: i.aoClicar ? 0 : null,
        title: i.titulo || null,
      },
      el("div", { class: "lista-barras__cabeca" },
        el("span", { class: "lista-barras__nome", title: i.nome }, i.nome),
        el("span", { class: "lista-barras__valor" }, i.rotulo ?? fmtNum(i.valor), i.nota ? el("small", {}, i.nota) : null)),
      el("div", { class: "trilho" },
        el("span", { class: "trilho__barra", style: { width: `${(i.valor / maximo) * 100}%`, background: i.cor, "--atraso": `${n * 70}ms` } })));
      if (i.aoClicar) {
        item.addEventListener("click", i.aoClicar);
        item.addEventListener("keydown", (e) => { if (e.key === "Enter") i.aoClicar(); });
      }
      return item;
    }));
    alvo.replaceChildren(lista);
  }

  /* ---------------------------------------------------------
     Ordenação das tabelas
     --------------------------------------------------------- */
  const CAMPOS_NUMERICOS = new Set(["ts", "visitantes", "acessos", "cadastros", "conversao", "total", "sessoes"]);

  function ordenar(lista, ordem, leitores) {
    const ler = leitores[ordem.campo] || ((o) => o[ordem.campo]);
    const sentido = ordem.dir === "asc" ? 1 : -1;
    return lista.slice().sort((a, b) => {
      const x = ler(a);
      const y = ler(b);
      if (typeof x === "number" || typeof y === "number") {
        return ((Number.isFinite(x) ? x : -1) - (Number.isFinite(y) ? y : -1)) * sentido;
      }
      return String(x ?? "").localeCompare(String(y ?? ""), "pt-BR", { numeric: true, sensitivity: "base" }) * sentido;
    });
  }

  function marcarOrdem(tabela, ordem) {
    $$("th[data-ordem]", tabela).forEach((th) => {
      th.setAttribute("aria-sort", th.dataset.ordem === ordem.campo ? (ordem.dir === "asc" ? "ascending" : "descending") : "none");
    });
  }

  function ligarOrdenacao(seletorTabela, chave) {
    $(`${seletorTabela} thead`).addEventListener("click", (e) => {
      const th = e.target.closest("th[data-ordem]");
      if (!th) return;
      const atual = prefs.ordem[chave];
      const campo = th.dataset.ordem;
      prefs.ordem[chave] = atual.campo === campo
        ? { campo, dir: atual.dir === "asc" ? "desc" : "asc" }
        : { campo, dir: CAMPOS_NUMERICOS.has(campo) ? "desc" : "asc" };
      gravarPrefs();
      render({ animar: true });
    });
  }

  /* ---------------------------------------------------------
     Aba 1: visão geral
     --------------------------------------------------------- */
  // menorMelhor: na rejeição, no abandono e no carregamento, subir é ruim
  // (a seta continua apontando o sentido; só a cor se inverte)
  function variacao(seletor, atual, anterior, modo = "relativo", menorMelhor = false, { rotulo: rotuloDado = null, confianca = null } = {}) {
    const alvo = $(seletor);
    if (anterior === null) { alvo.replaceChildren(); return; }
    const rotulo = rotuloDado || ROTULOS_PERIODO_ANTERIOR[prefs.periodo] || "vs período anterior";
    let diferenca;
    let textoVar;
    if (modo === "pontos") {
      if (!Number.isFinite(atual) || !Number.isFinite(anterior)) { alvo.textContent = `sem base ${rotulo}`; return; }
      diferenca = atual - anterior;
      textoVar = `${Math.abs(diferenca * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} p.p.`;
    } else {
      if (!anterior) { alvo.textContent = atual ? `sem base ${rotulo}` : `sem variação ${rotulo}`; return; }
      diferenca = (atual - anterior) / anterior;
      textoVar = fmtPct(Math.abs(diferenca), 0);
    }
    if (Math.abs(diferenca) < 1e-9) { alvo.textContent = `sem variação ${rotulo}`; return; }
    const sobe = diferenca > 0;
    const filhos = [
      el("span", { class: `seta ${sobe ? "seta--sobe" : "seta--desce"}${menorMelhor ? " seta--invertida" : ""}`, "aria-label": sobe ? "aumento de" : "queda de" }, sobe ? "▲ " : "▼ "),
      `${textoVar} ${rotulo}`,
    ];
    if (confianca) filhos.push(el("span", { class: `confianca confianca--${confianca.classe}` }, confianca.texto));
    alvo.replaceChildren(...filhos);
  }

  function resumo(f) {
    const visitantes = distintos(f.pvs, "visitante").size;
    return { visitantes, cadastros: f.cadastros.length, conversao: visitantes ? f.cadastros.length / visitantes : NaN, acessos: f.pvs.length };
  }

  function renderGeral(f, comp, { animar, aoVivo }) {
    const r = resumo(f);
    contar("#k-cadastros", r.cadastros, fmtNum, aoVivo);
    contar("#k-acessos", r.acessos, fmtNum, aoVivo);
    contar("#k-visitantes", r.visitantes, fmtNum, aoVivo);
    texto("#k-cadastros-nota", plural(distintos(f.cadastros, "email").size, "e-mail único", "e-mails únicos"));
    texto("#k-acessos-nota", plural(distintos(f.pvs, "sessao").size, "visita (sessão)", "visitas (sessões)"));

    // em toda a campanha os números são do período inteiro e a variação é das últimas 24 h
    const ra = comp.atual === f ? r : resumo(comp.atual);
    const a = resumo(comp.base);
    const op = { rotulo: comp.rotulo };
    variacao("#k-cadastros-delta", ra.cadastros, a.cadastros, "relativo", false, op);
    variacao("#k-acessos-delta", ra.acessos, a.acessos, "relativo", false, op);
    variacao("#k-visitantes-delta", ra.visitantes, a.visitantes, "relativo", false, op);

    // minigráficos dos indicadores, na mesma grade do período
    const grade = gradeTempo(f.inicio, f.fim, escalaDe(f.inicio, f.fim));
    for (const metrica of ["acessos", "visitantes", "cadastros", "conversao"]) {
      faisca($(`#f-${metrica}`), { valores: valoresMetrica(metrica, f, grade), corSerie: METRICAS[metrica].cor(), animar });
    }

    renderIndicadores(f, comp, aoVivo);
    renderEvolucao(f, comp, grade, animar);
    renderComparativosGeral(f, comp, animar);
    renderFunil(f, animar);
    renderBotoesGeral(f, animar);
    renderUltimos(f);
    renderRanking(f, animar);
    renderCalor(f, animar);
  }

  /* As 8 métricas de acompanhamento da página. Tempo, rolagem e formulário
     seguem as mesmas regras da aba Eventos do GTM, para os números baterem.
     - CTR dos botões: visitantes que abriram o formulário (todo botão de
       cadastro abre o formulário) ÷ visitantes únicos.
     - Rejeição: como no GA4, visita (sessão) sem engajamento, isto é, com
       menos de 10 s à vista, sem abrir o formulário e sem cadastro. Visita
       sem nenhum pulso de engajamento conta como 0 s.
     - Abandono: visitantes que abriram o formulário e não se cadastraram ÷
       visitantes que o abriram.
     - Carregamento: mediana do evento "carregamento" (LCP, ou FCP no
       navegador sem LCP; ver main.js). Até 2,5 s é "bom" para o Google. */
  const SEGUNDOS_ENGAJADA = 10;
  const CARREGAMENTO_BOM_MS = 2500;
  const ORIGENS_NO_CARTAO = 4;

  function indicadores(f) {
    const visitantes = distintos(f.pvs, "visitante");
    const engajamento = new Map(); // sessão -> maior tempo à vista e maior rolagem
    const quemAbriu = new Set();
    const sessoesComAcao = new Set();
    const cargas = [];
    for (const e of f.eventos) {
      if (e.evento === "engajamento") {
        const s = engajamento.get(e.sessao) || { segundos: 0, rolagem: 0 };
        s.segundos = Math.max(s.segundos, e.valor || 0);
        s.rolagem = Math.max(s.rolagem, parseInt(e.detalhe, 10) || 0);
        engajamento.set(e.sessao, s);
      } else if (e.evento === "lead_form_aberto") {
        if (e.visitante) quemAbriu.add(e.visitante);
        if (e.sessao) sessoesComAcao.add(e.sessao);
      } else if (e.evento === "carregamento" && e.valor > 0) {
        cargas.push(e.valor);
      }
    }
    for (const c of f.cadastros) if (c.sessao) sessoesComAcao.add(c.sessao);

    const sessoes = distintos(f.pvs, "sessao");
    let rejeitadas = 0;
    for (const s of sessoes) {
      if (!sessoesComAcao.has(s) && (engajamento.get(s)?.segundos || 0) < SEGUNDOS_ENGAJADA) rejeitadas++;
    }
    const quemCadastrou = distintos(f.cadastros, "visitante");
    const abandonaram = [...quemAbriu].filter((v) => !quemCadastrou.has(v)).length;
    const medidas = [...engajamento.values()];
    const tempos = medidas.map((m) => m.segundos);

    return {
      visitantes: visitantes.size,
      conversao: razao(f.cadastros.length, visitantes.size),
      clicaram: quemAbriu.size,
      ctr: razao(quemAbriu.size, visitantes.size),
      sessoes: sessoes.size,
      rejeitadas,
      rejeicao: razao(rejeitadas, sessoes.size),
      rolagem: medidas.length ? medidas.reduce((s, m) => s + m.rolagem, 0) / medidas.length / 100 : NaN,
      ateOFim: razao(medidas.filter((m) => m.rolagem >= 75).length, medidas.length),
      tempo: mediana(tempos),
      tempoMedio: tempos.length ? tempos.reduce((s, v) => s + v, 0) / tempos.length : NaN,
      abandonaram,
      abandono: razao(abandonaram, quemAbriu.size),
      carregamento: mediana(cargas),
      cargas: cargas.length,
      cargasBoas: razao(cargas.filter((v) => v <= CARREGAMENTO_BOM_MS).length, cargas.length),
    };
  }

  const fmtSegundos = (ms) => (Number.isFinite(ms)
    ? `${(ms / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
    : "—");

  function renderIndicadores(f, comp, aoVivo) {
    const r = indicadores(f);
    const ra = comp.atual === f ? r : indicadores(comp.atual);
    const a = indicadores(comp.base);
    const ant = (k) => a[k];
    const op = { rotulo: comp.rotulo };
    const pct = (v) => fmtPct(v);

    contar("#k-conversao", r.conversao, pct, aoVivo);
    variacao("#k-conversao-delta", ra.conversao, ant("conversao"), "pontos", false,
      { ...op, confianca: confiancaProporcao(comp.atual.cadastros.length, ra.visitantes, comp.base.cadastros.length, a.visitantes) });

    contar("#k-ctr", r.ctr, pct, aoVivo);
    variacao("#k-ctr-delta", ra.ctr, ant("ctr"), "pontos", false,
      { ...op, confianca: confiancaProporcao(ra.clicaram, ra.visitantes, a.clicaram, a.visitantes) });
    texto("#k-ctr-nota", `${plural(r.clicaram, "visitante clicou", "visitantes clicaram")} num botão de cadastro`);

    contar("#k-rejeicao", r.rejeicao, pct, aoVivo);
    variacao("#k-rejeicao-delta", ra.rejeicao, ant("rejeicao"), "pontos", true, op);
    texto("#k-rejeicao-nota", r.sessoes
      ? `${fmtNum(r.rejeitadas)} de ${plural(r.sessoes, "visita", "visitas")} com menos de 10 s e sem clicar em botão de cadastro`
      : "visitas com menos de 10 s e sem clicar em botão de cadastro");

    contar("#k-rolagem-geral", r.rolagem, (v) => fmtPct(v, 0), aoVivo);
    variacao("#k-rolagem-geral-delta", ra.rolagem, ant("rolagem"), "pontos", false, op);
    texto("#k-rolagem-geral-nota", Number.isFinite(r.ateOFim)
      ? `média por visita · ${fmtPct(r.ateOFim, 0)} passaram de 75% da página`
      : "média da maior rolagem de cada visita");

    contar("#k-tempo-geral", r.tempo, fmtDuracao, aoVivo);
    variacao("#k-tempo-geral-delta", ra.tempo, ant("tempo"), "relativo", false, op);
    texto("#k-tempo-geral-nota", Number.isFinite(r.tempoMedio)
      ? `mediana com a página à vista · média ${fmtDuracao(r.tempoMedio)}`
      : "mediana do tempo com a página à vista");

    contar("#k-abandono", r.abandono, pct, aoVivo);
    variacao("#k-abandono-delta", ra.abandono, ant("abandono"), "pontos", true, op);
    texto("#k-abandono-nota", r.clicaram
      ? `não concluíram: ${fmtNum(r.abandonaram)} de ${fmtNum(r.clicaram)} que abriram o formulário`
      : "abriram o formulário e não se cadastraram");

    contar("#k-carregamento", r.carregamento, fmtSegundos, aoVivo);
    variacao("#k-carregamento-delta", ra.carregamento, a.cargas ? a.carregamento : null, "relativo", true, op);
    texto("#k-carregamento-nota", r.cargas
      ? `mediana até a primeira tela aparecer · ${fmtPct(r.cargasBoas, 0)} em até 2,5 s`
      : "sem medição no período: começou na versão da LP de 03/11/2026");

    renderOrigensGeral(f);
  }

  // cartão 8: conversão das origens (utm_source) com mais visitantes;
  // clicar filtra o painel inteiro pela origem, como no ranking
  function renderOrigensGeral(f) {
    const grupos = new Map();
    const grupo = (v) => {
      let g = grupos.get(v);
      if (!g) grupos.set(v, (g = { v, visitantes: new Set(), cadastros: 0 }));
      return g;
    };
    for (const p of f.pvs) if (p.visitante) grupo(p.utm_source || "").visitantes.add(p.visitante);
    for (const c of f.cadastros) grupo(c.utm_source || "").cadastros++;
    const itens = [...grupos.values()]
      .sort((x, y) => y.visitantes.size - x.visitantes.size || y.cadastros - x.cadastros)
      .slice(0, ORIGENS_NO_CARTAO)
      .map((g) => ({ ...g, taxa: razao(g.cadastros, g.visitantes.size) }));
    const alvo = $("#k-origens");
    if (!itens.length) {
      alvo.replaceChildren(el("li", { class: "vazio" }, "Sem visitas no período."));
      return;
    }
    const maior = Math.max(...itens.map((g) => (Number.isFinite(g.taxa) ? g.taxa : 0)), 1e-9);
    alvo.replaceChildren(...itens.map((g) => {
      const ativo = prefs.filtros.utm_source?.includes(g.v || VAZIO);
      const botao = el("button", {
        type: "button",
        class: `mini-origens__item${ativo ? " is-ativo" : ""}`,
        title: `${ativo ? "Remover este filtro" : "Filtrar o painel por esta origem"} · ${plural(g.cadastros, "cadastro", "cadastros")} de ${plural(g.visitantes.size, "visitante", "visitantes")}`,
      },
      el("span", { class: "mini-origens__nome" }, `${ativo ? "✓ " : ""}${g.v || "(sem UTM)"}`),
      el("span", { class: "mini-origens__taxa" }, fmtPct(g.taxa), el("small", {}, `${fmtNum(g.visitantes.size)} vis.`)),
      el("span", { class: "mini-origens__trilho", "aria-hidden": "true" },
        el("span", { style: { width: `${((Number.isFinite(g.taxa) ? g.taxa : 0) / maior) * 100}%` } })));
      botao.addEventListener("click", () => alternarFiltro("utm_source", g.v));
      return el("li", {}, botao);
    }));
  }

  function renderEvolucao(f, comp, grade, animar) {
    const anterior = comp.mesmoRecorte ? comp.base : null;
    const metrica = METRICAS[prefs.metrica] ? prefs.metrica : "acessos";
    const def = METRICAS[metrica];
    $$("#metricas button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.metrica === metrica)));
    $$("#granularidades button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.granularidade === prefs.granularidade)));
    const comparar = $("#comparar");
    comparar.disabled = !anterior;
    comparar.checked = Boolean(anterior && prefs.comparar);

    const series = [{ nome: def.nome, cor: def.cor(), valores: valoresMetrica(metrica, f, grade) }];
    if (anterior && prefs.comparar) {
      series.push({ nome: `${def.nome} (${nomeDaBase(comp.j)})`, cor: CORES.anterior, valores: valoresMetrica(metrica, anterior, grade, comp.deslocamento) });
    }
    const porDia = grade.escala === DIA;
    texto("#evolucao-sub", `${def.nome} ${porDia ? "por dia · clique num dia para ver as horas" : "por hora"}`);
    grafico($("#g-evolucao"), {
      pontos: grade.pontos,
      series,
      tipo: "area",
      formato: def.formato,
      inteiro: !def.fracao,
      animar,
      acao: "Clique para ver este dia hora a hora",
      aoClicar: porDia ? (i) => {
        const t = grade.pontos[i].t;
        prefs.periodo = "personalizado";
        prefs.de = paraCampoData(t);
        prefs.ate = paraCampoData(t + DIA);
        prefs.granularidade = "auto";
        aplicarFiltros();
      } : null,
    });
    $("#legenda-evolucao").replaceChildren(...(series.length > 1 ? series.map((s) => el("span", { class: "legenda__item" },
      el("span", { class: "legenda__linha", style: { background: s.cor } }), s.nome)) : []));
  }

  // aberturas do formulário e cadastros por botão (cta), no período e filtros
  function contarBotoes(f) {
    const porBotao = new Map();
    const botao = (cta) => {
      const chave = cta || "";
      let b = porBotao.get(chave);
      if (!b) porBotao.set(chave, (b = { cta: chave, aberturas: 0, cadastros: 0 }));
      return b;
    };
    for (const e of f.eventos) if (e.evento === "lead_form_aberto") botao(e.detalhe).aberturas++;
    for (const c of f.cadastros) botao(c.cta).cadastros++;
    return [...porBotao.values()];
  }

  function renderBotoesGeral(f, animar) {
    const lista = contarBotoes(f).filter((b) => b.cadastros).sort((a, b) => b.cadastros - a.cadastros || b.aberturas - a.aberturas).slice(0, 5);
    if (!lista.length) {
      $("#botoes-geral").replaceChildren(el("p", { class: "vazio" }, "Nenhum cadastro no período."));
      return;
    }
    listaBarras($("#botoes-geral"), lista.map((b) => ({
      nome: CTAS[b.cta] || b.cta || "(sem identificação)",
      valor: b.cadastros,
      rotulo: plural(b.cadastros, "cadastro", "cadastros"),
      nota: `${plural(b.aberturas, "abertura", "aberturas")} · ${fmtPct(b.aberturas ? b.cadastros / b.aberturas : NaN)}`,
      cor: CORES.cadastros,
    })), { animar });
  }

  function renderFunil(f, animar) {
    const visitantes = distintos(f.pvs, "visitante");
    const abriram = distintos(f.eventos.filter((e) => e.evento === "lead_form_aberto"), "visitante");
    const cadastraram = new Set(f.cadastros.map((c) => c.visitante || c.email));
    const etapas = [
      ["Visitaram a página", visitantes.size],
      ["Abriram o formulário", abriram.size],
      ["Se cadastraram", cadastraram.size],
    ];
    listaBarras($("#funil"), etapas.map(([nome, valor], i) => ({
      nome,
      valor,
      cor: CORES.funil[i],
      nota: i === 0 ? null : `${fmtPct(etapas[i - 1][1] ? valor / etapas[i - 1][1] : NaN)} da etapa anterior`,
    })), { animar });
  }

  const novosIds = new Set();

  function renderUltimos(f) {
    const ultimos = f.cadastros.slice().sort((x, y) => y.ts - x.ts).slice(0, 7);
    const alvo = $("#ultimos");
    if (!ultimos.length) {
      alvo.replaceChildren(el("li", { class: "vazio" }, "Nenhum cadastro no período."));
      return;
    }
    alvo.replaceChildren(...ultimos.map((c) => {
      const item = el("li", { class: novosIds.has(c.id) ? "is-novo" : null, tabindex: 0, title: "Ver o cadastro", style: { cursor: "pointer" } },
        el("span", { class: "ultimos__avatar", "aria-hidden": "true" }, iniciais(c.nome)),
        el("span", { class: "ultimos__nome" }, c.nome || c.email || "—"),
        el("time", { class: "ultimos__tempo", dataset: { ts: c.ts }, datetime: new Date(c.ts).toISOString(), title: fmtDataHora.format(c.ts) }, fmtRelativo(c.ts)),
        el("span", { class: "ultimos__origem" }, [origemMidia(c), c.utm_campaign, CTAS[c.cta] || c.cta].filter(Boolean).join(" · ")));
      item.addEventListener("click", () => abrirDetalhe(c.id));
      item.addEventListener("keydown", (e) => { if (e.key === "Enter") abrirDetalhe(c.id); });
      return item;
    }));
  }

  const RANKINGS = {
    utm_source: { nome: "Origem", vazio: "(sem UTM)" },
    utm_campaign: { nome: "Campanha", vazio: "(sem UTM)" },
    utm_content: { nome: "Conjunto", vazio: "(sem UTM)" },
    utm_term: { nome: "Anúncio", vazio: "(sem UTM)" },
    dispositivo: { nome: "Dispositivo", vazio: "(desconhecido)", mostrar: capitalizar },
    estado: { nome: "Estado", vazio: "(desconhecido)" },
  };

  (function montarRanking() {
    $("#ranking-dimensoes").replaceChildren(...Object.entries(RANKINGS).map(([k, d]) => el("button", { type: "button", dataset: { ranking: k } }, d.nome)));
  })();

  function renderRanking(f, animar) {
    const k = RANKINGS[prefs.ranking] ? prefs.ranking : "utm_source";
    const def = RANKINGS[k];
    $$("#ranking-dimensoes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ranking === k)));
    const grupos = new Map();
    const grupo = (v) => {
      let g = grupos.get(v);
      if (!g) grupos.set(v, (g = { v, cadastros: 0, visitantes: new Set() }));
      return g;
    };
    for (const p of f.pvs) if (p.visitante) grupo(p[k] || "").visitantes.add(p.visitante);
    for (const c of f.cadastros) grupo(c[k] || "").cadastros++;
    const itens = [...grupos.values()]
      .sort((x, y) => y.cadastros - x.cadastros || y.visitantes.size - x.visitantes.size)
      .slice(0, 7);
    listaBarras($("#ranking"), itens.map((g) => {
      const ativo = prefs.filtros[k]?.includes(g.v || VAZIO);
      return {
        nome: `${ativo ? "✓ " : ""}${g.v ? (def.mostrar ? def.mostrar(g.v) : g.v) : def.vazio}`,
        valor: g.cadastros,
        rotulo: plural(g.cadastros, "cadastro", "cadastros"),
        nota: `${fmtNum(g.visitantes.size)} vis. · ${fmtPct(g.visitantes.size ? g.cadastros / g.visitantes.size : NaN)}`,
        cor: CORES.cadastros,
        titulo: ativo ? "Remover este filtro" : "Filtrar o painel por este valor",
        aoClicar: () => alternarFiltro(k, g.v),
      };
    }), { animar, vazio: "Nenhum cadastro no período." });
  }

  function renderCalor(f, animar) {
    const metrica = prefs.calor === "cadastros" ? "cadastros" : "acessos";
    $$("#calor-metricas button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.calor === metrica)));
    const lista = metrica === "cadastros" ? f.cadastros : f.pvs;
    const corSerie = CORES[metrica];
    const matriz = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const o of lista) {
      const p = partes(o.ts);
      matriz[p.semana][p.hora]++;
    }
    const maximo = Math.max(1, ...matriz.flat());
    const celulas = [el("span", {})];
    for (let h = 0; h < 24; h++) celulas.push(el("span", { class: "calor__hora" }, h % 3 ? "" : `${h}h`));
    matriz.forEach((linha, d) => {
      celulas.push(el("span", { class: "calor__dia" }, DIAS_SEMANA[d]));
      linha.forEach((v, h) => celulas.push(el("span", {
        class: "calor__celula",
        dataset: { dia: d, hora: h, valor: v },
        style: { background: v ? rgba(corSerie, 0.12 + 0.88 * (v / maximo)) : "", "--atraso": `${Math.min(h * 14 + d * 22, 600)}ms` },
      })));
    });
    const grade = el("div", { class: `calor__grade${animar && !movimentoReduzido ? " anima" : ""}`, role: "img", "aria-label": `${metrica} por dia da semana e hora` }, celulas);
    grade.addEventListener("pointerover", (e) => {
      const c = e.target.closest(".calor__celula");
      if (!c) return;
      const h = Number(c.dataset.hora);
      mostrarDica(e.clientX, e.clientY, `${DIAS_SEMANA_LONGOS[c.dataset.dia]}, ${h}h–${(h + 1) % 24}h`,
        [{ cor: corSerie, valor: fmtNum(Number(c.dataset.valor)), nome: metrica }]);
    });
    grade.addEventListener("pointerleave", esconderDica);
    const escala = el("div", { class: "calor__escala" }, "menos",
      [0.12, 0.34, 0.56, 0.78, 1].map((a) => el("span", { style: { background: rgba(corSerie, a) } })), "mais");
    $("#calor").replaceChildren(grade, escala);
  }

  /* ---------------------------------------------------------
     Aba 2: cadastros
     --------------------------------------------------------- */
  const estadoTabela = { pagina: 0, lista: [] };
  const LEITORES_CADASTRO = {
    origem: origemMidia,
    local,
    cta: (c) => CTAS[c.cta] || c.cta,
  };

  function renderCadastros(f, { animar, aoVivo }) {
    const termo = normalizar($("#busca").value.trim());
    const digitosTermo = termo.replace(/\D/g, "");
    let lista = f.cadastros;
    if (termo) {
      lista = lista.filter((c) => normalizar(`${c.nome || ""} ${c.email || ""}`).includes(termo)
        || (digitosTermo.length >= 3 && (c.telefone || "").includes(digitosTermo)));
    }
    lista = ordenar(lista, prefs.ordem.cadastros, LEITORES_CADASTRO);
    estadoTabela.lista = lista;
    marcarOrdem($("#tabela-cadastros"), prefs.ordem.cadastros);

    const unicos = distintos(f.cadastros, "email").size;
    contar("#c-total", f.cadastros.length, fmtNum, aoVivo);
    contar("#c-unicos", unicos, fmtNum, aoVivo);
    contar("#c-repetidos", f.cadastros.length - unicos, fmtNum, aoVivo);
    const maisRecente = f.cadastros.reduce((m, c) => (c.ts > (m?.ts ?? -1) ? c : m), null);
    texto("#c-ultimo", maisRecente ? fmtRelativo(maisRecente.ts) : "—");
    $("#c-ultimo").dataset.ts = maisRecente ? maisRecente.ts : "";
    texto("#c-ultimo-nota", maisRecente ? `${maisRecente.nome || maisRecente.email} · ${fmtDataHora.format(maisRecente.ts)}` : "");

    const porPagina = [25, 50, 100].includes(Number(prefs.porPagina)) ? Number(prefs.porPagina) : 50;
    $("#por-pagina").value = String(porPagina);
    const paginas = Math.max(1, Math.ceil(lista.length / porPagina));
    estadoTabela.pagina = Math.min(estadoTabela.pagina, paginas - 1);
    const inicio = estadoTabela.pagina * porPagina;
    const pagina = lista.slice(inicio, inicio + porPagina);

    const tabela = $("#tabela-cadastros");
    tabela.classList.toggle("anima-linhas", Boolean(animar && !movimentoReduzido));
    const corpo = $("tbody", tabela);
    if (!pagina.length) {
      corpo.replaceChildren(el("tr", {}, el("td", { class: "vazio", colspan: 11 }, termo ? "Nenhum cadastro encontrado para essa busca." : "Nenhum cadastro no período.")));
    } else {
      corpo.replaceChildren(...pagina.map((c, i) => el("tr", {
        tabindex: 0, dataset: { id: c.id }, class: novosIds.has(c.id) ? "is-novo" : null,
        style: { "--atraso": `${Math.min(i * 14, 350)}ms` },
      },
      el("td", { title: fmtDataHora.format(c.ts) }, fmtDataCurta.format(c.ts).replace(",", "")),
      el("td", { class: "forte", title: c.nome || "" }, destacarTermo(c.nome || "—", termo),
        (dados.emails.get(c.email) || 0) > 1 ? el("span", { class: "etiqueta etiqueta--repetido", title: "Este e-mail tem mais de um cadastro" }, "repetido") : null),
      el("td", { title: c.email || "" }, destacarTermo(c.email || "—", termo)),
      el("td", {}, c.telefone ? el("a", { href: `https://wa.me/55${c.telefone}`, target: "_blank", rel: "noopener noreferrer" }, fmtTelefone(c.telefone)) : "—"),
      el("td", { title: origemMidia(c) }, origemMidia(c)),
      el("td", { title: c.utm_campaign || "" }, c.utm_campaign || "—"),
      el("td", { title: c.utm_content || "" }, c.utm_content || "—"),
      el("td", { title: c.utm_term || "" }, c.utm_term || "—"),
      el("td", { title: CTAS[c.cta] || c.cta || "" }, CTAS[c.cta] || c.cta || "—"),
      el("td", {}, capitalizar(c.dispositivo) || "—"),
      el("td", {}, local(c) || "—"))));
    }

    texto("#paginacao-texto", lista.length
      ? `Mostrando ${fmtNum(inicio + 1)}–${fmtNum(inicio + pagina.length)} de ${plural(lista.length, "cadastro", "cadastros")}`
      : "");
    $("#pagina-anterior").disabled = estadoTabela.pagina === 0;
    $("#pagina-proxima").disabled = estadoTabela.pagina >= paginas - 1;
  }

  function abrirDetalhe(id) {
    const c = dados.cadastros.find((x) => x.id === id);
    if (!c) return;
    texto("#detalhe-titulo", c.nome || c.email || "Cadastro");

    const campo = (rotulo, valor) => el("div", {}, el("dt", {}, rotulo), el("dd", {}, valor || "—"));
    const visitas = c.visitante ? distintos(dados.pageviews.filter((p) => p.visitante === c.visitante), "sessao").size : 0;
    const campos = el("dl", { class: "campos" },
      campo("Data e hora", fmtDataHora.format(c.ts)),
      campo("E-mail", c.email),
      campo("WhatsApp", c.telefone ? el("a", { href: `https://wa.me/55${c.telefone}`, target: "_blank", rel: "noopener noreferrer" }, fmtTelefone(c.telefone)) : ""),
      campo("Cadastros com este e-mail", fmtNum(dados.emails.get(c.email) || 1)),
      campo("Botão", CTAS[c.cta] || c.cta),
      campo("utm_source", c.utm_source),
      campo("utm_medium", c.utm_medium),
      campo("utm_campaign", c.utm_campaign),
      campo("Conjunto (utm_content)", c.utm_content),
      campo("Anúncio (utm_term)", c.utm_term),
      campo("Clique de anúncio", c.clique),
      campo("Site de referência", c.referencia),
      campo("Dispositivo", [capitalizar(c.dispositivo), c.sistema, c.navegador].filter(Boolean).join(" · ")),
      campo("Local", local(c)),
      campo("Visitas deste navegador", visitas ? fmtNum(visitas) : ""),
      campo("URL de entrada", c.url));

    const daSessao = c.sessao ? dados.eventos.filter((e) => e.sessao === c.sessao).sort((x, y) => x.ts - y.ts) : [];
    const engajamento = daSessao.filter((e) => e.evento === "engajamento");
    const passos = daSessao.filter((e) => e.evento !== "engajamento");
    const jornada = passos.length
      ? el("ol", { class: "jornada" }, passos.map((e) => el("li", {},
        el("time", {}, fmtHora.format(e.ts)),
        el("span", {}, EVENTOS[e.evento] || e.evento, detalheLegivel(e) ? ` · ${detalheLegivel(e)}` : ""))))
      : el("p", { class: "vazio" }, "Sem eventos registrados para esta sessão.");
    const resumoEng = engajamento.length
      ? el("p", { class: "vazio" }, `Tempo com a página à vista: ${fmtDuracao(Math.max(...engajamento.map((e) => e.valor || 0)))} · rolagem máxima: ${Math.max(...engajamento.map((e) => parseInt(e.detalhe, 10) || 0))}%`)
      : null;

    $("#detalhe-corpo").replaceChildren(campos, el("section", {}, el("h3", {}, "Jornada na sessão do cadastro"), jornada, resumoEng));
    $("#detalhe").showModal();
  }

  function exportarCsv() {
    const colunas = [
      ["Data e hora", (c) => fmtDataHora.format(c.ts)],
      ["Nome", (c) => c.nome],
      ["E-mail", (c) => c.email],
      ["WhatsApp", (c) => (c.telefone ? `55${c.telefone}` : "")],
      ["utm_source", (c) => c.utm_source],
      ["utm_medium", (c) => c.utm_medium],
      ["utm_campaign", (c) => c.utm_campaign],
      ["Conjunto (utm_content)", (c) => c.utm_content],
      ["Anúncio (utm_term)", (c) => c.utm_term],
      ["Botão", (c) => CTAS[c.cta] || c.cta],
      ["Dispositivo", (c) => c.dispositivo],
      ["Navegador", (c) => c.navegador],
      ["Sistema", (c) => c.sistema],
      ["Cidade", (c) => c.cidade],
      ["Estado", (c) => c.estado],
      ["País", (c) => c.pais],
      ["Site de referência", (c) => c.referencia],
      ["Clique de anúncio", (c) => c.clique],
      ["URL de entrada", (c) => c.url],
    ];
    // valores iniciados por = + - @ viram fórmula no Excel; o apóstrofo impede
    const celula = (v) => {
      let s = v === undefined || v === null ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const linhas = [colunas.map(([n]) => n), ...estadoTabela.lista.map((c) => colunas.map(([, ler]) => ler(c)))];
    const csv = `﻿${linhas.map((l) => l.map(celula).join(";")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const p = partes(relogio());
    const link = el("a", { href: url, download: `cadastros-esquenta-black-${doisDigitos(p.dia)}-${doisDigitos(p.mes)}-${p.hora}h.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------------------------------------------------------
     Aba 3: origens e UTMs
     --------------------------------------------------------- */
  const DIMENSOES = {
    utm_source: { nome: "Origem", vazio: "(sem UTM)", filtro: "utm_source" },
    utm_medium: { nome: "Mídia", vazio: "(sem UTM)", filtro: "utm_medium" },
    utm_campaign: { nome: "Campanha", vazio: "(sem UTM)", filtro: "utm_campaign" },
    utm_content: { nome: "Conjunto de anúncios", vazio: "(sem UTM)", filtro: "utm_content" },
    utm_term: { nome: "Anúncio (criativo)", vazio: "(sem UTM)", filtro: "utm_term" },
    origem_midia: {
      nome: "Origem / mídia",
      vazio: "(sem UTM)",
      ler: (o) => (o.utm_source || o.utm_medium ? `${o.utm_source || "—"} / ${o.utm_medium || "—"}` : ""),
      combinado: true,
    },
    referencia: { nome: "Site de referência", vazio: "(direto ou sem referência)" },
    clique: { nome: "Clique de anúncio", vazio: "(sem identificador)" },
    dispositivo: { nome: "Dispositivo", vazio: "(desconhecido)", filtro: "dispositivo", mostrar: capitalizar },
    navegador: { nome: "Navegador", vazio: "(desconhecido)" },
    sistema: { nome: "Sistema", vazio: "(desconhecido)" },
    estado: { nome: "Estado", vazio: "(desconhecido)", filtro: "estado" },
    cidade: { nome: "Cidade", vazio: "(desconhecida)", ler: local },
  };

  (function montarDimensoes() {
    $("#dimensoes").replaceChildren(...Object.entries(DIMENSOES).map(([chave, d]) => el("button", {
      type: "button", dataset: { dimensao: chave },
    }, d.nome)));
  })();

  function renderOrigens(f, { animar, aoVivo }) {
    const chave = DIMENSOES[prefs.dimensao] ? prefs.dimensao : "utm_source";
    const dim = DIMENSOES[chave];
    const ler = dim.ler || ((o) => o[chave] || "");

    $$("#dimensoes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.dimensao === chave)));
    texto("#dimensao-nome", dim.nome.toLowerCase());
    texto("#origens-coluna", dim.nome);

    // indicadores por visita (sessão)
    const sessoes = new Map();
    for (const p of f.pvs) if (!sessoes.has(p.sessao)) sessoes.set(p.sessao, p);
    const total = sessoes.size;
    let comUtm = 0;
    let anuncio = 0;
    let semOrigem = 0;
    for (const s of sessoes.values()) {
      const temUtm = Boolean(s.utm_source || s.utm_medium || s.utm_campaign);
      if (temUtm) comUtm++;
      if (s.clique) anuncio++;
      if (!temUtm && !s.referencia && !s.clique) semOrigem++;
    }
    contar("#k-com-utm", total ? comUtm / total : NaN, (v) => fmtPct(v), aoVivo);
    texto("#k-com-utm-nota", `${fmtNum(comUtm)} de ${plural(total, "visita", "visitas")}`);
    contar("#k-anuncio", total ? anuncio / total : NaN, (v) => fmtPct(v), aoVivo);
    contar("#k-sem-origem", total ? semOrigem / total : NaN, (v) => fmtPct(v), aoVivo);

    const linhas = new Map();
    const linha = (valor) => {
      let l = linhas.get(valor);
      if (!l) linhas.set(valor, (l = { valor, visitantesSet: new Set(), acessos: 0, cadastros: 0 }));
      return l;
    };
    for (const p of f.pvs) {
      const l = linha(ler(p));
      l.acessos++;
      if (p.visitante) l.visitantesSet.add(p.visitante);
    }
    for (const c of f.cadastros) linha(ler(c)).cadastros++;
    for (const l of linhas.values()) {
      l.visitantes = l.visitantesSet.size;
      l.conversao = l.visitantes ? l.cadastros / l.visitantes : NaN;
      l.nome = l.valor ? (dim.mostrar ? dim.mostrar(l.valor) : l.valor) : dim.vazio;
    }

    const termo = normalizar($("#busca-origens").value.trim());
    let lista = [...linhas.values()];
    if (termo) lista = lista.filter((l) => normalizar(l.nome).includes(termo));
    lista = ordenar(lista, prefs.ordem.origens, { valor: (l) => l.nome }).slice(0, 300);
    marcarOrdem($("#tabela-origens"), prefs.ordem.origens);

    const totalCadastros = f.cadastros.length;
    const tabela = $("#tabela-origens");
    tabela.classList.toggle("anima-linhas", Boolean(animar && !movimentoReduzido));
    const corpo = $("tbody", tabela);
    if (!lista.length) {
      corpo.replaceChildren(el("tr", {}, el("td", { class: "vazio", colspan: 6 }, termo ? "Nada encontrado para essa busca." : "Sem dados no período.")));
      return;
    }
    const filtravel = Boolean(dim.filtro || dim.combinado);
    corpo.replaceChildren(...lista.map((l, i) => {
      const ativo = dim.filtro && prefs.filtros[dim.filtro]?.includes(l.valor || VAZIO);
      return el("tr", {
        tabindex: filtravel ? 0 : null,
        title: filtravel ? (ativo ? "Remover este filtro" : "Filtrar o painel por este valor") : null,
        class: ativo ? "is-selecionado" : null,
        dataset: filtravel ? { valor: l.valor, dimensao: chave } : {},
        style: { "--atraso": `${Math.min(i * 14, 350)}ms` },
      },
      el("td", { class: "forte", title: l.nome }, destacarTermo(l.nome, termo)),
      el("td", { class: "num" }, fmtNum(l.visitantes)),
      el("td", { class: "num" }, fmtNum(l.acessos)),
      el("td", { class: "num" }, fmtNum(l.cadastros)),
      el("td", { class: "num" }, fmtPct(l.conversao)),
      el("td", { class: "col-barra" }, el("div", { class: `trilho${animar && !movimentoReduzido ? " anima" : ""}`, title: fmtPct(totalCadastros ? l.cadastros / totalCadastros : 0) },
        el("span", { class: "trilho__barra", style: { width: `${totalCadastros ? (l.cadastros / totalCadastros) * 100 : 0}%`, background: CORES.cadastros, "--atraso": `${Math.min(i * 30, 600)}ms` } }))));
    }));
  }

  function filtrarPorLinha(linhaTabela) {
    const dim = DIMENSOES[linhaTabela.dataset.dimensao];
    const valor = linhaTabela.dataset.valor;
    if (dim.combinado) {
      // "origem / mídia": a linha guarda o texto combinado; vira os dois filtros
      const [origem, midia] = valor ? valor.split(" / ") : ["", ""];
      prefs.filtros.utm_source = [origem && origem !== "—" ? origem : VAZIO];
      prefs.filtros.utm_medium = [midia && midia !== "—" ? midia : VAZIO];
      aplicarFiltros();
    } else if (dim.filtro) {
      alternarFiltro(dim.filtro, valor);
    }
  }

  /* ---------------------------------------------------------
     Aba Campanhas: eficiência de cada campanha e de cada conjunto de
     anúncios, julgada contra a média da própria página no período, com
     dicas do que fazer. Sem gasto por enquanto (falta a chave de leitura do
     Data Gateway); a comparação com a LP Esquenta Black vem do Worker.
     --------------------------------------------------------- */
  const MIN_VISITANTES = 30; // abaixo disso, a campanha ainda não é julgada
  const MIN_DUELO = 30;
  const SEM_CAMPANHA = "(sem campanha)";
  const SINAIS = {
    bom: { nome: "Acima da média", classe: "bom" },
    media: { nome: "Na média", classe: "media" },
    atencao: { nome: "Atenção", classe: "atencao" },
    ruim: { nome: "Abaixo da média", classe: "ruim" },
    pouco: { nome: "Pouco volume", classe: "pouco" },
  };
  // diferença entre duas proporções (z do teste de duas proporções)
  function zDuas(x1, n1, x2, n2) {
    if (!n1 || !n2) return 0;
    const p = (x1 + x2) / (n1 + n2);
    const erro = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    return erro ? (x1 / n1 - x2 / n2) / erro : 0;
  }
  // visitantes por grupo para separar p1 de p2 com 95% de confiança e 80% de poder
  function amostraNecessaria(p1, p2) {
    const d = Math.abs(p1 - p2);
    if (!d) return Infinity;
    return Math.ceil(((1.96 + 0.84) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / d ** 2);
  }
  const razao = (a, b) => (b ? a / b : NaN);

  // um grupo do funil: visitantes, quem abriu o formulário, cadastros e o
  // engajamento (maior tempo e rolagem de cada visita)
  const novoGrupo = (nome) => ({
    nome, visitantes: new Set(), formulario: new Set(), cadastros: 0,
    sessoes: new Map(), celular: new Set(), cadCelular: 0, cadComputador: 0, computador: new Set(),
    pvs: [], cads: [],
  });

  function montarCampanhas(f) {
    const campanhas = new Map();
    const pegar = (mapa, chave, criar) => {
      if (!mapa.has(chave)) mapa.set(chave, criar());
      return mapa.get(chave);
    };
    const total = novoGrupo("página");
    const gruposDe = (o) => {
      const c = pegar(campanhas, o.utm_campaign || SEM_CAMPANHA, () => ({ ...novoGrupo(o.utm_campaign || SEM_CAMPANHA), conjuntos: new Map(), fonte: o }));
      const j = pegar(c.conjuntos, o.utm_content || "(sem conjunto)", () => novoGrupo(o.utm_content || "(sem conjunto)"));
      return [total, c, j];
    };
    for (const p of f.pvs) {
      for (const g of gruposDe(p)) {
        if (p.visitante) {
          g.visitantes.add(p.visitante);
          (p.dispositivo === "celular" ? g.celular : g.computador).add(p.visitante);
        }
        if (p.sessao && !g.sessoes.has(p.sessao)) g.sessoes.set(p.sessao, { tempo: 0, rolagem: 0 });
        g.pvs.push(p);
      }
    }
    for (const e of f.eventos) {
      if (e.evento !== "lead_form_aberto" && e.evento !== "engajamento") continue;
      const pv = sessaoDe(e);
      if (!pv) continue;
      for (const g of gruposDe(pv)) {
        if (e.evento === "lead_form_aberto") { if (e.visitante) g.formulario.add(e.visitante); continue; }
        const s = g.sessoes.get(e.sessao);
        if (!s) continue;
        s.tempo = Math.max(s.tempo, Number(e.valor) || 0);
        s.rolagem = Math.max(s.rolagem, Number(e.detalhe) || 0);
      }
    }
    for (const c of f.cadastros) {
      for (const g of gruposDe(c)) {
        g.cadastros++;
        g.cads.push(c);
        if (c.dispositivo === "celular") g.cadCelular++; else g.cadComputador++;
      }
    }
    const fechar = (g) => {
      g.nVis = g.visitantes.size;
      g.nForm = g.formulario.size;
      g.conv = razao(g.cadastros, g.nVis);
      g.abre = razao(g.nForm, g.nVis);
      g.fecha = razao(g.cadastros, g.nForm);
      const sessoes = [...g.sessoes.values()];
      g.tempoMed = sessoes.length ? mediana(sessoes.map((s) => s.tempo)) : NaN;
      g.rolagemMed = sessoes.length ? mediana(sessoes.map((s) => s.rolagem)) : NaN;
      g.convCelular = razao(g.cadCelular, g.celular.size);
      g.convComputador = razao(g.cadComputador, g.computador.size);
      return g;
    };
    fechar(total);
    const lista = [...campanhas.values()].map((c) => {
      fechar(c);
      c.listaConjuntos = [...c.conjuntos.values()].map(fechar).sort((a, b) => b.nVis - a.nVis);
      return c;
    }).sort((a, b) => (a.nome === SEM_CAMPANHA) - (b.nome === SEM_CAMPANHA) || b.nVis - a.nVis);
    return { total, lista };
  }

  // sinal contra o resto da página: só sai da "média" com diferença confiável
  function sinalDe(g, total) {
    if (g.nVis < MIN_VISITANTES) return "pouco";
    const outrosVis = total.nVis - g.nVis;
    const outrosCad = total.cadastros - g.cadastros;
    if (outrosVis < MIN_VISITANTES) return "media";
    const z = zDuas(g.cadastros, g.nVis, outrosCad, outrosVis);
    const rel = razao(g.conv, razao(outrosCad, outrosVis));
    if (z >= 1.64) return "bom";
    if (z <= -1.64) return rel <= 0.6 || !g.cadastros ? "ruim" : "atencao";
    return "media";
  }

  const comoPct = (x) => fmtPct(x, x < 0.1 ? 1 : 0);

  // dicas: o que chama a atenção no funil da campanha e o que fazer
  function dicasDe(c, total, sinal) {
    const dicas = [];
    const resto = razao(total.cadastros - c.cadastros, total.nVis - c.nVis);
    const dica = (tipo, iconeNome, textoDica, acao) => dicas.push({ tipo, icone: iconeNome, texto: textoDica, acao });
    if (/\{\{.*\}\}/.test(c.nome) || c.listaConjuntos?.some((j) => /\{\{.*\}\}/.test(j.nome))) {
      dica("ruim", "alerta", "O nome chegou como {{...}}: o parâmetro dinâmico do Meta não foi preenchido. Corrija a URL do anúncio, ou as visitas dele ficam sem campanha.");
    }
    if (sinal === "pouco") {
      dica("pouco", "relogio", `Ainda com ${plural(c.nVis, "visitante", "visitantes")}: a partir de ${MIN_VISITANTES} o painel compara com a média da página.`);
      return dicas;
    }
    if (sinal === "bom") {
      dica("bom", "subindo", `Converte ${comoPct(c.conv)}, contra ${comoPct(resto)} no resto da página. Candidata a receber mais verba.`);
    }
    if (total.abre > 0 && c.abre < total.abre * 0.7) {
      dica("atencao", "clique", `Só ${comoPct(c.abre)} abrem o formulário (média da página: ${comoPct(total.abre)}). O anúncio pode prometer algo que a primeira tela não confirma: confira se a oferta do criativo aparece logo no topo.`);
    }
    if (c.nForm >= 10 && total.fecha > 0 && c.fecha < total.fecha * 0.7) {
      dica("atencao", "formulario", `De quem abre o formulário, só ${comoPct(c.fecha)} terminam (média: ${comoPct(total.fecha)}). Veja nas gravações em que campo essas pessoas param.`, "gravacoes");
    }
    if (Number.isFinite(c.tempoMed) && c.tempoMed < 15 && (!(total.tempoMed < 15) || c.tempoMed < total.tempoMed * 0.6)) {
      dica("atencao", "rolagem", `Metade das visitas dura no máximo ${fmtDuracao(c.tempoMed)} (na página toda: ${fmtDuracao(total.tempoMed)}). Sinal de clique curioso ou de público fora do perfil: revise a segmentação e o criativo.`);
    }
    if (c.celular.size >= 20 && c.computador.size >= 20 && c.convComputador > 0 && c.convCelular < c.convComputador * 0.5) {
      dica("atencao", "celular", `No celular converte ${comoPct(c.convCelular)}; no computador, ${comoPct(c.convComputador)}. Teste a página no celular com essa campanha e confira o formulário.`, "gravacoes");
    }
    // queda nas últimas 24 horas
    const corte = relogio() - DIA;
    const recentesVis = new Set(c.pvs.filter((p) => p.ts >= corte).map((p) => p.visitante)).size;
    const antesVis = new Set(c.pvs.filter((p) => p.ts < corte).map((p) => p.visitante)).size;
    const recentesCad = c.cads.filter((x) => x.ts >= corte).length;
    const antesCad = c.cads.length - recentesCad;
    if (recentesVis >= 20 && antesVis >= 20 && antesCad >= 3) {
      const agora = recentesCad / recentesVis;
      const antes = antesCad / antesVis;
      if (agora < antes * 0.6 && zDuas(recentesCad, recentesVis, antesCad, antesVis) <= -1.28) {
        dica("ruim", "descendo", `A conversão caiu nas últimas 24 horas: ${comoPct(agora)}, contra ${comoPct(antes)} antes. Pode ser cansaço do criativo: renove os anúncios ou troque o destaque.`);
      }
    }
    // conjuntos: o melhor e o pior com diferença confiável
    const julgaveis = (c.listaConjuntos || []).filter((j) => j.nVis >= MIN_VISITANTES);
    if (julgaveis.length >= 2) {
      const ordem = [...julgaveis].sort((a, b) => b.conv - a.conv);
      const [melhor, pior] = [ordem[0], ordem[ordem.length - 1]];
      if (zDuas(melhor.cadastros, melhor.nVis, pior.cadastros, pior.nVis) >= 1.64) {
        dica("bom", "balanca", `O conjunto ${nomeCurto(melhor.nome)} converte ${comoPct(melhor.conv)}; o ${nomeCurto(pior.nome)}, ${comoPct(pior.conv)}. Vale mover verba para o primeiro.`);
      }
    }
    if (sinal === "ruim" || (sinal === "atencao" && !dicas.some((d) => d.tipo !== "bom"))) {
      dica(sinal, "alerta", `Converte ${comoPct(c.conv)}, contra ${comoPct(resto)} no resto da página, com diferença que não parece acaso. Reduza a verba ou troque os criativos antes de escalar.`);
    }
    if (!dicas.length) dica("media", "lampada", `Dentro da média: ${comoPct(c.conv)}, contra ${comoPct(Number.isFinite(resto) ? resto : total.conv)} no resto da página. Nada fora do comum no funil.`);
    return dicas;
  }

  // "bfn_26_f2_p2_int_concursos_lpfria" -> "int_concursos_lpfria": o prefixo
  // comum aos conjuntos da Black só ocupa espaço
  const nomeCurto = (nome = "") => nome.replace(/^bfn_\d+_f\d+_p\d+_/i, "");

  function etiquetaSinal(chave, menor = false) {
    const s = SINAIS[chave];
    return el("span", { class: `sinal sinal--${s.classe}${menor ? " sinal--menor" : ""}` }, s.nome);
  }

  function filtrarCampanha(nome, aba) {
    prefs.filtros.utm_campaign = [nome === SEM_CAMPANHA ? VAZIO : nome];
    aplicarFiltros();
    if (aba) trocarAba(aba);
  }

  function etapaFunil(rotulo, valor, base, nota, cor, i) {
    const largura = base ? Math.max(2, (valor / base) * 100) : 0;
    return el("div", { class: "camp-funil__etapa" },
      el("div", { class: "camp-funil__cabeca" },
        el("span", {}, rotulo),
        el("strong", {}, fmtNum(valor), nota ? el("small", {}, nota) : null)),
      el("div", { class: "trilho" },
        el("span", { class: "trilho__barra", style: { width: `${largura}%`, background: cor, "--atraso": `${i * 90}ms` } })));
  }

  function cartaoCampanha(c, total, grade, i, animar) {
    const sinal = sinalDe(c, total);
    const dicas = dicasDe(c, total, sinal);
    const rel = razao(c.conv, total.conv);
    const faixa = el("div", { class: "camp__faisca" });
    const cartao = el("article", { class: `campanha campanha--${SINAIS[sinal].classe}`, style: { "--i": String(i) } },
      el("header", { class: "campanha__topo" },
        el("div", { class: "campanha__nome" },
          c.nome === SEM_CAMPANHA ? el("span", { class: "canal", style: { "--canal": "#6f655b" } }, "Sem UTM") : etiquetaCanal(c.fonte),
          el("h3", { title: c.nome }, c.nome === SEM_CAMPANHA ? "Sem campanha (direto e orgânico)" : c.nome)),
        etiquetaSinal(sinal)),
      el("div", { class: "campanha__corpo" },
        el("div", { class: "camp-funil" },
          etapaFunil("Visitantes", c.nVis, c.nVis, null, CORES.funil[0], 0),
          etapaFunil("Abriram o formulário", c.nForm, c.nVis, comoPct(c.abre), CORES.funil[1], 1),
          etapaFunil("Cadastros", c.cadastros, c.nVis, comoPct(c.conv), CORES.cadastros, 2)),
        el("div", { class: "campanha__numeros" },
          el("div", { class: "camp-conversao" },
            el("span", { class: "camp-conversao__rotulo" }, "Conversão"),
            el("strong", {}, comoPct(c.conv)),
            Number.isFinite(rel) && sinal !== "pouco"
              ? el("span", { class: `camp-conversao__rel ${rel >= 1 ? "is-acima" : "is-abaixo"}` }, `${rel >= 1 ? "+" : "−"}${fmtPct(Math.abs(rel - 1), 0)} da média`)
              : el("span", { class: "camp-conversao__rel" }, `média: ${comoPct(total.conv)}`)),
          el("dl", { class: "camp-engaja" },
            el("div", {}, el("dt", {}, "Tempo mediano"), el("dd", {}, Number.isFinite(c.tempoMed) ? fmtDuracao(c.tempoMed) : "—")),
            el("div", {}, el("dt", {}, "Rolagem mediana"), el("dd", {}, Number.isFinite(c.rolagemMed) ? `${fmtNum(c.rolagemMed)}%` : "—")),
            el("div", {}, el("dt", {}, "No celular"), el("dd", {}, comoPct(razao(c.celular.size, c.nVis))))),
          el("div", { class: "camp__grafico" }, faixa, el("small", {}, grade.escala === DIA ? "visitantes por dia" : "visitantes por hora")))),
      el("ul", { class: "camp-dicas" }, dicas.map((d) => el("li", { class: `camp-dica camp-dica--${d.tipo}` },
        icone(d.icone, "icone camp-dica__icone"),
        el("p", {}, d.texto),
        d.acao === "gravacoes" ? el("button", { type: "button", class: "camp-dica__acao", dataset: { campanha: c.nome, aba: "pessoas" } }, icone("play"), "Ver gravações") : null))),
      c.listaConjuntos.length > 1 || (c.listaConjuntos[0] && c.listaConjuntos[0].nome !== "(sem conjunto)")
        ? el("details", { class: "camp-conjuntos", dataset: { campanha: c.nome }, open: conjuntosAbertos.has(c.nome) || null },
          el("summary", {}, icone("seta"), plural(c.listaConjuntos.length, "conjunto de anúncios", "conjuntos de anúncios")),
          el("div", { class: "tabela-rolagem" },
            el("table", { class: "tabela tabela--numeros tabela--compacta" },
              el("thead", {}, el("tr", {},
                el("th", { scope: "col" }, "Conjunto"),
                el("th", { scope: "col", class: "num" }, "Visitantes"),
                el("th", { scope: "col", class: "num" }, "Formulário"),
                el("th", { scope: "col", class: "num" }, "Cadastros"),
                el("th", { scope: "col", class: "num" }, "Conversão"),
                el("th", { scope: "col" }, "Sinal"))),
              el("tbody", {}, c.listaConjuntos.map((j) => el("tr", {},
                el("td", { class: "forte", title: j.nome }, nomeCurto(j.nome)),
                el("td", { class: "num" }, fmtNum(j.nVis)),
                el("td", { class: "num" }, comoPct(j.abre)),
                el("td", { class: "num" }, fmtNum(j.cadastros)),
                el("td", { class: "num" }, comoPct(j.conv)),
                el("td", {}, etiquetaSinal(sinalDe(j, total), true))))))))
        : null,
      el("footer", { class: "campanha__rodape" },
        el("button", { type: "button", class: "botao-texto", dataset: { campanha: c.nome } }, icone("filtro"), "Filtrar o painel por esta campanha")));
    cartao._sinal = sinal;
    cartao._faixa = () => faisca(faixa, { valores: distintosPorBalde(grade, c.pvs, "visitante"), corSerie: CORES.visitantes, animar });
    return cartao;
  }

  // comparação com a Esquenta: busca no Worker, guardada por 2 minutos
  const duelo = { chave: "", dados: null, buscando: false, quando: 0, erro: false };
  async function buscarDuelo(inicio, fim, nomes) {
    const chave = [Math.floor(inicio / 60000), Math.floor(fim / 300000), ...nomes].join("|");
    if (duelo.buscando || (duelo.chave === chave && relogio() - duelo.quando < 120000)) return;
    duelo.buscando = true;
    try {
      let corpo;
      if (DEMO) {
        corpo = { gasto: null, esquenta: nomes.flatMap((n) => [
          { campanha: n, conjunto: `${n}_agrupado`.replace(/^black_november_2026_/, "bfn_26_"), visitantes: 180 + (n.length * 7) % 90, formulario: 60, cadastros: 14 + (n.length % 9) },
        ]) };
      } else {
        const q = new URLSearchParams({ ini: String(Math.round(inicio)), fim: String(Math.round(fim)) });
        nomes.forEach((n) => q.append("c", n));
        const r = await fetch(`/admin/api/campanhas?${q}`, { credentials: "same-origin" });
        if (r.status === 401) { location.href = "/admin/entrar"; return; }
        if (!r.ok) throw new Error(String(r.status));
        corpo = await r.json();
      }
      Object.assign(duelo, { chave, dados: corpo, quando: relogio(), erro: false });
    } catch {
      duelo.erro = true;
    } finally {
      duelo.buscando = false;
    }
    if (prefs.aba === "campanhas") renderDuelo();
  }

  // público do conjunto daqui ("..._lpfria") e os conjuntos da Esquenta com o
  // mesmo começo de nome (mesmo público, outra página)
  function paresDoDuelo(lista) {
    const pares = [];
    for (const c of lista) {
      if (c.nome === SEM_CAMPANHA) continue;
      for (const j of c.listaConjuntos) {
        const publico = j.nome.replace(/_lpfria$/i, "");
        if (publico === j.nome) continue;
        const la = (duelo.dados?.esquenta || []).filter((l) => l.campanha === c.nome && l.conjunto && l.conjunto.startsWith(`${publico}_`));
        if (!la.length) continue;
        const soma = (k) => la.reduce((s, l) => s + (Number(l[k]) || 0), 0);
        pares.push({ campanha: c.nome, publico, aqui: { vis: j.nVis, form: j.nForm, cad: j.cadastros }, la: { vis: soma("visitantes"), form: soma("formulario"), cad: soma("cadastros"), conjuntos: la.length } });
      }
    }
    return pares;
  }

  let ultimaListaCampanhas = [];
  // a lista é refeita a cada dado novo: os conjuntos abertos continuam abertos
  const conjuntosAbertos = new Set();
  function renderDuelo() {
    const alvo = $("#duelo");
    if (duelo.erro && !duelo.dados) { alvo.replaceChildren(el("p", { class: "vazio" }, "Não foi possível buscar os números da Esquenta agora. O painel tenta de novo na próxima atualização.")); return; }
    if (!duelo.dados) { alvo.replaceChildren(el("p", { class: "vazio" }, "Buscando os números da Esquenta…")); return; }
    const pares = paresDoDuelo(ultimaListaCampanhas);
    if (!pares.length) { alvo.replaceChildren(el("p", { class: "vazio" }, "Nenhum público aparece nas duas páginas neste período (conjuntos terminados em _lpfria aqui e com o mesmo começo de nome lá).")); return; }
    alvo.replaceChildren(...pares.map((p) => {
      const cAqui = razao(p.aqui.cad, p.aqui.vis);
      const cLa = razao(p.la.cad, p.la.vis);
      const z = zDuas(p.aqui.cad, p.aqui.vis, p.la.cad, p.la.vis);
      let veredito;
      let classe = "media";
      if (p.aqui.vis < MIN_DUELO || p.la.vis < MIN_DUELO) {
        veredito = `Pouco volume para decidir: são precisos ao menos ${MIN_DUELO} visitantes em cada página.`;
        classe = "pouco";
      } else if (Math.abs(z) >= 1.96) {
        veredito = z > 0 ? "Esta página converte mais, com 95% de confiança." : "A Esquenta converte mais, com 95% de confiança.";
        classe = z > 0 ? "bom" : "ruim";
      } else {
        const n = amostraNecessaria(cAqui, cLa);
        veredito = !Number.isFinite(n)
          ? "As duas convertem igual até aqui."
          : `Ainda sem diferença confiável. Para separar ${comoPct(cAqui)} de ${comoPct(cLa)}, faltam cerca de ${fmtNum(Math.max(0, n - Math.min(p.aqui.vis, p.la.vis)))} visitantes por página.`;
      }
      const lado = (titulo, d, conv, vence) => el("div", { class: `duelo__lado${vence ? " is-vence" : ""}` },
        el("span", { class: "duelo__pagina" }, titulo),
        el("strong", { class: "duelo__conv" }, comoPct(conv)),
        el("span", { class: "duelo__detalhe" }, `${plural(d.cad, "cadastro", "cadastros")} de ${plural(d.vis, "visitante", "visitantes")}`),
        el("span", { class: "duelo__detalhe" }, `formulário aberto por ${comoPct(razao(d.form, d.vis))}`));
      return el("article", { class: `duelo duelo--${classe}` },
        el("header", { class: "duelo__topo" },
          el("h3", { title: p.publico }, nomeCurto(p.publico)),
          el("span", { class: "duelo__campanha", title: p.campanha }, p.campanha)),
        el("div", { class: "duelo__lados" },
          lado("Esta página", p.aqui, cAqui, classe === "bom"),
          el("span", { class: "duelo__x", "aria-hidden": "true" }, "×"),
          lado(p.la.conjuntos > 1 ? `Esquenta (${p.la.conjuntos} conjuntos)` : "Esquenta", p.la, cLa, classe === "ruim")),
        el("p", { class: `duelo__veredito duelo__veredito--${classe}` }, icone(classe === "pouco" ? "relogio" : "balanca"), veredito));
    }));
  }

  function renderCampanhas(f, { animar, aoVivo }) {
    const { total, lista } = montarCampanhas(f);
    ultimaListaCampanhas = lista;
    const comVisitas = lista.filter((c) => c.nVis > 0 && c.nome !== SEM_CAMPANHA);
    contar("#k-camp-total", comVisitas.length, fmtNum, aoVivo);
    texto("#k-camp-total-nota", plural(comVisitas.reduce((s, c) => s + c.listaConjuntos.length, 0), "conjunto de anúncios", "conjuntos de anúncios"));
    contar("#k-camp-media", total.conv, (v) => comoPct(v), aoVivo);
    texto("#k-camp-media-nota", `${plural(total.cadastros, "cadastro", "cadastros")} de ${plural(total.nVis, "visitante", "visitantes")}`);

    const grade = gradeTempo(f.inicio, f.fim, escalaDe(f.inicio, f.fim));
    const cartoes = lista.map((c, i) => cartaoCampanha(c, total, grade, i, animar));
    const julgadas = lista.filter((c) => c.nVis >= MIN_VISITANTES && c.nome !== SEM_CAMPANHA);
    const melhor = [...julgadas].sort((a, b) => b.conv - a.conv)[0];
    texto("#k-camp-melhor", melhor ? comoPct(melhor.conv) : "—");
    const notaMelhor = $("#k-camp-melhor-nota");
    notaMelhor.textContent = melhor ? melhor.nome : `nenhuma com ${MIN_VISITANTES} visitantes ainda`;
    notaMelhor.title = melhor ? melhor.nome : "";
    const alertas = cartoes.filter((c) => c._sinal === "ruim" || c._sinal === "atencao").length;
    contar("#k-camp-alerta", alertas, fmtNum, aoVivo);
    $("#k-camp-alerta").closest(".kpi").classList.toggle("kpi--alerta", alertas > 0);

    const alvo = $("#campanhas-lista");
    alvo.classList.toggle("anima", Boolean(animar && !movimentoReduzido));
    alvo.replaceChildren(...(cartoes.length ? cartoes : [el("p", { class: "vazio" }, "Sem visitas no período.")]));
    cartoes.forEach((c) => c._faixa());

    renderDuelo();
    const nomes = comVisitas.map((c) => c.nome).filter((n) => !/\{\{/.test(n)).slice(0, 40);
    if (nomes.length) buscarDuelo(f.inicio, f.fim, nomes);
  }

  /* ---------------------------------------------------------
     Aba 4: eventos do GTM (dataLayer)
     --------------------------------------------------------- */
  function renderEventos(f, { animar, aoVivo }) {
    const engajamento = new Map();
    for (const e of f.eventos) {
      if (e.evento !== "engajamento") continue;
      const s = engajamento.get(e.sessao) || { segundos: 0, rolagem: 0 };
      s.segundos = Math.max(s.segundos, e.valor || 0);
      s.rolagem = Math.max(s.rolagem, parseInt(e.detalhe, 10) || 0);
      engajamento.set(e.sessao, s);
    }
    const tempos = [...engajamento.values()].map((s) => s.segundos).sort((a, b) => a - b);
    const mediana = tempos.length ? tempos[Math.floor(tempos.length / 2)] : NaN;
    const rolagens = [...engajamento.values()].map((s) => s.rolagem);
    contar("#k-tempo", mediana, fmtDuracao, aoVivo);
    contar("#k-rolagem", rolagens.length ? rolagens.reduce((s, v) => s + v, 0) / rolagens.length / 100 : NaN, (v) => fmtPct(v, 0), aoVivo);

    const aberturas = f.eventos.filter((e) => e.evento === "lead_form_aberto");
    const quemAbriu = distintos(aberturas, "visitante");
    const visitantes = distintos(f.pvs, "visitante").size;
    const quemCadastrou = distintos(f.cadastros, "visitante");
    const abriuECadastrou = [...quemAbriu].filter((v) => quemCadastrou.has(v)).length;
    contar("#k-aberturas", aberturas.length, fmtNum, aoVivo);
    texto("#k-aberturas-nota", `${plural(quemAbriu.size, "visitante", "visitantes")} · ${fmtPct(visitantes ? quemAbriu.size / visitantes : NaN)} dos visitantes`);
    contar("#k-form-conv", quemAbriu.size ? abriuECadastrou / quemAbriu.size : NaN, (v) => fmtPct(v), aoVivo);

    // tabela de eventos
    const grupos = new Map();
    for (const e of f.eventos) {
      let g = grupos.get(e.evento);
      if (!g) grupos.set(e.evento, (g = { evento: e.evento, total: 0, sessoesSet: new Set() }));
      g.total++;
      if (e.sessao) g.sessoesSet.add(e.sessao);
    }
    for (const g of grupos.values()) g.sessoes = g.sessoesSet.size;
    const ordenados = ordenar([...grupos.values()], prefs.ordem.eventos, {});
    marcarOrdem($("#tabela-eventos"), prefs.ordem.eventos);
    if (!grupos.has(prefs.evento)) prefs.evento = grupos.has("lead_form_aberto") ? "lead_form_aberto" : ordenados[0]?.evento || "";

    $("#tabela-eventos tbody").replaceChildren(...(ordenados.length ? ordenados.map((g) => el("tr", {
      tabindex: 0, dataset: { evento: g.evento }, class: g.evento === prefs.evento ? "is-selecionado" : null,
      "aria-selected": String(g.evento === prefs.evento),
    },
    el("td", { class: "forte" }, g.evento, EVENTOS[g.evento] ? el("span", { class: "descricao" }, EVENTOS[g.evento]) : null),
    el("td", { class: "num" }, fmtNum(g.total)),
    el("td", { class: "num" }, fmtNum(g.sessoes)))) : [el("tr", {}, el("td", { class: "vazio", colspan: 3 }, "Nenhum evento no período."))]));

    const escala = escalaDe(f.inicio, f.fim);
    const grade = gradeTempo(f.inicio, f.fim, escala);
    texto("#g-evento-titulo", prefs.evento || "Evento");
    texto("#g-evento-sub", `${EVENTOS[prefs.evento] ? `${EVENTOS[prefs.evento]} · ` : ""}ocorrências ${escala === HORA ? "por hora" : "por dia"}`);
    grafico($("#g-evento"), {
      pontos: grade.pontos,
      series: [{ nome: "ocorrências", cor: CORES.evento, valores: contarPorBalde(grade, f.eventos.filter((e) => e.evento === prefs.evento)) }],
      tipo: "colunas",
      animar,
    });

    // botões (cta) que abriram o formulário
    listaBarras($("#botoes"), contarBotoes(f).sort((a, b) => b.aberturas - a.aberturas).map((b) => ({
      nome: CTAS[b.cta] || b.cta || "(sem identificação)",
      valor: b.aberturas,
      rotulo: plural(b.aberturas, "abertura", "aberturas"),
      nota: `${plural(b.cadastros, "cadastro", "cadastros")} · ${fmtPct(b.aberturas ? b.cadastros / b.aberturas : NaN)}`,
      cor: CORES.evento,
    })), { animar });

    // profundidade de rolagem por sessão
    const faixas = [["Até 25%", 0], ["De 25% a 50%", 0], ["De 50% a 75%", 0], ["De 75% a 100%", 0]];
    for (const r of rolagens) faixas[Math.min(3, Math.floor(r / 25.0001))][1]++;
    listaBarras($("#rolagem"), faixas.map(([nome, valor]) => ({
      nome,
      valor,
      nota: fmtPct(rolagens.length ? valor / rolagens.length : NaN, 0),
      cor: CORES.acessos,
    })), { animar });

    // ao vivo: os mais recentes do período
    const recentes = [];
    for (let i = f.eventos.length - 1; i >= 0 && recentes.length < 60; i--) {
      if (prefs.pulsos || f.eventos[i].evento !== "engajamento") recentes.push(f.eventos[i]);
    }
    $("#mostrar-pulsos").checked = prefs.pulsos;
    $("#tabela-feed tbody").replaceChildren(...(recentes.length ? recentes.map((e) => {
      const s = sessaoDe(e) || {};
      const detalhe = e.evento === "page_view"
        ? (e.referencia ? `veio de ${e.referencia}` : "")
        : e.evento === "engajamento"
          ? `${fmtDuracao(e.valor)} · rolagem ${e.detalhe || 0}%`
          : e.evento === "carregamento"
            ? `primeira tela em ${fmtSegundos(e.valor)}`
            : detalheLegivel(e);
      return el("tr", { class: novosIds.has(`e${e.id}`) ? "is-novo" : null },
        el("td", { title: fmtDataHora.format(e.ts) }, fmtHora.format(e.ts)),
        el("td", { class: "forte", title: EVENTOS[e.evento] || "" }, e.evento),
        el("td", { title: detalhe }, detalhe || "—"),
        el("td", {}, origemMidia(s)),
        el("td", {}, capitalizar(s.dispositivo) || "—"),
        el("td", {}, local(s) || "—"));
    }) : [el("tr", {}, el("td", { class: "vazio", colspan: 6 }, "Nenhum evento no período."))]));
  }

  /* ---------------------------------------------------------
     Aba 5: mapa de cliques

     A LP aparece num iframe sem scripts (/?mapa=1, ver worker.js),
     com o tamanho de tela de cada aparelho. Como é a mesma origem, o painel lê
     a página do iframe, acha o elemento de cada clique pelo caminho gravado em
     main.js, desenha num canvas aqui no painel e põe o resultado como imagem
     dentro da própria página do iframe, que rola junto com ela. (Canvas dentro
     do iframe não serve: com os scripts desligados, o navegador mostra só o
     conteúdo alternativo do canvas, nunca o desenho.)
     --------------------------------------------------------- */
  const APARELHOS = {
    computador: { largura: 1440, altura: 900, visor: "#visor-computador" },
    celular: { largura: 390, altura: 844, visor: "#visor-celular" },
  };
  // a LP troca de layout em 960 px (telaCelular, em main.js)
  const aparelhoDoClique = (e) => ((e.valor || 0) >= 960 ? "computador" : "celular");
  const aparelhoDaSessao = (s) => (s?.dispositivo === "computador" ? "computador" : "celular");
  const FATOR_TELA = 0.5; // o calor é borrado: meia resolução basta e poupa memória

  function lerClique(e) {
    if (e.cliqueLido === undefined) {
      try { e.cliqueLido = JSON.parse(e.detalhe); } catch { e.cliqueLido = null; }
    }
    return e.cliqueLido;
  }

  // calor: transparente -> vermelho -> laranja -> amarelo-claro -> branco
  const PALETA_CALOR = (() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 1;
    const ctx = c.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, "rgba(227, 38, 27, 0)");
    g.addColorStop(0.15, "rgba(227, 38, 27, 0.45)");
    g.addColorStop(0.45, "rgba(242, 106, 12, 0.72)");
    g.addColorStop(0.7, "rgba(255, 153, 51, 0.86)");
    g.addColorStop(0.9, "rgba(255, 208, 138, 0.93)");
    g.addColorStop(1, "rgba(255, 255, 255, 0.96)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 1);
    return ctx.getImageData(0, 0, 256, 1).data;
  })();
  const GRADIENTE_CALOR = "linear-gradient(90deg, rgba(227,38,27,0.25), #e3261b 20%, #f26a0c 50%, #ff9933 72%, #ffd08a 90%, #fff)";

  const quadros = {};

  function montarQuadro(chave) {
    if (quadros[chave]) return quadros[chave];
    const cfg = APARELHOS[chave];
    const visor = $(cfg.visor);
    // sem allow-scripts: a página não roda nada; allow-same-origin deixa o painel lê-la
    const iframe = el("iframe", {
      src: DEMO ? "../index.html?mapa=1" : "../?mapa=1",
      sandbox: "allow-same-origin",
      title: `LP vista no ${chave}`,
      width: cfg.largura,
      height: cfg.altura,
    });
    const aviso = el("p", { class: "mapa__aviso" }, "Carregando a página…");
    visor.replaceChildren(iframe, aviso);
    const q = { cfg, visor, iframe, aviso, escala: 1 };
    q.pronto = new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }))
      .then(() => acompanharQuadro(q));
    quadros[chave] = q;
    escalarQuadro(q);
    return q;
  }

  // A página fica no tamanho real do aparelho (o layout depende da altura da
  // tela) e só a imagem é reduzida. Lado a lado, os dois aparelhos cabem
  // inteiros na tela: a altura é a que sobra abaixo do topo do mapa (com a
  // página no início, ou na tela cheia) e o computador fica com a largura que
  // o celular deixa. Em coluna (telas estreitas), cada um cabe sozinho.
  const MOLDURA_MAPA = 22; // bordas laterais da moldura do aparelho
  function escalarQuadro(q) {
    const { largura, altura } = q.cfg;
    const mapa = q.visor.closest(".mapa");
    const cartao = $("#cartao-mapa");
    const cheia = telaCheiaAtiva(cartao);
    const emColuna = !cheia && window.matchMedia("(max-width: 999px)").matches;
    const topo = mapa.getBoundingClientRect().top + (cheia ? cartao.scrollTop : window.scrollY);
    // legenda acima (30), moldura em cima e embaixo (30), rodapé com números e escala e o fim do cartão (96)
    const alturaLivre = Math.max(280, (emColuna ? window.innerHeight - 140 : window.innerHeight - topo - 156));
    const escalaCelular = Math.min(1, alturaLivre / APARELHOS.celular.altura, (mapa.clientWidth - MOLDURA_MAPA) / APARELHOS.celular.largura);
    const larguraLivre = q.cfg === APARELHOS.celular || emColuna
      ? mapa.clientWidth - MOLDURA_MAPA
      : mapa.clientWidth - (APARELHOS.celular.largura * escalaCelular + MOLDURA_MAPA) - 24 - MOLDURA_MAPA;
    q.escala = q.cfg === APARELHOS.celular
      ? Math.max(0.2, escalaCelular)
      : Math.max(0.15, Math.min(1, alturaLivre / altura, larguraLivre / largura));
    q.visor.style.width = `${Math.floor(largura * q.escala)}px`;
    q.visor.style.height = `${Math.floor(altura * q.escala)}px`;
    q.iframe.style.transform = `scale(${q.escala})`;
  }
  window.addEventListener("resize", () => Object.values(quadros).forEach((q) => { escalarQuadro(q); q.desenho?.(); }));

  let versaoMapa = 0;

  function renderMapa(f, { aoVivo }) {
    const modo = ["calor", "pontos", "rolagem"].includes(prefs.mapa) ? prefs.mapa : "calor";
    $$("#mapa-modos button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mapa === modo)));

    const cliques = { computador: [], celular: [] };
    for (const e of f.eventos) {
      if (e.evento !== "clique") continue;
      const c = lerClique(e);
      if (c) cliques[aparelhoDoClique(e)].push(c);
    }
    const total = cliques.computador.length + cliques.celular.length;
    const fixos = [...cliques.computador, ...cliques.celular].filter((c) => c.f).length;
    contar("#m-total", total, fmtNum, aoVivo);
    contar("#m-computador", cliques.computador.length, fmtNum, aoVivo);
    contar("#m-celular", cliques.celular.length, fmtNum, aoVivo);
    contar("#m-fixos", fixos, fmtNum, aoVivo);
    texto("#m-computador-nota", `${fmtPct(total ? cliques.computador.length / total : NaN)} dos cliques`);
    texto("#m-celular-nota", `${fmtPct(total ? cliques.celular.length / total : NaN)} dos toques`);
    texto("#mapa-computador-legenda", `${plural(cliques.computador.length, "clique", "cliques")} · tela de 1440 px`);
    texto("#mapa-celular-legenda", `${plural(cliques.celular.length, "toque", "toques")} · tela de 390 px`);

    // até onde cada sessão rolou, por aparelho
    const rolagens = { computador: new Map(), celular: new Map() };
    for (const e of f.eventos) {
      if (e.evento !== "engajamento") continue;
      const lista = rolagens[aparelhoDaSessao(sessaoDe(e))];
      lista.set(e.sessao, Math.max(lista.get(e.sessao) || 0, parseInt(e.detalhe, 10) || 0));
    }

    tabelaCliques("#tabela-cliques-computador", cliques.computador);
    tabelaCliques("#tabela-cliques-celular", cliques.celular);
    renderSinais(f);

    $("#mapa-escala").replaceChildren(...(modo === "calor"
      ? ["menos cliques", el("span", { class: "mapa__gradiente", style: { background: GRADIENTE_CALOR } }), "mais cliques"]
      : modo === "rolagem"
        ? ["Quanto mais escuro, menos pessoas chegam até aquela parte da página. As linhas marcam até onde 75%, 50% e 25% delas rolaram."]
        : ["Cada ponto é um clique ou toque."]));

    const versao = ++versaoMapa;
    for (const chave of ["computador", "celular"]) {
      const q = montarQuadro(chave);
      escalarQuadro(q);
      q.desenho = () => desenharQuadro(q, cliques[chave], [...rolagens[chave].values()], modo);
      q.pronto.then(() => { if (versao === versaoMapa) q.desenho(); });
    }
  }

  // A posição de cada elemento só fica certa quando a página do quadro termina
  // de montar: a fonte Sora chega depois do "load" e as imagens vão chegando
  // conforme a rolagem, e as duas coisas empurram textos e botões. O desenho
  // espera as fontes e é refeito sempre que a página muda de tamanho.
  function acompanharQuadro(q) {
    const doc = q.iframe.contentDocument;
    if (!doc) return;
    let espera = 0;
    const refazer = () => {
      clearTimeout(espera);
      espera = setTimeout(() => { if (prefs.aba === "mapa") q.desenho?.(); }, 250);
    };
    doc.fonts?.ready.then(refazer);
    new ResizeObserver(refazer).observe(doc.body);
  }

  // A LP encaixa a rolagem nas seções (scroll-snap) e rola suave; o mapa e a
  // reprodução precisam da página solta, no pixel exato. O Worker já tira isso
  // da página do mapa (?mapa=1); aqui é a segunda garantia.
  function soltarRolagem(doc) {
    doc.documentElement.style.setProperty("scroll-snap-type", "none", "important");
    doc.documentElement.style.setProperty("scroll-behavior", "auto", "important");
  }

  function desenharQuadro(q, lista, rolagens, modo) {
    let doc = null;
    try { doc = q.iframe.contentDocument; } catch { /* outra origem */ }
    if (!doc?.body) {
      q.aviso.textContent = DEMO
        ? "Aberto do disco, o navegador não deixa o painel ler a página. O mapa aparece no painel publicado."
        : "Não foi possível ler a página da LP.";
      q.aviso.hidden = false;
      return;
    }
    soltarRolagem(doc);
    q.aviso.hidden = true;
    const janela = q.iframe.contentWindow;
    const W = doc.documentElement.scrollWidth;
    const H = doc.documentElement.scrollHeight;

    let camada = doc.getElementById("painel-mapa-camada");
    if (!camada) {
      camada = doc.createElement("img");
      camada.id = "painel-mapa-camada";
      camada.alt = "";
      Object.assign(camada.style, { position: "absolute", left: "0", top: "0", pointerEvents: "none", zIndex: "2147483647", maxWidth: "none" });
      doc.body.append(camada);
    }
    camada.style.width = `${W}px`;
    camada.style.height = `${H}px`;

    const tela = document.createElement("canvas");
    tela.width = Math.ceil(W * FATOR_TELA);
    tela.height = Math.ceil(H * FATOR_TELA);
    const ctx = tela.getContext("2d", { willReadFrequently: true });
    ctx.setTransform(FATOR_TELA, 0, 0, FATOR_TELA, 0, 0);
    // a imagem vai para a página do iframe quando o desenho termina
    const publicar = () => tela.toBlob((arquivo) => {
      if (!arquivo) return;
      if (q.urlCamada) URL.revokeObjectURL(q.urlCamada);
      q.urlCamada = URL.createObjectURL(arquivo);
      camada.src = q.urlCamada;
    });

    if (modo === "rolagem") {
      desenharRolagem(ctx, rolagens, W, H, q.cfg.altura, q.escala);
      publicar();
      return;
    }

    // posição de cada clique na página do iframe
    const posicoes = new Map();
    const pontos = [];
    for (const c of lista) {
      if (c.f) continue;
      if (!posicoes.has(c.c)) {
        let caixa = null;
        try {
          const r = doc.querySelector(c.c)?.getBoundingClientRect();
          if (r && r.width && r.height) caixa = { x: r.left + janela.scrollX, y: r.top + janela.scrollY, w: r.width, h: r.height };
        } catch { /* caminho inválido */ }
        posicoes.set(c.c, caixa);
      }
      const caixa = posicoes.get(c.c);
      // elemento que não existe na página estática: posição relativa ao centro
      pontos.push(caixa ? [caixa.x + c.x * caixa.w, caixa.y + c.y * caixa.h] : [W / 2 + c.px, c.py]);
    }

    if (modo === "pontos") {
      const raio = Math.max(4, 4 / q.escala);
      ctx.fillStyle = "rgba(255, 153, 51, 0.72)";
      ctx.strokeStyle = "rgba(5, 4, 3, 0.85)";
      ctx.lineWidth = Math.max(1, 1 / q.escala);
      for (const [x, y] of pontos) {
        ctx.beginPath();
        ctx.arc(x, y, raio, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      publicar();
      return;
    }

    // calor: soma de manchas em alfa, depois cada nível de alfa vira uma cor
    const raio = Math.max(26, 18 / q.escala);
    for (const [x, y] of pontos) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, raio);
      g.addColorStop(0, "rgba(0, 0, 0, 0.16)");
      g.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - raio, y - raio, raio * 2, raio * 2);
    }
    const imagem = ctx.getImageData(0, 0, tela.width, tela.height);
    const d = imagem.data;
    let maximo = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > maximo) maximo = d[i];
    if (!maximo) { publicar(); return; }
    const ajuste = 255 / maximo;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (!a) continue;
      const j = Math.min(255, Math.round(a * ajuste)) * 4;
      d[i] = PALETA_CALOR[j];
      d[i + 1] = PALETA_CALOR[j + 1];
      d[i + 2] = PALETA_CALOR[j + 2];
      d[i + 3] = PALETA_CALOR[j + 3];
    }
    ctx.putImageData(imagem, 0, 0);
    publicar();
  }

  // rolagem: a página escurece conforme menos sessões chegam a cada altura
  function desenharRolagem(ctx, rolagens, W, H, alturaTela, escala) {
    if (!rolagens.length) return;
    // % de rolagem (0 a 100) -> altura em px do fim da tela da pessoa
    const alcances = rolagens.map((pct) => alturaTela + (pct / 100) * Math.max(0, H - alturaTela)).sort((a, b) => b - a);
    const n = alcances.length;
    const passo = 12;
    let k = n - 1;
    for (let y = 0; y < H; y += passo) {
      while (k >= 0 && alcances[k] < y) k--;
      const fracao = (k + 1) / n;
      if (fracao >= 1) continue;
      ctx.fillStyle = `rgba(5, 4, 3, ${(0.82 * (1 - fracao)).toFixed(3)})`;
      ctx.fillRect(0, y, W, passo);
    }
    const fonte = Math.round(13 / escala);
    ctx.font = `600 ${fonte}px Sora, system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    for (const p of [0.75, 0.5, 0.25]) {
      const y = alcances[Math.max(0, Math.ceil(p * n) - 1)];
      ctx.fillStyle = "#ff9933";
      ctx.fillRect(0, y - 1 / escala, W, 2 / escala);
      const rotulo = `${Math.round(p * 100)}% chegam até aqui`;
      const largura = ctx.measureText(rotulo).width + fonte;
      ctx.fillRect(fonte, y - fonte, largura, fonte * 2);
      ctx.fillStyle = "#1a0a00";
      ctx.fillText(rotulo, fonte * 1.5, y);
    }
  }

  function tabelaCliques(seletor, lista) {
    const grupos = new Map();
    for (const c of lista) {
      let g = grupos.get(c.c);
      if (!g) grupos.set(c.c, (g = { rotulo: c.l, caminho: c.c, n: 0, fixo: c.f }));
      g.n++;
      if (!g.rotulo && c.l) g.rotulo = c.l;
    }
    const linhas = [...grupos.values()].sort((a, b) => b.n - a.n).slice(0, 15);
    const total = lista.length;
    $(`${seletor} tbody`).replaceChildren(...(linhas.length ? linhas.map((g) => el("tr", {},
      el("td", { class: "forte", title: g.caminho }, g.rotulo || "(sem texto)",
        el("span", { class: "caminho" }, `${g.fixo ? "formulário ou barra fixa · " : ""}${g.caminho.split(">").slice(-2).join(" › ")}`)),
      el("td", { class: "num" }, fmtNum(g.n)),
      el("td", { class: "num" }, fmtPct(total ? g.n / total : NaN)))) : [el("tr", {}, el("td", { class: "vazio", colspan: 3 }, "Nenhum clique no período."))]));
  }

  /* ---------------------------------------------------------
     Sinais de frustração (estilo Clarity/Hotjar)
     --------------------------------------------------------- */
  const TAG_CLICAVEL = /^(a|button|input|select|textarea|label|summary)(:|$)/;

  // clique em algo que não é clicável; o fundo da página e os elementos
  // fixos (formulário, barra) não contam
  function cliqueSemEfeito(c) {
    if (!c || c.f || c.c === "body") return false;
    if (c.k !== undefined) return !c.k;
    const fim = c.c.split(">").pop();
    if (fim.startsWith("#")) return false; // cliques antigos, sem o campo k: sem como saber
    return !TAG_CLICAVEL.test(fim);
  }

  // 3 ou mais cliques em menos de 1,5 s, a menos de 40 px um do outro;
  // "lista": cliques de uma visita, em ordem de tempo
  function cliquesDeRaiva(lista) {
    const achados = [];
    const perto = (p, q) => Math.hypot(p.px - q.px, p.py - q.py) < 40;
    for (let i = 0; i + 2 < lista.length; i++) {
      if (lista[i + 2].ts - lista[i].ts > 1500) continue;
      const [a, b, c] = [lista[i], lista[i + 1], lista[i + 2]].map(lerClique);
      if (a && b && c && perto(a, b) && perto(a, c)) {
        achados.push(lista[i]);
        i += 2;
      }
    }
    return achados;
  }

  function tabelaSinais(seletor, grupos, vazio) {
    const linhas = [...grupos.values()].sort((a, b) => b.n - a.n).slice(0, 12);
    $(`${seletor} tbody`).replaceChildren(...(linhas.length ? linhas.map((g) => el("tr", {},
      el("td", { class: "forte", title: g.caminho }, g.rotulo || "(sem texto)",
        el("span", { class: "caminho" }, `${g.aparelhos.size > 1 ? "computador e celular" : [...g.aparelhos][0]} · ${g.caminho.split(">").slice(-2).join(" › ")}`)),
      el("td", { class: "num" }, fmtNum(g.n)),
      el("td", { class: "num" }, fmtNum(g.sessoes.size)))) : [el("tr", {}, el("td", { class: "vazio", colspan: 3 }, vazio))]));
  }

  function renderSinais(f) {
    const semEfeito = new Map();
    const raiva = new Map();
    const somar = (mapa, e, c) => {
      let g = mapa.get(c.c);
      if (!g) mapa.set(c.c, (g = { caminho: c.c, rotulo: c.l, n: 0, sessoes: new Set(), aparelhos: new Set() }));
      g.n++;
      g.sessoes.add(e.sessao);
      g.aparelhos.add(aparelhoDoClique(e));
      if (!g.rotulo && c.l) g.rotulo = c.l;
    };
    const porSessao = new Map();
    for (const e of f.eventos) {
      if (e.evento !== "clique") continue;
      const c = lerClique(e);
      if (cliqueSemEfeito(c)) somar(semEfeito, e, c);
      if (!porSessao.has(e.sessao)) porSessao.set(e.sessao, []);
      porSessao.get(e.sessao).push(e);
    }
    for (const lista of porSessao.values()) {
      lista.sort((a, b) => a.ts - b.ts);
      for (const e of cliquesDeRaiva(lista)) somar(raiva, e, lerClique(e));
    }
    tabelaSinais("#tabela-sem-efeito", semEfeito, "Nenhum clique sem efeito no período.");
    tabelaSinais("#tabela-raiva", raiva, "Nenhum clique de raiva no período.");
  }

  /* ---------------------------------------------------------
     Aba Gravações (estilo Microsoft Clarity): pessoas à esquerda, ficha
     individual à direita. A ficha traz quem é, de onde veio, a nota de
     engajamento, a reprodução da visita e a linha do tempo, que acompanha a
     reprodução.
     --------------------------------------------------------- */
  const estudio = { selecionada: null, visiveis: 60, lista: [], nomes: new Map(), ordem: new Map() };
  const LOTE_LISTA = 60;
  const fmtTempo = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${doisDigitos(s % 60)}`;
  };

  // ícones fixos, escritos aqui (nada vindo do banco entra por innerHTML)
  const ICONES = {
    computador: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    celular: '<svg viewBox="0 0 24 24"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>',
    tablet: '<svg viewBox="0 0 24 24"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 18h2"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    estrela: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
    raio: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    formulario: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    clique: '<svg viewBox="0 0 24 24"><path d="M9 9V4.5a1.5 1.5 0 0 1 3 0V11l3.5.6a2 2 0 0 1 1.6 2.3l-.8 4.6A3 3 0 0 1 13.3 21H11a3 3 0 0 1-2.4-1.2L5.5 15.6a1.5 1.5 0 0 1 2.2-2L9 15"/></svg>',
    entrada: '<svg viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5M15 12H3"/></svg>',
    rolagem: '<svg viewBox="0 0 24 24"><path d="M12 3v18M6 15l6 6 6-6"/></svg>',
    seta: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
    recarregar: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    pausa: '<svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
    relogio: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    teclado: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>',
    alerta: '<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/></svg>',
    telaCheia: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    sairTela: '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
    // aba Campanhas
    filtro: '<svg viewBox="0 0 24 24"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>',
    lampada: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>',
    subindo: '<svg viewBox="0 0 24 24"><path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
    descendo: '<svg viewBox="0 0 24 24"><path d="m3 7 6 6 4-4 8 8"/><path d="M15 17h6v-6"/></svg>',
    balanca: '<svg viewBox="0 0 24 24"><path d="M12 3v18M7 21h10M5 7h14"/><path d="m5 7-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z"/></svg>',
  };
  // canal de chegada da visita, numa etiqueta com a cor da plataforma
  const CANAIS = [
    [/facebook|instagram|^fb$|^ig$|meta/i, "Meta", "#5b8def"],
    [/google|youtube|gads/i, "Google", "#3fbf6f"],
    [/e-?mail|sfmc|newsletter/i, "E-mail", "#f0c060"],
    [/whats/i, "WhatsApp", "#2fd36f"],
    [/tiktok/i, "TikTok", "#ff4f8b"],
    [/linkedin/i, "LinkedIn", "#3a9bd8"],
  ];
  function canalDe(pv) {
    const fonte = [pv.utm_source, pv.clique].filter(Boolean).join(" ");
    for (const [teste, nome, cor] of CANAIS) if (teste.test(fonte)) return { nome, cor };
    if (pv.utm_source) return { nome: capitalizar(pv.utm_source), cor: "#a99a8a" };
    if (pv.referencia) return { nome: pv.referencia.replace(/^(www|l|m|lm)\./, "").split(".")[0], cor: "#a99a8a" };
    return { nome: "Direto", cor: "#6f655b" };
  }
  function etiquetaCanal(pv) {
    const c = canalDe(pv);
    return el("span", { class: "canal", style: { "--canal": c.cor }, title: origemMidia(pv) }, c.nome);
  }

  function icone(nome, classe = "icone") {
    const n = document.createElement("span");
    n.className = classe;
    n.setAttribute("aria-hidden", "true");
    n.innerHTML = ICONES[nome] || "";
    return n;
  }

  // cada navegador ganha um código curto e uma cor fixa
  const MATIZES = [24, 32, 200, 160, 330, 270, 45, 12];
  function identidade(visitante = "") {
    let h = 2166136261;
    for (const ch of visitante) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return { codigo: h.toString(36).toUpperCase().slice(-4).padStart(4, "0"), matiz: MATIZES[h % MATIZES.length] };
  }

  function cadastrosPorVisitante() {
    const mapa = new Map();
    for (const c of dados.cadastros) if (c.visitante && !mapa.has(c.visitante)) mapa.set(c.visitante, c);
    return mapa;
  }

  // ordem de cada visita entre as visitas do mesmo navegador
  function ordemDasVisitas() {
    const porVisitante = new Map();
    for (const s of dados.sessoes.values()) {
      if (!s.visitante) continue;
      if (!porVisitante.has(s.visitante)) porVisitante.set(s.visitante, []);
      porVisitante.get(s.visitante).push(s);
    }
    const ordem = new Map();
    for (const lista of porVisitante.values()) {
      lista.sort((a, b) => a.ts - b.ts);
      lista.forEach((s, i) => ordem.set(s.sessao, { n: i + 1, total: lista.length }));
    }
    return { ordem, porVisitante };
  }

  function montarVisitas(f) {
    const visitas = new Map();
    for (const p of f.pvs) {
      if (p.sessao && !visitas.has(p.sessao)) {
        visitas.set(p.sessao, { sessao: p.sessao, pv: dados.sessoes.get(p.sessao) || p, segundos: 0, rolagem: 0, cliques: [], marcos: [], abriu: false, gravada: false, cadastro: null, ultimo: p.ts });
      }
    }
    for (const e of dados.eventos) {
      const v = e.sessao && visitas.get(e.sessao);
      if (!v) continue;
      if (e.ts > v.ultimo) v.ultimo = e.ts;
      if (e.evento === "engajamento") {
        v.segundos = Math.max(v.segundos, e.valor || 0);
        v.rolagem = Math.max(v.rolagem, parseInt(e.detalhe, 10) || 0);
      } else if (e.evento === "clique") v.cliques.push(e);
      else if (e.evento === "lead_form_aberto") { v.abriu = true; v.marcos.push({ ts: e.ts, tipo: "formulario" }); }
      else if (e.evento === "gravacao") v.gravada = true;
    }
    for (const c of dados.cadastros) {
      const v = c.sessao && visitas.get(c.sessao);
      if (v) { v.cadastro = c; v.marcos.push({ ts: c.ts, tipo: "cadastro" }); }
    }
    for (const v of visitas.values()) {
      v.cliques.sort((a, b) => a.ts - b.ts);
      v.raiva = cliquesDeRaiva(v.cliques).length;
      v.semEfeito = v.cliques.filter((e) => cliqueSemEfeito(lerClique(e))).length;
      v.tempo = Math.max(v.segundos, Math.round((v.ultimo - v.pv.ts) / 1000));
      v.rapida = v.tempo < 10 && !v.cliques.length;
      v.nota = notaDe(v);
    }
    return [...visitas.values()];
  }

  // nota de 0 a 100: tempo, rolagem, cliques e o funil; quem se cadastrou tem 100
  function notaDe(v) {
    if (v.cadastro) return 100;
    return Math.round(Math.min(35, (v.tempo / 120) * 35) + Math.min(30, v.rolagem * 0.3) + Math.min(15, v.cliques.length * 3) + (v.abriu ? 20 : 0));
  }

  const FILTROS_PESSOAS = {
    gravadas: (v) => v.gravada,
    todas: () => true,
    cadastraram: (v) => Boolean(v.cadastro),
    abriram: (v) => v.abriu,
    frustracao: (v) => v.raiva > 0 || v.semEfeito > 0,
    rapidas: (v) => v.rapida,
  };
  const ORDENS_PESSOAS = {
    recentes: (a, b) => b.pv.ts - a.pv.ts,
    engajamento: (a, b) => b.nota - a.nota || b.pv.ts - a.pv.ts,
    longas: (a, b) => b.tempo - a.tempo,
    cliques: (a, b) => b.cliques.length - a.cliques.length,
    frustracao: (a, b) => (b.raiva * 3 + b.semEfeito) - (a.raiva * 3 + a.semEfeito),
  };

  function mediana(valores) {
    const v = valores.filter(Number.isFinite).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : NaN;
  }

  function renderPessoas(f, { animar, aoVivo }) {
    const filtro = FILTROS_PESSOAS[prefs.pessoas] ? prefs.pessoas : "gravadas";
    const ordem = ORDENS_PESSOAS[prefs.pessoasOrdem] ? prefs.pessoasOrdem : "recentes";
    $("#pessoas-ordem").value = ordem;
    const visitas = montarVisitas(f);
    estudio.nomes = cadastrosPorVisitante();
    estudio.ordem = ordemDasVisitas().ordem;

    // cada filtro mostra quantas visitas tem
    $$("#pessoas-filtros button").forEach((b) => {
      const k = b.dataset.pessoas;
      b.setAttribute("aria-pressed", String(k === filtro));
      if (!b.dataset.rotulo) b.dataset.rotulo = b.textContent;
      b.replaceChildren(b.dataset.rotulo, el("span", { class: "estudio__conta" }, fmtNum(visitas.filter(FILTROS_PESSOAS[k]).length)));
    });
    const gravadas = visitas.filter((v) => v.gravada).length;
    texto("#est-contagem", `${plural(gravadas, "gravação", "gravações")} · ${plural(visitas.length, "visita", "visitas")}`);

    const termo = normalizar($("#busca-pessoas").value.trim());
    let lista = visitas.filter(FILTROS_PESSOAS[filtro]);
    if (termo) {
      lista = lista.filter((v) => {
        const p = v.cadastro || estudio.nomes.get(v.pv.visitante) || {};
        return normalizar([p.nome, p.email, v.pv.cidade, v.pv.estado, v.pv.utm_campaign, v.pv.utm_content, v.pv.utm_term, v.pv.utm_source, identidade(v.pv.visitante).codigo].join(" ")).includes(termo);
      });
    }
    estudio.lista = lista.sort(ORDENS_PESSOAS[ordem]);
    if (!aoVivo) estudio.visiveis = LOTE_LISTA;
    desenharLista({ animar });

    // ao entrar na aba, a primeira da lista já aparece na ficha
    if (!estudio.selecionada && lista.length) abrirFicha(lista[0].sessao, { tocar: false });
  }

  function desenharLista({ animar = false } = {}) {
    const ol = $("#est-itens");
    const itens = estudio.lista.slice(0, estudio.visiveis);
    ol.classList.toggle("is-entrando", Boolean(animar && !movimentoReduzido));
    ol.replaceChildren(...(itens.length
      ? itens.map((v, i) => cartaoVisita(v, i))
      : [el("li", { class: "estudio__nada" }, "Nenhuma visita com esses critérios no período.")]));
    $("#est-mais").hidden = estudio.lista.length <= estudio.visiveis;
  }

  function nomeDaVisita(v) {
    const p = v.cadastro || estudio.nomes.get(v.pv.visitante);
    return p?.nome || `Visitante #${identidade(v.pv.visitante).codigo}`;
  }

  function avatar(v, classe) {
    const p = v.cadastro || estudio.nomes.get(v.pv.visitante);
    const { matiz } = identidade(v.pv.visitante);
    const n = el("span", { class: classe, style: { "--matiz": String(matiz) } });
    if (p?.nome) n.append(iniciais(p.nome));
    else n.append(icone(v.pv.dispositivo === "computador" ? "computador" : v.pv.dispositivo === "tablet" ? "tablet" : "celular"));
    return n;
  }

  function cartaoVisita(v, i) {
    const o = estudio.ordem.get(v.sessao);
    const duracaoMs = Math.max(1000, v.tempo * 1000, v.ultimo - v.pv.ts);
    const pos = (ts) => `${Math.min(97, Math.max(1, ((ts - v.pv.ts) / duracaoMs) * 100))}%`;
    // faixa da visita: cada clique e cada marco no ponto em que aconteceu
    const faixa = el("span", { class: "est-item__faixa", "aria-hidden": "true" },
      ...v.cliques.slice(0, 40).map((e) => el("i", { class: cliqueSemEfeito(lerClique(e)) ? "is-sem-efeito" : null, style: { left: pos(e.ts) } })),
      ...v.marcos.map((m) => el("b", { class: `is-${m.tipo}`, style: { left: pos(m.ts) } })));
    const selos = [
      v.gravada ? el("span", { class: "selo selo--gravada", title: "Visita gravada" }, icone("play")) : null,
      v.cadastro ? el("span", { class: "selo selo--cadastro", title: "Cadastrou" }, icone("estrela")) : null,
      !v.cadastro && v.abriu ? el("span", { class: "selo selo--formulario", title: "Abriu o formulário" }, icone("formulario")) : null,
      v.raiva || v.semEfeito ? el("span", { class: "selo selo--frustracao", title: `Frustração: ${v.raiva} de raiva, ${v.semEfeito} sem efeito` }, icone("raio")) : null,
    ].filter(Boolean);
    return el("li", {
      class: `est-item${v.sessao === estudio.selecionada ? " is-selecionada" : ""}${novosIds.has(`e${v.pv.id}`) ? " is-novo" : ""}`,
      role: "option",
      tabindex: v.sessao === estudio.selecionada ? 0 : -1,
      "aria-selected": String(v.sessao === estudio.selecionada),
      dataset: { sessao: v.sessao },
      style: { "--i": String(Math.min(i, 14)), "--matiz": String(identidade(v.pv.visitante).matiz) },
    },
    avatar(v, `est-item__avatar${v.gravada ? " is-gravada" : ""}`),
    el("span", { class: "est-item__corpo" },
      el("span", { class: "est-item__linha" },
        el("strong", {}, nomeDaVisita(v)),
        el("time", { dataset: { ts: v.pv.ts }, title: fmtDataHora.format(v.pv.ts) }, fmtRelativo(v.pv.ts))),
      el("span", { class: "est-item__detalhe" },
        etiquetaCanal(v.pv),
        [v.pv.utm_term || v.pv.utm_campaign, local(v.pv), o && o.total > 1 ? `${o.n}ª visita` : null].filter(Boolean).join(" · ")),
      faixa),
    el("span", { class: "est-item__lado" },
      el("span", { class: "est-item__duracao" }, fmtTempo(v.tempo * 1000)),
      el("span", { class: "est-item__selos" }, selos)));
  }

  /* ---------------------------------------------------------
     Ficha da pessoa e reprodução da visita

     A página é a mesma do mapa de cliques (sem scripts). A gravação traz a
     rolagem, o ponteiro do mouse, a abertura do formulário e a troca de aba
     (ver main.js); os cliques vêm dos eventos. Sem gravação, a reprodução
     mostra só os cliques, levando a página até cada um.
     --------------------------------------------------------- */
  const API_GRAVACAO = "/admin/api/gravacao";
  const rep = { t: 0, duracao: 1, tocando: false, quadro: 0, ultimo: 0, velocidade: 2, pedido: 0, itens: [] };
  const RAIO_ANEL = 50;
  const CIRCUNFERENCIA = 2 * Math.PI * RAIO_ANEL;

  // Uma visita é a aba do navegador. Cada recarga da página nessa aba é um
  // carregamento novo, que recomeça o relógio e a numeração das partes
  // (ver main.js); o início de cada carregamento põe tudo na mesma régua.
  function lerGravacao(partes) {
    if (!partes.length) return null;
    const base = Math.min(...partes.map((p) => (Number.isFinite(p.inicio) ? p.inicio : Infinity)));
    const desvioDe = (p) => (Number.isFinite(base) && Number.isFinite(p.inicio) ? p.inicio - base : 0);
    const ordenadas = partes.slice().sort((a, b) => desvioDe(a) - desvioDe(b) || a.seq - b.seq);
    const g = {
      inicio: Number.isFinite(base) ? base : partes[0].inicio,
      largura: ordenadas[0].largura, altura: ordenadas[0].altura, alturaDoc: 0,
      rolagem: [], mouse: [], marcas: [], cargas: [], campos: [],
    };
    for (const p of ordenadas) {
      const desvio = desvioDe(p);
      if (!g.cargas.includes(desvio)) {
        g.cargas.push(desvio);
        // a página recarregada começa com o formulário fechado
        if (desvio) { g.marcas.push([desvio, "f"]); g.campos.push([desvio, "r"]); }
      }
      g.alturaDoc = Math.max(g.alturaDoc, p.altura_doc || 0);
      for (const item of String(p.dados || "").split(";")) {
        const [t, tipo, a, b, c] = item.split(",");
        const tn = Number(t) + desvio;
        if (!Number.isFinite(tn)) continue;
        if (tipo === "s") g.rolagem.push([tn, Number(a)]);
        else if (tipo === "m") g.mouse.push([tn, Number(a), Number(b)]);
        else if (tipo === "i") {
          g.largura = Number(a) || g.largura;
          g.altura = Number(b) || g.altura;
          g.alturaDoc = Math.max(g.alturaDoc, Number(c) || 0);
        } else if (tipo === "o" || tipo === "k" || tipo === "b") g.campos.push([tn, tipo, a, Number(b)]);
        else if (tipo) g.marcas.push([tn, tipo]);
      }
    }
    for (const lista of [g.rolagem, g.mouse, g.marcas, g.campos]) lista.sort((x, y) => x[0] - y[0]);
    g.duracao = Math.max(0, ...[g.rolagem, g.mouse, g.marcas, g.campos].flat().map((x) => x[0]));
    return g;
  }

  // último valor até o instante t, com interpolação entre amostras próximas
  function valorEm(lista, t, campo = 1) {
    if (!lista.length || t < lista[0][0]) return lista.length ? lista[0][campo] : null;
    let a = 0;
    let b = lista.length - 1;
    while (a < b) {
      const m = (a + b + 1) >> 1;
      if (lista[m][0] <= t) a = m; else b = m - 1;
    }
    const atual = lista[a];
    const proximo = lista[a + 1];
    if (proximo && proximo[0] - atual[0] < 400) {
      const k = (t - atual[0]) / (proximo[0] - atual[0]);
      return atual[campo] + (proximo[campo] - atual[campo]) * k;
    }
    return atual[campo];
  }

  function posicaoDoClique(doc, janela, c, W) {
    try {
      const r = doc.querySelector(c.c)?.getBoundingClientRect();
      if (r && r.width && r.height) return [r.left + janela.scrollX + c.x * r.width, r.top + janela.scrollY + c.y * r.height];
    } catch { /* caminho inválido */ }
    return c.f ? null : [W / 2 + c.px, c.py];
  }

  function pararReproducao() {
    rep.tocando = false;
    cancelAnimationFrame(rep.quadro);
    $("#rep-tocar").replaceChildren(icone("play"));
    $("#rep-tocar").setAttribute("aria-label", "Reproduzir");
    $("#f-aparelho").classList.remove("is-tocando");
  }

  function visitaCompleta(sessao) {
    return estudio.lista.find((v) => v.sessao === sessao)
      || montarVisitas({ pvs: dados.pageviews.filter((p) => p.sessao === sessao) })[0];
  }

  async function abrirFicha(sessao, { tocar = true } = {}) {
    const v = visitaCompleta(sessao);
    if (!v) return;
    const pedido = ++rep.pedido;
    pararReproducao();
    estudio.selecionada = sessao;
    $$("#est-itens .est-item").forEach((li) => {
      const sim = li.dataset.sessao === sessao;
      li.classList.toggle("is-selecionada", sim);
      li.setAttribute("aria-selected", String(sim));
      li.tabIndex = sim ? 0 : -1;
    });

    $("#est-vazio").hidden = true;
    const ficha = $("#ficha");
    ficha.hidden = false;
    if (!movimentoReduzido) {
      ficha.classList.remove("is-trocando");
      void ficha.offsetWidth;
      ficha.classList.add("is-trocando");
    }

    const pv = v.pv;
    const p = v.cadastro || estudio.nomes.get(pv.visitante);
    const o = estudio.ordem.get(sessao);
    const { matiz } = identidade(pv.visitante);
    ficha.style.setProperty("--matiz", String(matiz));
    $("#f-avatar").replaceChildren(avatar(v, "ficha__avatar-dentro"));
    texto("#f-rotulo", [p?.nome ? "Pessoa cadastrada" : "Visitante anônimo", o && o.total > 1 ? `${o.n}ª de ${o.total} visitas` : "primeira visita"].join(" · "));
    texto("#rep-titulo", nomeDaVisita(v));
    texto("#rep-sub", [fmtDataHora.format(pv.ts), local(pv), [capitalizar(pv.dispositivo), pv.sistema, pv.navegador].filter(Boolean).join(" "), p?.email].filter(Boolean).join(" · "));
    $("#rep-sub").title = $("#rep-sub").textContent;

    // de onde veio: origem → campanha → conjunto → anúncio
    const etapas = [
      ["Origem", pv.utm_source ? `${pv.utm_source}${pv.utm_medium ? ` / ${pv.utm_medium}` : ""}` : pv.referencia || "Acesso direto"],
      ["Campanha", pv.utm_campaign],
      ["Conjunto", pv.utm_content],
      ["Anúncio", pv.utm_term],
    ].filter(([, valor]) => valor);
    $("#f-trilha").replaceChildren(...etapas.flatMap(([rotulo, valor], i) => [
      i ? el("li", { class: "ficha__trilha-seta", "aria-hidden": "true" }, icone("seta")) : null,
      el("li", { class: "ficha__trilha-etapa", style: { "--i": String(i) } }, el("span", {}, rotulo), el("strong", { title: valor }, valor)),
    ]).filter(Boolean));

    // nota de engajamento no anel
    const anel = $("#f-anel");
    anel.style.strokeDasharray = String(CIRCUNFERENCIA);
    anel.style.strokeDashoffset = String(CIRCUNFERENCIA);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      anel.style.strokeDashoffset = String(CIRCUNFERENCIA * (1 - v.nota / 100));
    }));
    $("#f-pontos").dataset.valor = "0";
    contar("#f-pontos", v.nota);

    // medidores
    const medidor = (simbolo, rotulo, valor, fracao, nota, classe = "") => el("div", { class: `medidor ${classe}` },
      el("span", { class: "medidor__icone" }, icone(simbolo)),
      el("span", { class: "medidor__rotulo" }, rotulo),
      el("strong", { class: "medidor__valor" }, valor),
      el("span", { class: "medidor__trilho" }, el("span", { class: "medidor__barra", style: { "--fracao": String(Math.max(0.02, Math.min(1, fracao))) } })),
      el("span", { class: "medidor__nota" }, nota));
    $("#f-metricas").replaceChildren(
      medidor("relogio", "Tempo", fmtDuracao(v.tempo), v.tempo / 180, v.tempo >= 60 ? "leu com calma" : v.tempo >= 15 ? "passou os olhos" : "saiu logo"),
      medidor("rolagem", "Rolagem", `${v.rolagem}%`, v.rolagem / 100, v.rolagem >= 75 ? "viu quase tudo" : v.rolagem >= 40 ? "viu metade" : "ficou no topo"),
      medidor("clique", "Cliques", fmtNum(v.cliques.length), v.cliques.length / 10, v.cadastro ? "e se cadastrou" : v.abriu ? "abriu o formulário" : "não abriu o formulário"),
      medidor("raio", "Frustração", v.raiva || v.semEfeito ? `${v.raiva + v.semEfeito}` : "nenhuma", (v.raiva * 3 + v.semEfeito) / 8,
        v.raiva ? `${plural(v.raiva, "clique", "cliques")} de raiva` : v.semEfeito ? `${plural(v.semEfeito, "clique", "cliques")} sem efeito` : "navegou sem tropeços",
        v.raiva || v.semEfeito ? "medidor--alerta" : "medidor--tranquilo"),
    );

    // outras visitas do mesmo navegador
    const { porVisitante } = ordemDasVisitas();
    const outras = (porVisitante.get(pv.visitante) || []).filter((s) => s.sessao !== sessao);
    $("#rep-outras").hidden = !outras.length;
    $("#rep-visitas").replaceChildren(...outras.map((s) => {
      const b = el("button", { type: "button" }, el("span", {}, fmtDataHora.format(s.ts)), el("span", {}, s.utm_term || origemMidia(s)));
      b.addEventListener("click", () => abrirFicha(s.sessao));
      return el("li", {}, b);
    }));

    // reprodução
    $("#rep-visor").replaceChildren(el("p", { class: "mapa__aviso" }, "Carregando a visita…"));
    const eventos = dados.eventos.filter((e) => e.sessao === sessao).sort((a, b) => a.ts - b.ts);
    let partes = [];
    if (!DEMO && v.gravada) {
      try {
        const r = await fetch(`${API_GRAVACAO}?sessao=${encodeURIComponent(sessao)}`, { cache: "no-store", credentials: "same-origin" });
        if (r.ok) partes = (await r.json()).partes || [];
      } catch { /* segue sem gravação */ }
    }
    if (pedido !== rep.pedido) return; // outra pessoa foi escolhida enquanto baixava
    prepararReproducao({ pv, eventos, cadastro: v.cadastro, partes, tocar });
  }

  const TIPOS_LINHA = {
    entrada: { icone: "entrada", cor: CORES.acessos },
    clique: { icone: "clique", cor: "#ff9933" },
    "sem-efeito": { icone: "raio", cor: "#ff8a7a" },
    formulario: { icone: "formulario", cor: CORES.verde },
    cadastro: { icone: "estrela", cor: CORES.cadastros },
    rolagem: { icone: "rolagem", cor: CORES.anterior },
    recarga: { icone: "recarregar", cor: "#8fb8ff" },
    digitacao: { icone: "teclado", cor: "#c9a2ff" },
    "erro-campo": { icone: "alerta", cor: "#ff8a7a" },
  };
  // nome do campo com o artigo e as contrações: [o, no, pelo]
  const NOMES_CAMPOS = { nome: ["o nome", "no nome", "pelo nome"], email: ["o e-mail", "no e-mail", "pelo e-mail"], telefone: ["o WhatsApp", "no WhatsApp", "pelo WhatsApp"] };

  function prepararReproducao({ pv, eventos, cadastro, partes, tocar }) {
    const g = lerGravacao(partes);
    const computador = g ? g.largura >= 960 : pv.dispositivo === "computador";
    const largura = g?.largura || (computador ? 1440 : 390);
    const altura = g?.altura || (computador ? 900 : 844);
    const inicio = g?.inicio ?? pv.ts;

    rep.g = g;
    rep.cliques = eventos.filter((e) => e.evento === "clique").map((e) => ({ t: e.ts - inicio, c: lerClique(e) })).filter((x) => x.c);
    rep.formulario = eventos.filter((e) => e.evento === "lead_form_aberto").map((e) => e.ts - inicio);

    // linha do tempo: a lista ao lado e as marcas da barra
    const itens = [{ t: Math.max(0, pv.ts - inicio), rotulo: "Entrou na página", sub: pv.utm_term || origemMidia(pv), tipo: "entrada" }];
    for (const e of eventos) {
      const t = e.ts - inicio;
      if (e.evento === "clique") {
        const c = lerClique(e);
        const sem = cliqueSemEfeito(c);
        itens.push({ t, rotulo: sem ? "Clicou sem efeito" : "Clicou", sub: c?.l || "(sem texto)", tipo: sem ? "sem-efeito" : "clique" });
      } else if (e.evento === "lead_form_aberto") itens.push({ t, rotulo: "Abriu o formulário", sub: CTAS[e.detalhe] || e.detalhe || "", tipo: "formulario" });
      else if (e.evento === "lead_esquenta_black") itens.push({ t, rotulo: "Enviou o cadastro", sub: CTAS[e.detalhe] || "", tipo: "cadastro" });
      else if (e.evento === "gtm.scrollDepth") itens.push({ t, rotulo: `Rolou ${e.detalhe}% da página`, sub: "", tipo: "rolagem" });
      else if (e.evento === "page_view" && e.id !== pv.id) itens.push({ t, rotulo: "Recarregou a página", sub: "mesma aba, carregamento novo", tipo: "recarga" });
    }
    // campos do formulário: um item ao sair de cada campo, com o tamanho do
    // que foi digitado (o conteúdo não é gravado) ou o aviso de erro
    const tamanhos = {};
    for (const [ct, tipo, campo, n] of g?.campos || []) {
      if (tipo === "r") { for (const k in tamanhos) delete tamanhos[k]; continue; }
      if (tipo === "k") { tamanhos[campo] = n; continue; }
      if (tipo !== "b" || !NOMES_CAMPOS[campo]) continue;
      const tam = tamanhos[campo] || 0;
      itens.push(n === 0
        ? { t: ct, rotulo: `Erro ${NOMES_CAMPOS[campo][1]}`, sub: tam ? `${plural(tam, "caractere", "caracteres")}; corrigir para enviar` : "deixou em branco", tipo: "erro-campo" }
        : tam
          ? { t: ct, rotulo: `Preencheu ${NOMES_CAMPOS[campo][0]}`, sub: plural(tam, "caractere", "caracteres"), tipo: "digitacao" }
          : { t: ct, rotulo: `Passou ${NOMES_CAMPOS[campo][2]}`, sub: "sem digitar", tipo: "digitacao" });
    }
    // o envio (dataLayer) e a cópia gravada no banco são o mesmo cadastro: um item só
    if (cadastro) {
      const tc = cadastro.ts - inicio;
      const envio = itens.filter((x) => x.tipo === "cadastro").sort((a, b) => Math.abs(a.t - tc) - Math.abs(b.t - tc))[0];
      if (envio && Math.abs(envio.t - tc) < 15000) Object.assign(envio, { rotulo: "Cadastrou", sub: cadastro.nome || cadastro.email });
      else itens.push({ t: tc, rotulo: "Cadastrou", sub: cadastro.nome || cadastro.email, tipo: "cadastro" });
    }
    itens.sort((a, b) => a.t - b.t);
    rep.itens = itens;
    rep.atual = -1;

    // fora da aba e instantes com atividade (para pular pausas)
    rep.foraDaAba = [];
    if (g) {
      let saiu = null;
      for (const [t, tipo] of g.marcas) {
        if (tipo === "h") saiu = t;
        else if (tipo === "v" && saiu !== null) { rep.foraDaAba.push([saiu, t]); saiu = null; }
      }
      if (saiu !== null) rep.foraDaAba.push([saiu, g.duracao]);
    }
    rep.atividade = [...new Set([
      ...(g ? [...g.rolagem, ...g.mouse, ...g.marcas, ...g.campos].map((x) => x[0]) : []),
      ...rep.cliques.map((x) => x.t),
      ...itens.map((x) => x.t),
    ])].sort((a, b) => a - b);
    rep.duracao = Math.max(1000, g?.duracao || 0, ...itens.map((x) => x.t + 1500));
    rep.t = 0;

    $("#rep-aviso").hidden = Boolean(g);
    $("#rep-aviso").textContent = DEMO
      ? "No modo demonstração não há gravações; a reprodução mostra só os cliques."
      : "Visita sem gravação (gravamos 20% das visitas e todas que abrem o formulário). A reprodução leva a página até cada clique.";

    const pct = (t) => `${Math.min(100, Math.max(0, (t / rep.duracao) * 100))}%`;
    $("#rep-marcas").replaceChildren(
      ...rep.foraDaAba.map(([a, b]) => el("span", { class: "reproducao__pausa", style: { left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }, title: "Fora da aba" })),
      ...itens.slice(1).map((x) => el("span", { class: "reproducao__marca", style: { left: pct(x.t), background: TIPOS_LINHA[x.tipo].cor }, title: `${x.rotulo} ${x.sub}` })),
    );
    const barra = $("#rep-barra");
    barra.max = String(Math.round(rep.duracao));
    barra.value = "0";

    const linha = $("#rep-jornada");
    linha.style.setProperty("--progresso", "0");
    linha.replaceChildren(...itens.map((x, i) => {
      const tipo = TIPOS_LINHA[x.tipo];
      const li = el("li", { dataset: { i, tipo: x.tipo }, style: { "--cor": tipo.cor, "--i": String(Math.min(i, 12)) } },
        el("span", { class: "linha-tempo__ponto" }, icone(tipo.icone)),
        el("span", { class: "linha-tempo__texto" },
          el("strong", {}, x.rotulo),
          x.sub ? el("span", {}, x.sub) : null),
        el("time", {}, fmtTempo(x.t)));
      li.addEventListener("click", () => { rep.t = Math.max(0, x.t - 1200); desenharReproducao(); });
      return li;
    }));

    // a página, no tamanho da tela da pessoa, dentro da moldura do aparelho
    const aparelho = $("#f-aparelho");
    aparelho.classList.toggle("is-celular", !computador);
    aparelho.classList.toggle("is-computador", computador);
    const visor = $("#rep-visor");
    const iframe = el("iframe", { src: DEMO ? "../index.html?mapa=1" : "../?mapa=1", sandbox: "allow-same-origin", title: "Reprodução da visita", width: largura, height: altura });
    visor.replaceChildren(iframe);
    Object.assign(rep, { iframe, largura, altura, computador, escala: 1, doc: null });
    dimensionarReproducao();

    iframe.addEventListener("load", () => {
      let doc = null;
      try { doc = iframe.contentDocument; } catch { /* outra origem */ }
      if (!doc?.body) {
        $("#rep-aviso").hidden = false;
        $("#rep-aviso").textContent = "Aberto do disco, o navegador não deixa o painel ler a página. A reprodução funciona no painel publicado.";
        return;
      }
      soltarRolagem(doc);
      rep.doc = doc;
      const camada = (estilo) => {
        const n = doc.createElement("div");
        Object.assign(n.style, { position: "absolute", left: "0", top: "0", pointerEvents: "none", zIndex: "2147483647" }, estilo);
        doc.body.append(n);
        return n;
      };
      const temMouse = Boolean(g?.mouse.length);
      // rastro do cursor: bolinhas que seguem a seta, cada vez mais apagadas
      rep.rastro = Array.from({ length: 8 }, (_, i) => camada({
        width: "10px", height: "10px", borderRadius: "50%", background: "rgba(255,153,51,0.9)",
        opacity: String(0.5 - i * 0.055), display: temMouse ? "block" : "none",
      }));
      rep.cursor = camada({ width: "22px", height: "22px", display: temMouse ? "block" : "none", filter: "drop-shadow(0 2px 4px rgba(0,0,0,.6))" });
      // seta do mouse: SVG fixo, escrito aqui (nada vindo do banco)
      rep.cursor.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#fff" stroke="#120c08" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      rep.toques = Array.from({ length: 6 }, () => camada({ borderRadius: "50%", border: "3px solid #ff9933", background: "rgba(255,153,51,0.25)", boxShadow: "0 0 24px rgba(255,153,51,.6)", display: "none" }));
      rep.fatorY = g && g.alturaDoc ? doc.documentElement.scrollHeight / g.alturaDoc : 1;
      rep.fatorRolagem = g && g.alturaDoc > altura ? (doc.documentElement.scrollHeight - altura) / (g.alturaDoc - altura) : 1;
      desenharReproducao();
      if (tocar && g) alternarReproducao();
    }, { once: true });
  }

  // Tamanho do aparelho. Lado a lado com a lista (ou em tela cheia), a ficha
  // tem altura fixa: o aparelho usa o que sobra abaixo do cabeçalho, medidos
  // os controles (que podem quebrar em duas linhas), o aviso, a moldura, a luz
  // do chão e os espaços. Em coluna, a página rola e vale uma fração da tela.
  function dimensionarReproducao() {
    const { iframe, largura, altura, computador } = rep;
    if (!iframe) return;
    const ficha = $("#ficha");
    const cheia = telaCheiaAtiva(ficha);
    const palco = $(".ficha__palco");
    const disponivel = Math.max(200, palco.clientWidth - (computador ? 28 : 24));
    const emColuna = !cheia && window.matchMedia("(max-width: 1099px)").matches;
    const aviso = $("#rep-aviso");
    const reservado = (cheia ? 48 : 40) + 16 + 12 + 26 + (computador ? 34 : 28) + 16
      + $("#rep-controles").offsetHeight + (aviso.hidden ? 0 : aviso.offsetHeight + 12);
    const caixa = cheia ? ficha : $("#est-ficha");
    const livre = emColuna
      ? window.innerHeight * (computador ? 0.5 : 0.62)
      : Math.max(240, caixa.clientHeight - $(".ficha__topo").offsetHeight - reservado);
    const escala = Math.min(cheia ? 2 : 1, disponivel / largura, livre / altura);
    const visor = $("#rep-visor");
    visor.style.width = `${Math.floor(largura * escala)}px`;
    visor.style.height = `${Math.floor(altura * escala)}px`;
    iframe.style.transform = `scale(${escala})`;
    rep.escala = escala;
    // a coluna ao lado (medidas + linha do tempo) vai até a altura do palco já
    // desenhado; a linha do tempo rola por dentro
    $(".ficha__tempo").style.maxHeight = emColuna ? ""
      : `${Math.max(160, palco.offsetHeight - $("#f-metricas").offsetHeight - 16)}px`;
  }

  /* Tela cheia (reprodução e mapa de cliques). Onde o navegador não deixa um
     bloco qualquer ocupar a tela (iPhone), a classe is-tela-cheia faz o mesmo
     com position: fixed. */
  const telaCheiaAtiva = (n) => document.fullscreenElement === n || n.classList.contains("is-tela-cheia");
  async function alternarTelaCheia(n) {
    if (telaCheiaAtiva(n)) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      n.classList.remove("is-tela-cheia");
    } else if (document.fullscreenEnabled && n.requestFullscreen) {
      await n.requestFullscreen().catch(() => n.classList.add("is-tela-cheia"));
    } else {
      n.classList.add("is-tela-cheia");
    }
    depoisDaTelaCheia();
  }
  function depoisDaTelaCheia() {
    for (const [botao, alvo] of [["#rep-tela-cheia", "#ficha"], ["#mapa-tela-cheia", "#cartao-mapa"]]) {
      const ativa = telaCheiaAtiva($(alvo));
      $(botao).replaceChildren(icone(ativa ? "sairTela" : "telaCheia"), el("span", {}, ativa ? "Sair da tela cheia" : "Tela cheia"));
      $(botao).setAttribute("aria-pressed", String(ativa));
    }
    // espera o navegador assentar o novo tamanho
    requestAnimationFrame(() => {
      dimensionarReproducao();
      Object.values(quadros).forEach((q) => { escalarQuadro(q); q.desenho?.(); });
    });
  }
  document.addEventListener("fullscreenchange", depoisDaTelaCheia);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const aberta = $(".is-tela-cheia");
    if (aberta) { aberta.classList.remove("is-tela-cheia"); depoisDaTelaCheia(); }
  });
  window.addEventListener("resize", () => dimensionarReproducao());

  function desenharReproducao() {
    const t = rep.t;
    texto("#rep-tempo", `${fmtTempo(t)} / ${fmtTempo(rep.duracao)}${rep.foraDaAba?.some(([a, b]) => t >= a && t < b) ? " · fora da aba" : ""}`);
    $("#rep-barra").value = String(Math.round(t));
    // parte já tocada da barra, pintada pelo CSS (ver .reproducao__linha input)
    $("#rep-barra").style.setProperty("--p", String(rep.duracao ? Math.min(1, t / rep.duracao) : 0));

    // linha do tempo acompanha a reprodução
    let atual = -1;
    rep.itens.forEach((x, i) => { if (x.t <= t) atual = i; });
    const linha = $("#rep-jornada");
    linha.style.setProperty("--progresso", String(rep.itens.length > 1 ? Math.max(0, atual) / (rep.itens.length - 1) : 0));
    if (atual !== rep.atual) {
      rep.atual = atual;
      $$("li", linha).forEach((li, i) => {
        li.classList.toggle("is-atual", i === atual);
        li.classList.toggle("is-passado", i < atual);
      });
      const li = linha.children[atual];
      const caixa = linha.closest(".ficha__tempo");
      if (li && caixa) {
        const alvo = li.offsetTop - caixa.clientHeight / 2;
        caixa.scrollTo({ top: Math.max(0, alvo), behavior: movimentoReduzido ? "auto" : "smooth" });
      }
    }

    const doc = rep.doc;
    if (!doc) return;
    const janela = rep.iframe.contentWindow;
    const W = doc.documentElement.scrollWidth;
    const g = rep.g;

    // rolagem: a gravada; sem gravação, a página vai até o último clique
    let y = 0;
    if (g?.rolagem.length) {
      y = valorEm(g.rolagem, t) * rep.fatorRolagem;
    } else {
      const ultimo = [...rep.cliques].reverse().find((x) => x.t <= t);
      const p = ultimo && posicaoDoClique(doc, janela, ultimo.c, W);
      if (p) y = p[1] - rep.altura / 2;
    }
    // "instant": a LP tem scroll-behavior: smooth, que faria a página escorregar até o ponto
    janela.scrollTo({ top: Math.max(0, y), behavior: "instant" });

    // formulário aberto ou fechado
    let aberto = false;
    if (g) {
      for (const [mt, tipo] of g.marcas) {
        if (mt > t) break;
        if (tipo === "a") aberto = true;
        else if (tipo === "f") aberto = false;
      }
    } else {
      aberto = rep.formulario.some((ft) => ft <= t);
    }
    doc.getElementById("lead")?.classList.toggle("is-aberto", aberto);

    // campos: pontos no lugar do que foi digitado (só o tamanho é gravado),
    // destaque no campo em foco e o aviso de erro de quando a pessoa saiu dele
    if (g?.campos.length) {
      const estado = {};
      let foco = null;
      for (const [ct, tipo, campo, n] of g.campos) {
        if (ct > t) break;
        if (tipo === "r") { for (const k in estado) delete estado[k]; foco = null; continue; }
        const s = (estado[campo] ||= { n: 0, erro: false });
        if (tipo === "k") s.n = n;
        else if (tipo === "o") foco = campo;
        else if (tipo === "b") { s.erro = n === 0; if (foco === campo) foco = null; }
      }
      for (const campo of Object.keys(NOMES_CAMPOS)) {
        const input = doc.getElementById(`lead-${campo}`);
        if (!input) continue;
        const s = estado[campo] || { n: 0, erro: false };
        const valor = "•".repeat(Math.min(s.n, 80));
        if (input.value !== valor) input.value = valor;
        input.closest(".campo")?.classList.toggle("is-invalido", s.erro);
        input.style.outline = foco === campo ? "2px solid #ff9933" : "";
        input.style.outlineOffset = foco === campo ? "2px" : "";
        input.style.boxShadow = foco === campo ? "0 0 0 6px rgba(255,153,51,.18)" : "";
      }
    }

    // cursor e rastro
    if (g?.mouse.length) {
      const ponto = (instante) => [W / 2 + valorEm(g.mouse, instante, 1), valorEm(g.mouse, instante, 2) * rep.fatorY];
      const [mx, my] = ponto(t);
      rep.cursor.style.transform = `translate(${mx}px, ${my}px)`;
      rep.rastro.forEach((n, i) => {
        const [rx, ry] = ponto(t - (i + 1) * 45);
        n.style.transform = `translate(${rx - 5}px, ${ry - 5}px) scale(${1 - i * 0.09})`;
      });
    }

    // toques e cliques do último 0,7 s, como ondas que se abrem
    const recentes = rep.cliques.filter((x) => x.t <= t && t - x.t < 700).slice(-rep.toques.length);
    rep.toques.forEach((n, i) => {
      const x = recentes[i];
      const p = x && posicaoDoClique(doc, janela, x.c, W);
      if (!p) { n.style.display = "none"; return; }
      const idade = (t - x.t) / 700;
      const tamanho = 18 + idade * 52;
      Object.assign(n.style, {
        display: "block",
        width: `${tamanho}px`,
        height: `${tamanho}px`,
        opacity: String(1 - idade),
        transform: `translate(${p[0] - tamanho / 2}px, ${p[1] - tamanho / 2}px)`,
      });
    });
  }

  function proximaAtividade(t) {
    const lista = rep.atividade;
    let a = 0;
    let b = lista.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (lista[m] <= t) a = m + 1; else b = m;
    }
    return a < lista.length ? lista[a] : null;
  }

  function passoReproducao(agora) {
    if (!rep.tocando) return;
    const dt = Math.min(100, agora - rep.ultimo);
    rep.ultimo = agora;
    rep.t += dt * rep.velocidade;
    if ($("#rep-pular").checked) {
      const proxima = proximaAtividade(rep.t);
      if (proxima !== null && proxima - rep.t > 1500) rep.t = proxima - 300;
    }
    if (rep.t >= rep.duracao) {
      rep.t = rep.duracao;
      desenharReproducao();
      pararReproducao();
      return;
    }
    desenharReproducao();
    rep.quadro = requestAnimationFrame(passoReproducao);
  }

  function alternarReproducao() {
    if (rep.tocando) { pararReproducao(); return; }
    if (rep.t >= rep.duracao) rep.t = 0;
    rep.tocando = true;
    rep.ultimo = performance.now();
    $("#rep-tocar").replaceChildren(icone("pausa"));
    $("#rep-tocar").setAttribute("aria-label", "Pausar");
    $("#f-aparelho").classList.add("is-tocando");
    rep.quadro = requestAnimationFrame(passoReproducao);
  }

  function marcarVelocidade() {
    $$("#rep-velocidades button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.velocidade) === rep.velocidade)));
  }
  marcarVelocidade();

  $("#rep-tocar").addEventListener("click", alternarReproducao);
  $("#rep-tela-cheia").addEventListener("click", () => alternarTelaCheia($("#ficha")));
  $("#mapa-tela-cheia").addEventListener("click", () => alternarTelaCheia($("#cartao-mapa")));
  depoisDaTelaCheia();
  $("#rep-barra").addEventListener("input", (e) => { rep.t = Number(e.target.value); desenharReproducao(); });

  // Aparelho em perspectiva: inclina na direção do mouse e endireita quando
  // a reprodução toca (ver .ficha__aparelho no CSS). Só com mouse; sem
  // movimento reduzido.
  (() => {
    const palco = $(".ficha__palco");
    if (movimentoReduzido || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let quadro = 0;
    palco.addEventListener("pointermove", (e) => {
      cancelAnimationFrame(quadro);
      quadro = requestAnimationFrame(() => {
        const r = palco.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        palco.style.setProperty("--giro-y", `${(x * 10).toFixed(2)}deg`);
        palco.style.setProperty("--giro-x", `${(-y * 7).toFixed(2)}deg`);
        palco.style.setProperty("--brilho-x", `${((x + 0.5) * 100).toFixed(1)}%`);
      });
    });
    palco.addEventListener("pointerleave", () => {
      cancelAnimationFrame(quadro);
      ["--giro-y", "--giro-x", "--brilho-x"].forEach((v) => palco.style.removeProperty(v));
    });
  })();
  $("#rep-velocidades").addEventListener("click", (e) => {
    const b = e.target.closest("[data-velocidade]");
    if (!b) return;
    rep.velocidade = Number(b.dataset.velocidade);
    marcarVelocidade();
  });

  // lista: escolher, rolar sem fim e navegar pelo teclado
  // abaixo de 1100px a ficha fica embaixo da lista (ver admin.css): o toque
  // leva até ela
  const estudioEmColuna = window.matchMedia("(max-width: 1099px)");
  $("#est-itens").addEventListener("click", (e) => {
    const li = e.target.closest(".est-item");
    if (!li) return;
    abrirFicha(li.dataset.sessao);
    if (estudioEmColuna.matches) $("#est-ficha").scrollIntoView({ block: "start", behavior: movimentoReduzido ? "auto" : "smooth" });
  });
  // rolagem sem fim: perto do fim da lista, entram mais 60
  $("#est-itens").addEventListener("scroll", (e) => {
    const lista = e.currentTarget;
    if (estudio.lista.length <= estudio.visiveis || lista.scrollTop + lista.clientHeight < lista.scrollHeight - 240) return;
    estudio.visiveis += LOTE_LISTA;
    desenharLista();
  }, { passive: true });

  function moverSelecao(passo) {
    const i = estudio.lista.findIndex((v) => v.sessao === estudio.selecionada);
    const proxima = estudio.lista[Math.min(estudio.lista.length - 1, Math.max(0, i + passo))];
    if (!proxima || proxima.sessao === estudio.selecionada) return;
    if (estudio.lista.indexOf(proxima) >= estudio.visiveis) { estudio.visiveis += LOTE_LISTA; desenharLista(); }
    abrirFicha(proxima.sessao);
    const li = $(`#est-itens .est-item[data-sessao="${CSS.escape(proxima.sessao)}"]`);
    li?.focus({ preventScroll: true });
    li?.scrollIntoView({ block: "nearest", behavior: movimentoReduzido ? "auto" : "smooth" });
  }

  document.addEventListener("keydown", (e) => {
    if (prefs.aba !== "pessoas" || e.target.closest("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moverSelecao(e.key === "ArrowDown" ? 1 : -1); }
    else if (e.key === " " && !e.target.closest("button")) { e.preventDefault(); alternarReproducao(); }
    else if ((e.key === "f" || e.key === "F") && !$("#ficha").hidden) { e.preventDefault(); alternarTelaCheia($("#ficha")); }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      rep.t = Math.min(rep.duracao, Math.max(0, rep.t + (e.key === "ArrowRight" ? 5000 : -5000)));
      desenharReproducao();
    }
  });

  /* ---------------------------------------------------------
     Filtros inteligentes: seleção múltipla, busca e contagem que considera
     os outros filtros e o período
     --------------------------------------------------------- */
  const chevron = () => {
    const s = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    s.append(svgEl("path", { d: "m6 9 6 6 6-6" }));
    return s;
  };

  (function montarFiltros() {
    $("#filtros-dimensoes").replaceChildren(...FILTROS.map((def) => el("div", { class: "filtro", dataset: { filtro: def.k } },
      el("button", { type: "button", class: "filtro__botao", "aria-expanded": "false", "aria-haspopup": "true", id: `filtro-${def.k}` }),
      el("div", { class: "suspenso", hidden: true, role: "dialog", "aria-label": `Filtrar por ${def.nome.toLowerCase()}` }))));
  })();

  const nomeValor = (def, v) => (v === VAZIO ? "(sem valor)" : def.mostrar ? def.mostrar(v) : v);

  function atualizarBotoesFiltro() {
    for (const def of FILTROS) {
      const botao = $(`#filtro-${def.k}`);
      const lista = prefs.filtros[def.k] || [];
      botao.classList.toggle("is-ativo", lista.length > 0);
      // replaceChildren escreveria "null" como texto: os itens vazios saem antes
      botao.replaceChildren(...[def.nome,
        lista.length === 1 ? el("strong", {}, nomeValor(def, lista[0])) : lista.length > 1 ? el("strong", {}, `${lista.length} selecionados`) : null,
        chevron()].filter(Boolean));
    }
    const ativos = $("#ativos");
    const etiquetas = [];
    for (const def of FILTROS) {
      for (const v of prefs.filtros[def.k] || []) {
        const remover = el("button", { type: "button", "aria-label": `Remover filtro ${def.nome}: ${nomeValor(def, v)}` }, "×");
        remover.addEventListener("click", () => alternarFiltro(def.k, v === VAZIO ? "" : v));
        etiquetas.push(el("span", { class: "etiqueta-filtro" }, el("span", {}, `${def.nome}:`), nomeValor(def, v), remover));
      }
    }
    ativos.hidden = !etiquetas.length;
    if (etiquetas.length) {
      const limpar = el("button", { type: "button", class: "ativos__limpar" }, "Limpar tudo");
      limpar.addEventListener("click", () => { prefs.filtros = {}; aplicarFiltros(); });
      ativos.replaceChildren(el("span", { class: "ativos__rotulo" }, "Filtrando por"), ...etiquetas, limpar);
    } else {
      ativos.replaceChildren();
    }
  }

  // contagem por valor: visitas do período que passam pelos OUTROS filtros
  function contagemFacetada(k) {
    const [inicio, fim] = intervalo();
    const contagem = new Map();
    for (const s of dados.sessoes.values()) {
      if (s.ts < inicio || s.ts >= fim || !passaDims(s, k)) continue;
      const v = s[k] || VAZIO;
      contagem.set(v, (contagem.get(v) || 0) + 1);
    }
    for (const v of prefs.filtros[k] || []) if (!contagem.has(v)) contagem.set(v, 0);
    return [...contagem].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  }

  let suspensoAberto = null;

  function abrirSuspenso(k) {
    fecharSuspenso();
    const def = FILTROS.find((d) => d.k === k);
    const caixa = $(`.filtro[data-filtro="${k}"]`);
    const botao = $(".filtro__botao", caixa);
    const painel = $(".suspenso", caixa);
    const opcoes = contagemFacetada(k);
    const maximo = Math.max(1, ...opcoes.map(([, n]) => n));
    const busca = el("input", { type: "search", class: "suspenso__busca", placeholder: `Buscar ${def.nome.toLowerCase()}`, "aria-label": `Buscar ${def.nome.toLowerCase()}` });
    const lista = el("ul", { class: "suspenso__lista", role: "listbox", "aria-multiselectable": "true" });
    const rodape = el("div", { class: "suspenso__rodape" });

    function desenharOpcoes() {
      const termo = normalizar(busca.value.trim());
      const selecionados = prefs.filtros[k] || [];
      const visiveis = opcoes.filter(([v]) => !termo || normalizar(nomeValor(def, v)).includes(termo));
      lista.replaceChildren(...(visiveis.length ? visiveis.map(([v, n]) => {
        const marcado = selecionados.includes(v);
        const item = el("li", {
          class: `suspenso__opcao${n ? "" : " is-zero"}`, role: "option", tabindex: 0, "aria-selected": String(marcado),
        },
        el("input", { type: "checkbox", checked: marcado, tabindex: -1, "aria-hidden": "true" }),
        el("span", { class: "suspenso__nome", title: nomeValor(def, v) }, nomeValor(def, v)),
        el("span", { class: "suspenso__conta" }, fmtNum(n)),
        el("span", { class: "suspenso__barra", style: { width: `${(n / maximo) * 100}%` } }));
        const alternar = (e) => {
          e?.preventDefault();
          alternarFiltro(k, v === VAZIO ? "" : v);
          desenharOpcoes();
        };
        item.addEventListener("click", alternar);
        item.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") alternar(e); });
        return item;
      }) : [el("li", { class: "suspenso__vazio" }, "Nada encontrado.")]));
      const limpar = el("button", { type: "button" }, "Limpar");
      limpar.addEventListener("click", () => { delete prefs.filtros[k]; aplicarFiltros(); desenharOpcoes(); });
      rodape.replaceChildren(...[el("span", {}, `visitas no período${filtrosAtivos() ? ", com os outros filtros" : ""}`), selecionados.length ? limpar : null].filter(Boolean));
    }

    busca.addEventListener("input", desenharOpcoes);
    painel.replaceChildren(busca, lista, rodape);
    desenharOpcoes();
    painel.hidden = false;
    botao.setAttribute("aria-expanded", "true");
    suspensoAberto = k;
    busca.focus();
  }

  function fecharSuspenso(devolverFoco = false) {
    if (!suspensoAberto) return;
    const caixa = $(`.filtro[data-filtro="${suspensoAberto}"]`);
    $(".suspenso", caixa).hidden = true;
    const botao = $(".filtro__botao", caixa);
    botao.setAttribute("aria-expanded", "false");
    if (devolverFoco) botao.focus();
    suspensoAberto = null;
  }

  $("#filtros-dimensoes").addEventListener("click", (e) => {
    const botao = e.target.closest(".filtro__botao");
    if (!botao) return;
    const k = botao.closest(".filtro").dataset.filtro;
    if (suspensoAberto === k) fecharSuspenso();
    else abrirSuspenso(k);
  });
  document.addEventListener("pointerdown", (e) => { if (suspensoAberto && !e.target.closest(".filtro")) fecharSuspenso(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && suspensoAberto) fecharSuspenso(true); });

  function aplicarFiltros() {
    estadoTabela.pagina = 0;
    gravarPrefs();
    atualizarControles();
    render({ animar: true });
  }

  function atualizarControles() {
    $$("#periodos button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.periodo === prefs.periodo)));
    // no celular a fileira rola de lado (ver admin.css): o período escolhido
    // fica à vista, centralizado, sem mexer na rolagem da página
    const ativo = $("#periodos [aria-pressed='true']");
    const fileira = $("#periodos").parentElement;
    if (ativo && fileira.scrollWidth > fileira.clientWidth) {
      const a = ativo.getBoundingClientRect();
      const r = fileira.getBoundingClientRect();
      if (a.left < r.left || a.right > r.right) fileira.scrollLeft += a.left - r.left - (r.width - a.width) / 2;
    }
    $("#datas").hidden = prefs.periodo !== "personalizado";
    $("#f-de").value = prefs.de;
    $("#f-ate").value = prefs.ate;
    atualizarBotoesFiltro();
  }

  /* ---------------------------------------------------------
     Abas e renderização
     --------------------------------------------------------- */
  /* ---------------------------------------------------------
     Páginas finais do Typeform (ver cloudflare/finais.js)

     Visitantes contados por navegador (como na LP). Os cliques valem uma
     vez por visitante e página: quem tocou duas vezes no botão conta um.
     --------------------------------------------------------- */
  const PAGINAS_FINAIS = [
    { chave: "a/antecipar", nome: "A · Quer antecipar", nota: "0 a 78 pontos" },
    { chave: "a/esperar", nome: "A · Prefere esperar", nota: "0 a 78 pontos" },
    { chave: "b/antecipar", nome: "B · Quer antecipar", nota: "79 a 200 pontos" },
    { chave: "b/esperar", nome: "B · Prefere esperar", nota: "79 a 200 pontos" },
  ];
  const NOME_PAGINA_FINAL = Object.fromEntries(PAGINAS_FINAIS.map((p) => [p.chave, p.nome]));

  // lead_origin das LPs (CONFIG.identidade em assets/js/main.js de cada uma)
  function origemFinal(pv) {
    const o = String(pv?.lead_origin || "").toLowerCase();
    if (o.endsWith("_frios")) return "LP Institucional";
    if (o.endsWith("_verde")) return "Esquenta Black (verde)";
    if (o.endsWith("_laranja")) return "Esquenta Black (laranja)";
    if (o) return o;
    if (pv?.visitante && visitantesComCadastro().has(pv.visitante)) return "LP Institucional (pelo navegador)";
    return "(sem origem)";
  }

  let cacheCadastrados = { n: -1, conjunto: new Set() };
  function visitantesComCadastro() {
    if (cacheCadastrados.n !== dados.cadastros.length) {
      cacheCadastrados = { n: dados.cadastros.length, conjunto: distintos(dados.cadastros, "visitante") };
    }
    return cacheCadastrados.conjunto;
  }

  // resumo de uma lista de linhas de finais_pf
  function resumoFinais(lista) {
    const pvs = lista.filter((e) => e.evento === "page_view");
    const visitantes = distintos(pvs, "visitante");
    const quem = (evento) => distintos(lista.filter((e) => e.evento === evento), "visitante");
    const grupo = quem("clique_grupo");
    const especialista = quem("clique_especialista");
    const qr = quem("qr_grupo");
    // tempo por sessão: o maior envio de engajamento de cada uma
    const tempos = new Map();
    for (const e of lista) {
      if (e.evento === "engajamento" && e.sessao) tempos.set(e.sessao, Math.max(tempos.get(e.sessao) || 0, e.valor || 0));
    }
    return {
      acessos: pvs.length,
      visitantes: visitantes.size,
      grupo: grupo.size,
      especialista: especialista.size,
      qr: qr.size,
      taxa: visitantes.size ? grupo.size / visitantes.size : NaN,
      taxaEspecialista: visitantes.size ? especialista.size / visitantes.size : NaN,
      tempoMediano: tempos.size ? mediana([...tempos.values()]) : NaN,
    };
  }

  // Links dos botões de cada página (cloudflare/finais.js, enviados pelo
  // Worker em /admin/api/sync). Em texto, e não como link: abrir daqui
  // contaria um clique no encurtador, e é por ele que o tráfego pago é
  // otimizado. O botão "Copiar" põe o endereço na área de transferência.
  // um botão por página desde 12/11/2026 (saiu o "Falar com especialista")
  const NOME_LINK = { grupo: "Grupo" };
  const LINKS_ESPERADOS = () => ["grupo"];
  function linksDaPagina(pagina) {
    const links = dados.linksFinais[pagina] || {};
    return el("div", { class: "final-links" },
      el("p", { class: "final-links__titulo" }, "Links dos botões"),
      LINKS_ESPERADOS(pagina).map((tipo) => {
        const endereco = links[tipo] || "";
        return el("div", { class: "final-link" },
          el("span", { class: "final-link__tipo" }, NOME_LINK[tipo]),
          endereco
            ? el("code", { class: "final-link__url", title: endereco }, endereco)
            : el("span", { class: "final-link__vazio" }, "não configurado"),
          endereco
            ? el("button", { type: "button", class: "final-link__copiar", dataset: { copiar: endereco }, "aria-label": `Copiar o link ${NOME_LINK[tipo].toLowerCase()}` }, "Copiar")
            : null);
      }));
  }
  document.addEventListener("click", async (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-copiar]") : null;
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copiar);
      b.textContent = "Copiado";
      b.classList.add("is-copiado");
      setTimeout(() => { b.textContent = "Copiar"; b.classList.remove("is-copiado"); }, 1600);
    } catch { /* sem permissão de área de transferência: o endereço continua à vista */ }
  });

  // anel da taxa de entrada no grupo: arco proporcional e o número no meio
  // (o arco "enche" na entrada, ver .anel-taxa em admin.css; o .medidor é
  // outro componente, o da aba Gravações)
  function anelTaxa(taxa, animar) {
    const raio = 30;
    const circunferencia = 2 * Math.PI * raio;
    const fracao = Number.isFinite(taxa) ? Math.max(0, Math.min(1, taxa)) : 0;
    const svg = svgEl("svg", { viewBox: "0 0 76 76", class: "anel-taxa__arco", "aria-hidden": "true" });
    const arco = svgEl("circle", {
      cx: 38, cy: 38, r: raio, class: "anel-taxa__valor", stroke: CORES.verde,
      "stroke-dasharray": circunferencia.toFixed(2), "stroke-dashoffset": (circunferencia * (1 - fracao)).toFixed(2),
    });
    arco.style.setProperty("--circunferencia", circunferencia.toFixed(2));
    svg.append(svgEl("circle", { cx: 38, cy: 38, r: raio, class: "anel-taxa__trilho" }), arco);
    return el("div", {
      class: `anel-taxa${animar && !movimentoReduzido ? " anima" : ""}`,
      role: "img",
      "aria-label": `${fmtPct(taxa)} dos visitantes entraram no grupo`,
    }, svg, el("span", { class: "anel-taxa__numero" }, Number.isFinite(taxa) ? fmtPct(taxa, 0) : "—"));
  }

  // séries do gráfico de uma página: visitantes e quem clicou no grupo
  // (pessoas distintas por hora ou dia), ou a taxa entre os dois
  function seriesDaPagina(lista, grade) {
    const visitantes = distintosPorBalde(grade, lista.filter((e) => e.evento === "page_view"), "visitante");
    const grupo = distintosPorBalde(grade, lista.filter((e) => e.evento === "clique_grupo"), "visitante");
    if (prefs.finaisMetrica === "taxa") {
      return {
        series: [{ nome: "Taxa de entrada no grupo", cor: CORES.verde, valores: visitantes.map((v, i) => (v ? Math.min(1, grupo[i] / v) : 0)) }],
        formato: (v) => fmtPct(v),
        inteiro: false,
      };
    }
    return {
      series: [
        { nome: "Visitantes", cor: CORES.visitantes, valores: visitantes },
        { nome: "Clicaram no grupo", cor: CORES.verde, valores: grupo },
      ],
      formato: fmtNum,
      inteiro: true,
    };
  }

  /* ---------------------------------------------------------
     Comparativos das páginas finais

     A base sai do período escolhido, sempre do mesmo tamanho e, com o dia
     em andamento, no mesmo trecho do dia:
       hoje            -> ontem até a mesma hora
       ontem           -> anteontem
       24h, 7d, 30d    -> as 24 h, 7 ou 30 dias anteriores
       personalizado   -> o período anterior, de mesmo tamanho
       toda a campanha -> últimas 24 h × 24 h anteriores (não há "antes")
     Diferença de taxa: teste de duas proporções (zDuas, o mesmo da aba
     Campanhas); |z| ≥ 1,96 é diferença confiável (95%). Com menos de 20
     visitantes em algum lado, o painel diz que ainda é pouco volume.
     --------------------------------------------------------- */
  const fmtHoraMinuto = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" });
  const MINIMO_CONFIANCA = 20;

  // "vs 24 h anteriores", sem o recorte (para frases que já dizem qual é)
  const contraDe = (j) => j.rotulo.replace(/^nas últimas 24 h /, "");
  // "24 h anteriores", "ontem até 16:12"... (o nome da base, sem o "vs")
  const nomeDaBase = (j) => contraDe(j).replace(/^vs /, "");

  function janelasComparacao(f) {
    const agora = relogio();
    const hoje = inicioDia(agora);
    switch (prefs.periodo) {
      case "hoje":
        return { atual: [hoje, agora + 1], base: [hoje - DIA, agora - DIA + 1], rotulo: `vs ontem até ${fmtHoraMinuto.format(agora)}` };
      case "ontem":
        return { atual: [hoje - DIA, hoje], base: [hoje - 2 * DIA, hoje - DIA], rotulo: "vs anteontem" };
      case "tudo":
        return { atual: [agora - DIA, agora + 1], base: [agora - 2 * DIA, agora - DIA + 1], rotulo: "nas últimas 24 h vs 24 h anteriores", recorte: "Últimas 24 h" };
      default: {
        const tamanho = f.fim - f.inicio;
        const rotulos = { "24h": "vs 24 h anteriores", "7d": "vs 7 dias anteriores", "30d": "vs 30 dias anteriores" };
        return { atual: [f.inicio, f.fim], base: [f.inicio - tamanho, f.inicio], rotulo: rotulos[prefs.periodo] || "vs período anterior, de mesmo tamanho" };
      }
    }
  }

  // linhas de finais_pf de um intervalo, com os mesmos filtros do painel
  function fatiarFinais(inicio, fim) {
    return dados.finais.filter((e) => e.ts >= inicio && e.ts < fim
      && passaDims(e.evento === "page_view" ? e : dados.sessoesFinais.get(e.sessao)));
  }

  // confiança da diferença entre duas proporções (x1 de n1 contra x2 de n2)
  function confiancaProporcao(x1, n1, x2, n2) {
    if (n1 < MINIMO_CONFIANCA || n2 < MINIMO_CONFIANCA) return { classe: "pouco", texto: "pouco volume para concluir" };
    return Math.abs(zDuas(x1, n1, x2, n2)) >= 1.96
      ? { classe: "confiavel", texto: "diferença confiável" }
      : { classe: "acaso", texto: "pode ser acaso" };
  }
  const confiancaTaxa = (a, b) => confiancaProporcao(a.grupo, a.visitantes, b.grupo, b.visitantes);

  // lista de destaques (frases): [{ tipo: sobe | desce | alerta | info, partes }]
  function renderListaDestaques(seletor, itens) {
    $(seletor).replaceChildren(...(itens.length
      ? itens.map((i, n) => el("li", { class: `destaque destaque--${i.tipo}`, style: { "--i": String(n) } },
        el("span", { class: "destaque__marca", "aria-hidden": "true" }, { sobe: "▲", desce: "▼", alerta: "!", info: "•" }[i.tipo]),
        el("p", {}, ...i.partes)))
      : [el("li", { class: "vazio" }, "Ainda sem dados suficientes para comparar.")]));
  }

  // "Cadastros cresceram 12% vs ontem até 16:12 (40 → 45)."
  function fraseVariacao(itens, nome, a, b, rotulo) {
    const v = variacaoDe(a, b);
    if (!v) {
      if (a && !b) itens.push({ tipo: "info", partes: [`${nome}: `, el("strong", {}, fmtNum(a)), `, sem base para comparar (${rotulo}).`] });
      return;
    }
    if (Math.abs(v.d) < 1e-9) { itens.push({ tipo: "info", partes: [`${nome}: estável ${rotulo} (${fmtNum(a)}).`] }); return; }
    itens.push({
      tipo: v.sobe ? "sobe" : "desce",
      partes: [`${nome} ${v.sobe ? "cresceram" : "caíram"} `, el("strong", {}, v.texto), ` ${rotulo} (${fmtNum(b)} → ${fmtNum(a)}).`],
    });
  }

  // só acessos e cadastros de um intervalo (sem a lista de eventos, que é
  // grande): para o ritmo de hoje, que roda a cada atualização
  function fatiarLeve(inicio, fim) {
    const dentro = (ts) => ts >= inicio && ts < fim;
    return {
      pvs: dados.pageviews.filter((p) => dentro(p.ts) && passaDims(p)),
      cadastros: dados.cadastros.filter((c) => dentro(c.ts) && passaDims(c)),
    };
  }

  // ritmo de hoje contra ontem no mesmo horário, com a projeção do dia
  function fraseRitmo(itens, nome, contar) {
    const agora = relogio();
    const hoje = inicioDia(agora);
    const nHoje = contar(hoje, agora + 1);
    const nOntemAte = contar(hoje - DIA, agora - DIA + 1);
    const nOntem = contar(hoje - DIA, hoje);
    if (nOntemAte < 5) return;
    const v = variacaoDe(nHoje, nOntemAte);
    const projecao = Math.round(nHoje * (nOntem / nOntemAte));
    if (prefs.periodo === "hoje") {
      itens.push({ tipo: "info", partes: [`No ritmo de ontem, hoje fecha com cerca de `, el("strong", {}, `${fmtNum(projecao)} ${nome}`), ` (ontem: ${fmtNum(nOntem)}).`] });
      return;
    }
    itens.push({
      tipo: v && v.sobe ? "sobe" : v && v.d < 0 ? "desce" : "info",
      partes: [`Hoje até ${fmtHoraMinuto.format(agora)}: `, el("strong", {}, `${fmtNum(nHoje)} ${nome}`),
        v && Math.abs(v.d) >= 1e-9 ? `, ${v.texto} ${v.sobe ? "acima" : "abaixo"} de ontem no mesmo horário` : ", igual a ontem no mesmo horário",
        ". No ritmo de ontem, o dia fecha com cerca de ", el("strong", {}, fmtNum(projecao)), ` (ontem: ${fmtNum(nOntem)}).`],
    });
  }

  // contagem somada balde a balde (cadastros), com a base deslocada
  function acumuladoContagem(grade, lista, deslocamento = 0) {
    const v = contarPorBalde(grade, lista, deslocamento);
    for (let i = 1; i < v.length; i++) v[i] += v[i - 1];
    return v;
  }

  // comparação da Visão geral: o recorte atual (o período inteiro, ou as
  // últimas 24 h em toda a campanha) e a base do mesmo tamanho
  function comparacaoGeral(f) {
    const j = janelasComparacao(f);
    const recortado = prefs.periodo === "tudo";
    return {
      j,
      rotulo: j.rotulo,
      atual: recortado ? fatiar(...j.atual) : f,
      base: fatiar(...j.base),
      deslocamento: j.atual[0] - j.base[0],
      // o gráfico de evolução só sobrepõe a base quando ela cobre o mesmo recorte do gráfico
      mesmoRecorte: !recortado,
    };
  }

  function renderComparativosGeral(f, comp, animar) {
    const ra = resumo(comp.atual);
    const a = resumo(comp.base);
    const fmtJanela = ([ini, fim]) => `${fmtDataCurta.format(ini).replace(",", "")} a ${fmtDataCurta.format(Math.min(fim, relogio()) - 1).replace(",", "")}`;
    $("#geral-comparacao-base").replaceChildren(
      el("strong", {}, "Comparativos: "), `${fmtJanela(comp.j.atual)} contra ${fmtJanela(comp.j.base)}`,
      prefs.periodo === "tudo" ? " (em toda a campanha, a comparação usa as últimas 24 h)" : "", ".");

    const itens = [];
    fraseVariacao(itens, "Cadastros", ra.cadastros, a.cadastros, comp.rotulo);
    fraseVariacao(itens, "Visitantes", ra.visitantes, a.visitantes, comp.rotulo);
    const vc = variacaoDe(ra.conversao, a.conversao, "pontos");
    if (vc && Math.abs(vc.d) >= 1e-9) {
      const c = confiancaProporcao(ra.cadastros, ra.visitantes, a.cadastros, a.visitantes);
      itens.push({
        tipo: c.classe === "confiavel" ? (vc.sobe ? "sobe" : "alerta") : "info",
        partes: [`Conversão${comp.j.recorte ? " nas últimas 24 h" : ""}: `, el("strong", {}, fmtPct(ra.conversao)),
          ` (${vc.sobe ? "+" : "−"}${vc.texto} ${comp.j.recorte ? contraDe(comp.j) : comp.rotulo}); ${c.texto}.`],
      });
    }
    fraseRitmo(itens, "cadastros", (ini, fim) => fatiarLeve(ini, fim).cadastros.length);

    // origem (utm_source) com a melhor conversão no período, com volume mínimo
    const porOrigem = new Map();
    for (const p of f.pvs) {
      const o = p.utm_source || "(sem UTM)";
      if (!porOrigem.has(o)) porOrigem.set(o, { visitantes: new Set(), cadastros: 0 });
      if (p.visitante) porOrigem.get(o).visitantes.add(p.visitante);
    }
    for (const c of f.cadastros) {
      const o = c.utm_source || "(sem UTM)";
      if (!porOrigem.has(o)) porOrigem.set(o, { visitantes: new Set(), cadastros: 0 });
      porOrigem.get(o).cadastros++;
    }
    const origens = [...porOrigem].map(([nome, o]) => ({ nome, visitantes: o.visitantes.size, cadastros: o.cadastros, taxa: razao(o.cadastros, o.visitantes.size) }))
      .filter((o) => o.visitantes >= 30 && Number.isFinite(o.taxa));
    if (origens.length >= 2) {
      origens.sort((x, y) => y.taxa - x.taxa);
      const melhor = origens[0];
      const resto = origens.slice(1).reduce((s, o) => ({ cadastros: s.cadastros + o.cadastros, visitantes: s.visitantes + o.visitantes }), { cadastros: 0, visitantes: 0 });
      const c = confiancaProporcao(melhor.cadastros, melhor.visitantes, resto.cadastros, resto.visitantes);
      itens.push({
        tipo: "info",
        partes: ["Melhor conversão por origem: ", el("strong", {}, `${melhor.nome} (${fmtPct(melhor.taxa)})`),
          `, ${fmtNum(melhor.cadastros)} cadastros de ${fmtNum(melhor.visitantes)} visitantes; contra as outras origens, ${c.texto}.`],
      });
    }

    // origem que mais cresceu em cadastros no recorte
    const contarPorOrigem = (lista) => {
      const m = new Map();
      for (const c of lista) m.set(c.utm_source || "(sem UTM)", (m.get(c.utm_source || "(sem UTM)") || 0) + 1);
      return m;
    };
    const cadAt = contarPorOrigem(comp.atual.cadastros);
    const cadBa = contarPorOrigem(comp.base.cadastros);
    const cresceu = [...cadAt].map(([nome, n]) => ({ nome, n, b: cadBa.get(nome) || 0 }))
      .filter((o) => o.b >= 5).map((o) => ({ ...o, v: variacaoDe(o.n, o.b) }))
      .filter((o) => o.v && o.v.d > 0).sort((x, y) => y.v.d - x.v.d)[0];
    if (cresceu) {
      itens.push({ tipo: "sobe", partes: ["Origem que mais cresceu: ", el("strong", {}, cresceu.nome), `, +${cresceu.v.texto} em cadastros ${comp.rotulo} (${fmtNum(cresceu.b)} → ${fmtNum(cresceu.n)}).`] });
    }

    // horário com mais cadastros no período, quando ele se destaca
    if (f.cadastros.length >= 30) {
      const porHora = new Array(24).fill(0);
      for (const c of f.cadastros) porHora[partes(c.ts).hora]++;
      const pico = porHora.indexOf(Math.max(...porHora));
      if (porHora[pico] / f.cadastros.length >= 1.5 / 24) {
        itens.push({ tipo: "info", partes: ["Horário com mais cadastros: ", el("strong", {}, `${pico}h–${(pico + 1) % 24}h`), ` (${fmtPct(porHora[pico] / f.cadastros.length, 0)} dos cadastros do período).`] });
      }
    }
    renderListaDestaques("#geral-destaques", itens);

    // crescimento acumulado dos cadastros, com a base por cima
    const grade = gradeTempo(comp.j.atual[0], comp.j.atual[1], escalaDe(comp.j.atual[0], comp.j.atual[1]));
    const series = [
      { nome: "Cadastros", cor: CORES.cadastros, valores: acumuladoContagem(grade, comp.atual.cadastros) },
      { nome: `Cadastros na base (${nomeDaBase(comp.j)})`, cor: CORES.anterior, valores: acumuladoContagem(grade, comp.base.cadastros, comp.deslocamento) },
    ];
    texto("#geral-crescimento-sub", `${comp.j.recorte ? `${comp.j.recorte}: ` : ""}cadastros somados ${grade.escala === DIA ? "dia a dia" : "hora a hora"}; a linha cinza é a base (${nomeDaBase(comp.j)})`);
    grafico($("#g-geral-crescimento"), { pontos: grade.pontos, series, tipo: "area", formato: fmtNum, inteiro: true, animar });
    $("#legenda-geral-crescimento").replaceChildren(...series.map((s) => el("span", { class: "legenda__item" },
      el("span", { class: "legenda__linha", style: { background: s.cor } }), s.nome)));
  }

  // variação entre atual e base: { sobe, texto } ou null (sem base)
  function variacaoDe(atual, base, modo = "relativo") {
    if (!Number.isFinite(atual) || !Number.isFinite(base)) return null;
    if (modo === "pontos") {
      const d = atual - base;
      return { d, sobe: d > 0, texto: `${Math.abs(d * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} p.p.` };
    }
    if (!base) return null;
    const d = (atual - base) / base;
    return { d, sobe: d > 0, texto: fmtPct(Math.abs(d), 0) };
  }
  const seta = (v) => el("span", { class: `seta ${v.sobe ? "seta--sobe" : "seta--desce"}`, "aria-label": v.sobe ? "aumento de" : "queda de" }, v.sobe ? "▲ " : "▼ ");

  function deltaFinal(seletor, atual, base, rotulo, { modo = "relativo", confianca = null } = {}) {
    const alvo = $(seletor);
    const v = variacaoDe(atual, base, modo);
    if (!v) { alvo.textContent = atual ? `sem base ${rotulo}` : `sem dados ${rotulo}`; return; }
    if (Math.abs(v.d) < 1e-9) { alvo.textContent = `sem variação ${rotulo}`; return; }
    const filhos = [seta(v), `${v.texto} ${rotulo}`];
    if (confianca) filhos.push(el("span", { class: `confianca confianca--${confianca.classe}` }, confianca.texto));
    alvo.replaceChildren(...filhos);
  }

  // pessoas novas no recorte (primeira vez que aparecem) e quem clicou no
  // grupo, somadas balde a balde; "deslocamento" põe a base sobre a grade atual
  function acumulado(grade, lista, evento, deslocamento = 0) {
    const v = new Array(grade.n).fill(0);
    const vistos = new Set();
    for (const e of [...lista].sort((a, b) => a.ts - b.ts)) {
      if (e.evento !== evento || !e.visitante || vistos.has(e.visitante)) continue;
      vistos.add(e.visitante);
      const i = Math.floor((e.ts + deslocamento - grade.primeiro) / grade.escala);
      if (i >= 0 && i < grade.n) v[i]++;
    }
    for (let i = 1; i < v.length; i++) v[i] += v[i - 1];
    return v;
  }

  // frases dos destaques: [{ tipo: sobe | desce | alerta | info, partes }]
  function destaquesFinais(f, at, ba, rotulo, resumosAt, resumosBa, resumosPeriodo, recorte, contra) {
    const itens = [];
    fraseVariacao(itens, "Visitantes", at.visitantes, ba.visitantes, rotulo);
    fraseVariacao(itens, "Cliques no grupo", at.grupo, ba.grupo, rotulo);

    // taxa geral, com a confiança da diferença
    const vt = variacaoDe(at.taxa, ba.taxa, "pontos");
    if (vt && Math.abs(vt.d) >= 1e-9) {
      const c = confiancaTaxa(at, ba);
      itens.push({
        tipo: c.classe === "confiavel" ? (vt.sobe ? "sobe" : "alerta") : "info",
        partes: [`Taxa de entrada no grupo${recorte ? ` ${recorte.toLowerCase().replace(/^últimas/, "nas últimas")}` : ""}: `, el("strong", {}, fmtPct(at.taxa)),
          ` (${vt.sobe ? "+" : "−"}${vt.texto} ${recorte ? contra : rotulo}); ${c.texto}.`],
      });
    }

    fraseRitmo(itens, "visitantes", (inicio, fim) => resumoFinais(fatiarFinais(inicio, fim)).visitantes);

    // maior e menor taxa entre as páginas, no período escolhido
    const comVolume = PAGINAS_FINAIS.map((p) => ({ p, r: resumosPeriodo.get(p.chave) })).filter(({ r }) => r.visitantes >= 1 && Number.isFinite(r.taxa));
    if (comVolume.length >= 2) {
      comVolume.sort((a, b) => b.r.taxa - a.r.taxa);
      const melhor = comVolume[0];
      const pior = comVolume[comVolume.length - 1];
      if (melhor.r.taxa > pior.r.taxa) {
        const c = confiancaTaxa(melhor.r, pior.r);
        const precisa = c.classe === "confiavel" ? "" : (() => {
          const n = amostraNecessaria(melhor.r.taxa, pior.r.taxa);
          return Number.isFinite(n) ? ` Para confirmar, cerca de ${fmtNum(n)} visitantes em cada uma.` : "";
        })();
        itens.push({
          tipo: "info",
          partes: ["Maior taxa: ", el("strong", {}, `${melhor.p.nome} (${fmtPct(melhor.r.taxa, 0)})`), "; menor: ",
            el("strong", {}, `${pior.p.nome} (${fmtPct(pior.r.taxa, 0)})`), `. ${capitalizar(c.texto)}.${precisa}`],
        });
      }
    }

    // página que mais cresceu em visitantes, e quedas confiáveis de taxa
    const cresc = PAGINAS_FINAIS.map((p) => {
      const a = resumosAt.get(p.chave);
      const b = resumosBa.get(p.chave);
      return { p, a, b, v: b.visitantes >= 5 ? variacaoDe(a.visitantes, b.visitantes) : null };
    });
    const maior = cresc.filter((c) => c.v && c.v.d > 0).sort((x, y) => y.v.d - x.v.d)[0];
    if (maior) {
      itens.push({ tipo: "sobe", partes: ["Maior crescimento: ", el("strong", {}, maior.p.nome), `, +${maior.v.texto} em visitantes ${rotulo} (${fmtNum(maior.b.visitantes)} → ${fmtNum(maior.a.visitantes)}).`] });
    }
    for (const c of cresc) {
      const v = variacaoDe(c.a.taxa, c.b.taxa, "pontos");
      if (v && v.d < 0 && confiancaTaxa(c.a, c.b).classe === "confiavel") {
        itens.push({ tipo: "alerta", partes: [el("strong", {}, c.p.nome), `: a taxa de entrada caiu ${v.texto} ${rotulo} (diferença confiável).`] });
      }
    }

    // horário com mais visitantes no período escolhido
    const pvs = f.finais.filter((e) => e.evento === "page_view");
    if (pvs.length >= 30) {
      const porHora = new Array(24).fill(0);
      for (const e of pvs) porHora[partes(e.ts).hora]++;
      const pico = porHora.indexOf(Math.max(...porHora));
      // só quando o pico se destaca: pelo menos 1,5 vez a média de uma hora
      if (porHora[pico] / pvs.length >= 1.5 / 24) itens.push({ tipo: "info", partes: ["Horário de pico: ", el("strong", {}, `${pico}h–${(pico + 1) % 24}h`), ` (${fmtPct(porHora[pico] / pvs.length, 0)} dos acessos do período).`] });
    }
    return itens;
  }

  function renderComparativosFinais(f, animar) {
    const j = janelasComparacao(f);
    const linhasAt = fatiarFinais(...j.atual);
    const linhasBa = fatiarFinais(...j.base);
    const at = resumoFinais(linhasAt);
    const ba = resumoFinais(linhasBa);
    const porPagina = (linhas) => new Map(PAGINAS_FINAIS.map((p) => [p.chave, resumoFinais(linhas.filter((e) => e.pagina === p.chave))]));
    const resumosAt = porPagina(linhasAt);
    const resumosBa = porPagina(linhasBa);

    const fmtJanela = ([ini, fim]) => `${fmtDataCurta.format(ini).replace(",", "")} a ${fmtDataCurta.format(Math.min(fim, relogio()) - 1).replace(",", "")}`;
    $("#finais-comparacao-base").replaceChildren(
      el("strong", {}, "Comparativos: "), `${fmtJanela(j.atual)} contra ${fmtJanela(j.base)}`,
      prefs.periodo === "tudo" ? " (em toda a campanha, a comparação usa as últimas 24 h)" : "",
      ". Troque o período acima para comparar outro recorte.");

    deltaFinal("#fi-visitantes-delta", at.visitantes, ba.visitantes, j.rotulo);
    deltaFinal("#fi-grupo-delta", at.grupo, ba.grupo, j.rotulo);
    deltaFinal("#fi-taxa-delta", at.taxa, ba.taxa, j.rotulo, { modo: "pontos", confianca: confiancaTaxa(at, ba) });
    deltaFinal("#fi-tempo-delta", at.tempoMediano, ba.tempoMediano, j.rotulo);

    // destaques
    const resumosPeriodo = new Map(PAGINAS_FINAIS.map((p) => [p.chave, resumoFinais(f.finais.filter((e) => e.pagina === p.chave))]));
    const itens = destaquesFinais(f, at, ba, j.rotulo, resumosAt, resumosBa, resumosPeriodo, j.recorte, contraDe(j));
    renderListaDestaques("#finais-destaques", itens);

    // crescimento acumulado: o recorte atual com a base por cima
    const grade = gradeTempo(j.atual[0], j.atual[1], escalaDe(j.atual[0], j.atual[1]));
    const deslocamento = j.atual[0] - j.base[0];
    const series = [
      { nome: "Visitantes", cor: CORES.visitantes, valores: acumulado(grade, linhasAt, "page_view") },
      { nome: `Visitantes na base (${nomeDaBase(j)})`, cor: CORES.anterior, valores: acumulado(grade, linhasBa, "page_view", deslocamento) },
      { nome: "Clicaram no grupo", cor: CORES.verde, valores: acumulado(grade, linhasAt, "clique_grupo") },
    ];
    texto("#finais-crescimento-sub", `${j.recorte ? `${j.recorte}: ` : ""}somados ${grade.escala === DIA ? "dia a dia" : "hora a hora"}; a linha cinza é a base (${nomeDaBase(j)})`);
    grafico($("#g-finais-crescimento"), { pontos: grade.pontos, series, tipo: "area", formato: fmtNum, inteiro: true, animar });
    $("#legenda-finais-crescimento").replaceChildren(...series.map((s) => el("span", { class: "legenda__item" },
      el("span", { class: "legenda__linha", style: { background: s.cor } }), s.nome)));

    return { j, resumosAt, resumosBa };
  }

  // comparativo de uma página, para o cartão dela
  function comparativoDaPagina(chave, comp) {
    const a = comp.resumosAt.get(chave);
    const b = comp.resumosBa.get(chave);
    const vv = variacaoDe(a.visitantes, b.visitantes);
    const vt = variacaoDe(a.taxa, b.taxa, "pontos");
    const item = (nome, v) => el("span", { class: "comparativo__item" }, `${nome} `,
      v && Math.abs(v.d) >= 1e-9 ? [seta(v), v.texto] : el("span", { class: "comparativo__sem" }, v ? "estável" : "sem base"));
    return el("p", { class: "final-cartao__comparativo" },
      el("span", { class: "comparativo__rotulo" }, (() => {
        const contra = contraDe(comp.j).replace(/^vs /, "contra ");
        return comp.j.recorte ? `${comp.j.recorte} ${contra}:` : `${capitalizar(contra)}:`;
      })()),
      item("Visitantes", vv),
      item("Taxa", vt),
      vt && Math.abs(vt.d) >= 1e-9 ? el("span", { class: `confianca confianca--${confiancaTaxa(a, b).classe}` }, confiancaTaxa(a, b).texto) : null);
  }

  function renderFinais(f, { animar, aoVivo }) {
    const total = resumoFinais(f.finais);
    contar("#fi-visitantes", total.visitantes, fmtNum, aoVivo);
    texto("#fi-visitantes-nota", `${plural(total.acessos, "acesso", "acessos")} nas 4 páginas finais`);
    contar("#fi-grupo", total.grupo, fmtNum, aoVivo);
    contar("#fi-taxa", total.taxa, (v) => fmtPct(v), aoVivo);
    contar("#fi-tempo", total.tempoMediano, fmtDuracao, aoVivo);
    const comp = renderComparativosFinais(f, animar);
    if (!["volume", "taxa"].includes(prefs.finaisMetrica)) prefs.finaisMetrica = "volume";
    $$("#finais-metricas button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.finaisMetrica === prefs.finaisMetrica)));
    $$("#finais-granularidades button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.granularidade === prefs.granularidade)));

    const porPagina = new Map(PAGINAS_FINAIS.map((p) => [p.chave, f.finais.filter((e) => e.pagina === p.chave)]));
    const resumos = new Map([...porPagina].map(([chave, lista]) => [chave, resumoFinais(lista)]));

    // as porcentagens lado a lado (barras na escala de 0 a 100%)
    const vazioFinais = "Nenhum acesso às páginas finais no período.";
    listaBarras($("#finais-taxas"), PAGINAS_FINAIS.map((p) => {
      const r = resumos.get(p.chave);
      return { nome: p.nome, valor: Number.isFinite(r.taxa) ? r.taxa : 0, rotulo: fmtPct(r.taxa), nota: `${fmtNum(r.grupo)} de ${fmtNum(r.visitantes)}`, cor: CORES.verde };
    }), { animar, vazio: vazioFinais });
    listaBarras($("#finais-distribuicao"), PAGINAS_FINAIS.map((p) => {
      const r = resumos.get(p.chave);
      const parte = total.visitantes ? r.visitantes / total.visitantes : 0;
      return { nome: p.nome, valor: parte, rotulo: fmtPct(parte), nota: plural(r.visitantes, "visitante", "visitantes"), cor: CORES.visitantes };
    }), { animar, vazio: vazioFinais });

    // eixo do tempo dos gráficos: do primeiro acesso às páginas finais (não do
    // começo da LP, semanas antes) até o fim do período
    let primeiroFinal = Infinity;
    for (const e of dados.finais) if (e.ts < primeiroFinal) primeiroFinal = e.ts;
    const inicioGrafico = Number.isFinite(primeiroFinal) ? Math.max(f.inicio, inicioDia(primeiroFinal)) : f.inicio;
    const grade = gradeTempo(inicioGrafico, f.fim, escalaDe(inicioGrafico, f.fim));

    // os gráficos antigos saem do observador de tamanho antes de o cartão ser refeito
    $$("#finais-paginas .grafico").forEach((g) => { configuracoes.delete(g); observadorTamanho.unobserve(g); });

    // um cartão por página, na ordem A/B × antecipar/esperar
    const graficos = [];
    $("#finais-paginas").replaceChildren(...PAGINAS_FINAIS.map((p, i) => {
      const r = resumos.get(p.chave);
      const parte = total.visitantes ? r.visitantes / total.visitantes : NaN;
      const linha = (rotulo, valor, extra) => el("div", { class: "final-cartao__linha" },
        el("dt", {}, rotulo), el("dd", {}, valor, extra ? el("small", {}, extra) : null));
      const alvoGrafico = el("div", { class: "grafico grafico--final" });
      const { series, formato, inteiro } = seriesDaPagina(porPagina.get(p.chave), grade);
      graficos.push([alvoGrafico, series, formato, inteiro]);
      return el("article", { class: `cartao final-cartao${animar && !movimentoReduzido ? " is-surgindo" : ""}`, style: { "--i": String(i) } },
        el("header", { class: "final-cartao__topo" },
          el("div", {},
            el("h3", {}, p.nome),
            el("p", { class: "final-cartao__nota" }, p.nota, " · ", el("code", { class: "final-cartao__endereco" }, `/final/${p.chave}`))),
          // modo de visualização (?teste=1): não mede o acesso, não carrega o
          // GTM e os botões mostram o destino em vez de abrir (ver final.js)
          el("a", {
            class: "final-cartao__abrir", href: `/final/${p.chave}?teste=1`, target: "_blank", rel: "noopener",
            title: "Abre em modo de visualização: o acesso não é medido e os botões não abrem o link",
          }, "Abrir página", el("span", { "aria-hidden": "true" }, " ↗"))),
        el("div", { class: "final-cartao__resumo" },
          anelTaxa(r.taxa, animar),
          el("div", { class: "final-cartao__frases" },
            el("p", {}, el("strong", {}, fmtNum(r.grupo)), ` de ${plural(r.visitantes, "visitante entrou", "visitantes entraram")} no grupo`),
            el("p", {}, el("strong", {}, fmtPct(parte)), " dos visitantes do período vieram para esta página"),
            el("p", {}, "Tempo mediano: ", el("strong", {}, Number.isFinite(r.tempoMediano) ? fmtDuracao(r.tempoMediano) : "—")))),
        comparativoDaPagina(p.chave, comp),
        alvoGrafico,
        el("div", { class: "legenda" }, series.map((s) => el("span", { class: "legenda__item" },
          el("span", { class: "legenda__linha", style: { background: s.cor } }), s.nome))),
        el("dl", { class: "final-cartao__dados" },
          linha("Visitantes", fmtNum(r.visitantes), r.acessos !== r.visitantes ? `${fmtNum(r.acessos)} acessos` : null),
          linha("Clicaram no grupo", fmtNum(r.grupo), Number.isFinite(r.taxa) ? fmtPct(r.taxa) : null),
          linha("Abriram o QR Code", fmtNum(r.qr), "só no computador")),
        linksDaPagina(p.chave));
    }));
    // desenhados depois de entrarem na página: o gráfico se mede pela largura do cartão
    for (const [alvo, series, formato, inteiro] of graficos) {
      grafico(alvo, { pontos: grade.pontos, series, tipo: "area", formato, inteiro, animar });
    }

    // por origem do lead
    const porOrigem = new Map();
    const origemDaSessao = new Map();
    for (const e of f.finais) {
      const pv = e.evento === "page_view" ? e : dados.sessoesFinais.get(e.sessao);
      const origem = origemFinal(pv);
      if (e.sessao) origemDaSessao.set(e.sessao, origem);
      if (!porOrigem.has(origem)) porOrigem.set(origem, []);
      porOrigem.get(origem).push(e);
    }
    const linhasOrigem = [...porOrigem].map(([origem, lista]) => ({ origem, ...resumoFinais(lista) }))
      .filter((r) => r.visitantes)
      .sort((a, b) => b.visitantes - a.visitantes);
    const corpoOrigens = $("#tabela-finais-origens tbody");
    corpoOrigens.replaceChildren(...(linhasOrigem.length ? linhasOrigem.map((r) => el("tr", {},
      el("td", { class: "forte" }, r.origem),
      el("td", { class: "num" }, fmtNum(r.visitantes)),
      el("td", { class: "num" }, fmtNum(r.grupo)),
      el("td", { class: "num" }, fmtPct(r.taxa))))
      : [el("tr", {}, el("td", { class: "vazio", colspan: 4 }, "Nenhum acesso às páginas finais no período."))]));

    // acessos recentes: cada page_view com o que aconteceu na mesma sessão
    const porSessao = new Map();
    for (const e of f.finais) {
      if (e.evento === "page_view" || !e.sessao) continue;
      if (!porSessao.has(e.sessao)) porSessao.set(e.sessao, { grupo: false, especialista: false, tempo: 0 });
      const s = porSessao.get(e.sessao);
      if (e.evento === "clique_grupo") s.grupo = true;
      if (e.evento === "clique_especialista") s.especialista = true;
      if (e.evento === "engajamento") s.tempo = Math.max(s.tempo, e.valor || 0);
    }
    const recentes = f.finais.filter((e) => e.evento === "page_view").sort((a, b) => b.ts - a.ts).slice(0, 100);
    const corpoAcessos = $("#tabela-finais-acessos tbody");
    corpoAcessos.replaceChildren(...(recentes.length ? recentes.map((pv) => {
      const s = porSessao.get(pv.sessao) || {};
      const clicou = [s.grupo ? "grupo" : null, s.especialista ? "especialista" : null].filter(Boolean);
      return el("tr", { class: novosIds.has(`f${pv.id}`) ? "is-novo" : null },
        el("td", { title: fmtDataHora.format(pv.ts) }, fmtDataCurta.format(pv.ts).replace(",", "")),
        el("td", { class: "forte" }, NOME_PAGINA_FINAL[pv.pagina] || pv.pagina),
        el("td", {}, origemDaSessao.get(pv.sessao) || origemFinal(pv)),
        el("td", { title: pv.utm_campaign || "" }, pv.utm_campaign || "—"),
        el("td", {}, capitalizar(pv.dispositivo) || "—"),
        el("td", { class: "num" }, s.tempo ? fmtDuracao(s.tempo) : "—"),
        el("td", {}, clicou.length ? clicou.join(" e ") : "—"));
    }) : [el("tr", {}, el("td", { class: "vazio", colspan: 7 }, "Nenhum acesso às páginas finais no período."))]));
  }

  function posicionarIndicador() {
    const ativa = $(".abas__item[aria-selected='true']");
    const indicador = $(".abas__indicador");
    if (!ativa) return;
    indicador.style.width = `${ativa.offsetWidth - 20}px`;
    indicador.style.transform = `translateX(${ativa.offsetLeft + 10}px)`;
  }

  function trocarAba(aba, focar = false) {
    if (aba !== "pessoas") pararReproducao();
    prefs.aba = aba;
    gravarPrefs();
    $$(".abas__item").forEach((b) => {
      const ativa = b.dataset.aba === aba;
      b.setAttribute("aria-selected", String(ativa));
      b.tabIndex = ativa ? 0 : -1;
      if (ativa && focar) b.focus();
    });
    $$(".painel").forEach((p) => {
      p.hidden = p.id !== `painel-${aba}`;
      if (!p.hidden && !movimentoReduzido) {
        p.classList.remove("is-entrando");
        void p.offsetWidth;
        p.classList.add("is-entrando");
        setTimeout(() => p.classList.remove("is-entrando"), 1200);
      }
    });
    // as cópias não dependem do período nem dos filtros
    $(".filtros").hidden = aba === "copias";
    posicionarIndicador();
    esconderDica();
    render({ animar: true });
  }

  // numera os blocos de cada aba para a entrada escalonada
  $$(".painel").forEach((p) => {
    let i = 0;
    const blocos = [...p.children].flatMap((n) => (n.classList.contains("grade") || n.classList.contains("kpis") ? [...n.children] : [n]));
    blocos.forEach((n) => n.style.setProperty("--i", String(i++)));
  });

  let ultimaContagem = 0;

  function render({ animar = false, aoVivo = false } = {}) {
    if (!dados.carregado) return;
    const [inicio, fim] = intervalo();
    const f = fatiar(inicio, fim);
    const contagem = $("#contagem-cadastros");
    contagem.textContent = fmtNum(f.cadastros.length);
    texto("#contagem-gravacoes", fmtNum(f.eventos.filter((e) => e.evento === "gravacao").length));
    if (aoVivo && f.cadastros.length > ultimaContagem) {
      contagem.classList.remove("is-subiu");
      void contagem.offsetWidth;
      contagem.classList.add("is-subiu");
    }
    ultimaContagem = f.cadastros.length;

    const opcoes = { animar, aoVivo };
    if (prefs.aba === "geral") {
      // base de comparação justa (hoje = ontem até a mesma hora...), ver janelasComparacao()
      renderGeral(f, comparacaoGeral(f), opcoes);
    } else if (prefs.aba === "cadastros") renderCadastros(f, opcoes);
    else if (prefs.aba === "campanhas") renderCampanhas(f, opcoes);
    else if (prefs.aba === "origens") renderOrigens(f, opcoes);
    else if (prefs.aba === "eventos") renderEventos(f, opcoes);
    else if (prefs.aba === "mapa") renderMapa(f, opcoes);
    else if (prefs.aba === "pessoas") renderPessoas(f, opcoes);
    else if (prefs.aba === "finais") renderFinais(f, opcoes);
    texto("#contagem-finais", fmtNum(distintos(f.finais.filter((e) => e.evento === "page_view"), "visitante").size));
    tempoReal(aoVivo);
    // as contagens nas abas mudam de largura e empurram as abas seguintes
    posicionarIndicador();
  }

  // o que muda com o relógio, mesmo sem dado novo
  function tempoReal(aoVivo = true) {
    const limite = relogio() - ATIVO_MS;
    const ativos = new Set();
    for (let i = dados.eventos.length - 1; i >= 0; i--) {
      const e = dados.eventos[i];
      // a ordem é por id; o atraso máximo aceito no envio é de 10 minutos
      if (e.ts < limite - 600000) break;
      if (e.ts >= limite && e.sessao && passaDims(sessaoDe(e))) ativos.add(e.sessao);
    }
    contar("#k-agora", ativos.size, fmtNum, aoVivo);
    $$("#ultimos time[data-ts], #est-itens time[data-ts]").forEach((t) => { t.textContent = fmtRelativo(Number(t.dataset.ts)); });
    const ultimo = $("#c-ultimo");
    if (ultimo.dataset.ts) ultimo.textContent = fmtRelativo(Number(ultimo.dataset.ts));
  }

  /* ---------------------------------------------------------
     Modo demonstração: liga quando a página é aberta direto do disco
     (file://) ou com ?demo no endereço. Gera dados fictícios aqui mesmo e
     simula a chegada de visitas e cadastros; não fala com servidor nenhum.
     --------------------------------------------------------- */
  const DEMO = location.protocol === "file:" || new URLSearchParams(location.search).has("demo");

  const demo = (() => {
    const ids = { eventos: 0, cadastros: 0, finais: 0 };
    let sessoes = 0;
    // páginas finais do Typeform: recolhidas aqui e entregues junto do lote
    let finais = [];
    let sessoesFinais = 0;
    const sorteio = (lista) => lista[Math.floor(Math.random() * lista.length)];
    const ORIGENS = [
      ["facebook", "cpc", "black_vip", "criativo_01"], ["facebook", "cpc", "black_vip", "criativo_02"],
      ["instagram", "stories", "black_vip", "reels_a"], ["google", "cpc", "black_pesquisa", ""],
      ["email", "sfmc", "black_aquecimento", "email_1"], ["", "", "", ""], ["", "", "", ""],
    ];
    const LOCAIS = [["SP", "São Paulo"], ["RJ", "Rio de Janeiro"], ["MG", "Belo Horizonte"], ["PR", "Curitiba"], ["BA", "Salvador"], ["SP", "Campinas"], ["PE", "Recife"]];
    // [seletor, rótulo, k]: k = 0 é clique em algo que não é clicável
    const AREAS = [
      ["[data-ir-para=\"pos\"]", "2 pós pelo preço de 1", 1], ["[data-ir-para=\"escola\"]", "Escola Contábil vitalícia", 1],
      ["#topo", "Black November", 0], ["#escola", "O maior preparatório para o Exame CFC", 0],
      ["#pos-cursos", "Pós-graduações", 0], ["#depoimentos", "O que dizem nossos alunos", 0], ["#gabriel", "Gabriel Rabelo", 0],
    ];
    const NOMES = ["Ana Souza", "Bruno Lima", "Carla Dias", "Diego Alves", "Elisa Rocha", "Fábio Nunes", "Gabriela Reis", "Hugo Martins", "Isabela Costa", "João Pedro", "Larissa Melo", "Marcos Viana"];

    // listas de objetos -> o mesmo formato de colunas e linhas da API
    function lote(objetos, tipo) {
      objetos.sort((a, b) => a.ts - b.ts);
      const colunas = [...new Set(objetos.flatMap((o) => Object.keys(o)))];
      return {
        colunas: ["id", ...colunas],
        linhas: objetos.map((o) => [++ids[tipo], ...colunas.map((c) => (o[c] === undefined || o[c] === "" ? null : o[c]))]),
        completo: true,
      };
    }

    function sessao(ts, eventos, cadastros, aoVivo) {
      const n = ++sessoes;
      const [utm_source, utm_medium, utm_campaign, utm_content] = sorteio(ORIGENS);
      const utm_term = utm_medium === "cpc" ? sorteio(["estatico_01", "estatico_04", "video_01_voces_pediram", "video_02_contagem"]) : "";
      const [estado, cidade] = sorteio(LOCAIS);
      const dispositivo = Math.random() < 0.72 ? "celular" : Math.random() < 0.9 ? "computador" : "tablet";
      const base = { visitante: `v${n > 1 && Math.random() < 0.15 ? Math.ceil(Math.random() * (n - 1)) : n}`, sessao: `s${n}` };
      const clique = utm_source === "facebook" || utm_source === "instagram" ? "meta" : utm_source === "google" ? "google" : "";
      const referencia = !utm_source && Math.random() < 0.5 ? sorteio(["l.instagram.com", "www.google.com", "contabilidadefacilitada.com"]) : "";
      const contexto = {
        utm_source, utm_medium, utm_campaign, utm_content, utm_term, clique, referencia, dispositivo, estado, cidade, pais: "BR",
        navegador: dispositivo === "celular" ? sorteio(["Instagram", "Chrome", "Safari", "Facebook"]) : sorteio(["Chrome", "Edge", "Safari"]),
        sistema: dispositivo === "celular" ? sorteio(["Android", "iOS"]) : "Windows",
      };
      const agora = relogio();
      const ate = (t) => Math.min(t, agora);
      eventos.push({ ts, evento: "page_view", ...base, pagina: "/", ...contexto });
      // cliques presos a elementos que existem na LP (o mapa os encontra pelo seletor)
      const largura = dispositivo === "computador" ? 1440 : 390;
      const clicar = (t, seletor, rotulo, k = 1, perto = false) => {
        const ponto = () => +(perto ? 0.3 + Math.random() * 0.4 : Math.random()).toFixed(3);
        eventos.push({ ts: ate(t), evento: "clique", ...base, valor: largura,
          detalhe: JSON.stringify({ c: seletor, x: ponto(), y: ponto(), px: 0, py: 0, f: 0, k, l: rotulo }) });
      };
      if (Math.random() < 0.4) clicar(ts + 6000, ...sorteio(AREAS));
      if (Math.random() < 0.03) for (let i = 0; i < 3; i++) clicar(ts + 9000 + i * 300, "#gabriel", "Gabriel Rabelo", 0, true);
      // gravação: 20% das visitas por sorteio e toda visita que abre o formulário (ver main.js)
      let gravada = Math.random() < 0.2;
      if (gravada) eventos.push({ ts, evento: "gravacao", ...base });
      // carregamento (LCP): celular mais lento que computador
      const carga = Math.round((dispositivo === "computador" ? 900 : 1600) + Math.random() ** 2 * 3500);
      eventos.push({ ts: ate(ts + carga), evento: "carregamento", ...base, valor: carga, detalhe: JSON.stringify({ m: "lcp" }) });
      const segundos = aoVivo ? 3 : Math.round(5 + Math.random() * 240);
      eventos.push({ ts: ate(ts + segundos * 1000), evento: "engajamento", ...base, detalhe: String(Math.min(100, Math.round(Math.random() * 110))), valor: segundos });
      if (Math.random() < 0.3) eventos.push({ ts: ate(ts + 4000), evento: "gtm.scrollDepth", ...base, detalhe: sorteio(["25", "50", "75", "90"]) });
      if (Math.random() < 0.12) eventos.push({ ts: ate(ts + 2000), evento: "oferta_heroi_clique", ...base, detalhe: sorteio(["escola", "pos"]) });
      const chanceAbrir = 0.18 + (utm_source === "email" ? 0.1 : 0) + (aoVivo ? 0.1 : 0);
      if (Math.random() >= chanceAbrir) return;
      const cta = sorteio(["heroi", "heroi", "dock", "dock", "para-quem", "escola", "pos", "pos-reforma-tributaria", "pos-pericia", "final"]);
      clicar(ts + 19500, `[data-abrir-lead="${cta}"]`, CTAS[cta], 1, true);
      eventos.push({ ts: ate(ts + 20000), evento: "lead_form_aberto", ...base, detalhe: cta });
      if (!gravada) { gravada = true; eventos.push({ ts, evento: "gravacao", ...base }); }
      if (Math.random() >= 0.45) return;
      const nome = sorteio(NOMES);
      const tsCadastro = ate(ts + 50000);
      eventos.push({ ts: tsCadastro, evento: "lead_esquenta_black", ...base, detalhe: cta });
      cadastros.push({
        ts: tsCadastro, nome,
        email: `${normalizar(nome).replace(/[^a-z]+/g, ".")}${n % 97}@exemplo.com`,
        telefone: `119${String(10000000 + n).slice(-8)}`,
        ...base, cta, ...contexto,
        url: `https://exemplo.workers.dev/${utm_source ? `?utm_source=${utm_source}` : ""}`,
      });
      // 3 de 4 terminam o Typeform e chegam a uma página final
      if (Math.random() < 0.75) visitaFinal(ate(tsCadastro + 90000), base.visitante, contexto, "lp_black_november_2026_frios");
    }

    // visita a uma página final; quem vem da Esquenta Black chega com outro visitante
    function visitaFinal(ts, visitante, contexto, leadOrigin) {
      const pontuacao = Math.round(Math.random() ** 0.8 * 200);
      const pagina = `${pontuacao <= 78 ? "a" : "b"}/${Math.random() < 0.45 ? "antecipar" : "esperar"}`;
      const sessaoFinal = `fs${++sessoesFinais}`;
      const base = { pagina, visitante, sessao: sessaoFinal };
      const { utm_source, utm_medium, utm_campaign, utm_content, utm_term, dispositivo, navegador, sistema, estado, cidade, pais } = contexto;
      finais.push({ ts, evento: "page_view", ...base, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        lead_origin: Math.random() < 0.9 ? leadOrigin : "", pontuacao, dispositivo, navegador, sistema, estado, cidade, pais });
      const chance = pagina.endsWith("antecipar") ? 0.62 : 0.48;
      if (Math.random() < chance) finais.push({ ts: Math.min(ts + 8000, relogio()), evento: "clique_grupo", ...base });
      // QR Code só existe no computador
      if (dispositivo === "computador" && Math.random() < 0.3) finais.push({ ts: Math.min(ts + 6000, relogio()), evento: "qr_grupo", ...base });
      finais.push({ ts: Math.min(ts + 15000, relogio()), evento: "engajamento", ...base, valor: Math.round(4 + Math.random() * 60) });
    }
    function visitasEsquenta(n, desde, ate) {
      for (let i = 0; i < n; i++) {
        const [utm_source, utm_medium, utm_campaign, utm_content] = sorteio(ORIGENS);
        const [estado, cidade] = sorteio(LOCAIS);
        visitaFinal(desde + Math.random() * (ate - desde), `ve${i}x${Math.random().toString(36).slice(2, 6)}`,
          { utm_source, utm_medium, utm_campaign, utm_content, dispositivo: "celular", navegador: "Instagram", sistema: "Android", estado, cidade, pais: "BR" },
          sorteio(["lp_black_november_2026_verde", "lp_black_november_2026_laranja"]));
      }
    }
    const pacoteFinais = () => {
      const lista = finais;
      finais = [];
      return lote(lista, "finais");
    };

    return {
      inicial() {
        const eventos = [];
        const cadastros = [];
        const agora = relogio();
        for (let i = 0; i < 3200; i++) sessao(agora - Math.random() ** 0.7 * 6 * DIA - 120000, eventos, cadastros, false);
        for (let i = 0; i < 18; i++) sessao(agora - Math.random() * 100000, eventos, cadastros, true);
        visitasEsquenta(260, agora - 6 * DIA, agora - 60000);
        return { eventos: lote(eventos, "eventos"), cadastros: lote(cadastros, "cadastros"), finais: pacoteFinais() };
      },
      aoVivo() {
        const eventos = [];
        const cadastros = [];
        const novas = Math.floor(Math.random() * 4);
        for (let i = 0; i < novas; i++) sessao(relogio() - Math.random() * 4000, eventos, cadastros, true);
        return { eventos: lote(eventos, "eventos"), cadastros: lote(cadastros, "cadastros"), finais: pacoteFinais() };
      },
    };
  })();

  function sincronizarDemo() {
    clearTimeout(espera);
    const primeira = !dados.carregado;
    const pacote = primeira ? demo.inicial() : demo.aoVivo();
    const eventos = absorver(pacote.eventos, "eventos");
    const cadastros = absorver(pacote.cadastros, "cadastros");
    const finais = absorver(pacote.finais, "finais");
    dados.carregado = true;
    if (primeira) {
      // links fictícios: a demonstração não fala com o Worker
      dados.linksFinais = {
        "a/antecipar": { grupo: "https://exemplo.com/grupo-antecipacao-a" },
        "a/esperar": { grupo: "https://exemplo.com/grupo-a" },
        "b/antecipar": { grupo: "https://exemplo.com/grupo-antecipacao-b" },
        "b/esperar": { grupo: "" },
      };
      document.body.classList.remove("is-iniciando");
      $("#aviso-demo").hidden = false;
      texto("#usuario", "modo demonstração");
      render({ animar: true });
    } else {
      eventos.forEach((e) => novosIds.add(`e${e.id}`));
      finais.forEach((e) => novosIds.add(`f${e.id}`));
      cadastros.forEach((c) => novosIds.add(c.id));
      render({ aoVivo: true });
      novosIds.clear();
      cadastros.forEach(avisar);
    }
    estadoConexao("ok", `Demonstração · atualizado às ${fmtHora.format(relogio())}`);
    espera = setTimeout(sincronizarDemo, INTERVALO_MS);
  }

  /* ---------------------------------------------------------
     Sincronização
     --------------------------------------------------------- */
  let espera = 0;
  let novosEnquantoOculto = 0;
  const tituloOriginal = document.title;

  function estadoConexao(estado, mensagem) {
    $("#ao-vivo").dataset.estado = estado;
    const alvo = $("#ao-vivo-texto");
    if (estado === "sessao") {
      alvo.replaceChildren("Sessão expirada. ", el("a", { href: "/admin/entrar" }, "Entrar de novo"));
    } else {
      alvo.textContent = mensagem;
    }
  }

  function avisar(c) {
    const aviso = el("div", { class: "aviso", role: "status" },
      el("span", { class: "aviso__icone", "aria-hidden": "true" }, iniciais(c.nome)),
      el("strong", {}, "Novo cadastro"),
      el("span", {}, [c.nome || c.email, origemMidia(c)].filter(Boolean).join(" · ")));
    aviso.addEventListener("click", () => abrirDetalhe(c.id));
    $("#avisos").append(aviso);
    setTimeout(() => {
      aviso.classList.add("is-saindo");
      setTimeout(() => aviso.remove(), 400);
    }, 6000);
  }

  /* ---------------------------------------------------------
     Cópias da LP em outros domínios: aviso acima das abas, com
     os domínios vistos nos últimos 30 dias (ver CÓPIAS DA PÁGINA
     em cloudflare/worker.js)
     --------------------------------------------------------- */
  const SINAIS_COPIA = {
    script: "o código da LP rodou lá",
    estilo: "o CSS da LP foi carregado lá",
    arquivo: "imagens ou arquivos puxados daqui",
    envio: "tentou enviar dados para a coleta da LP",
  };
  let copiasMostradas = "";

  function renderCopias(copias) {
    // redesenha só quando muda; a hora relativa anda no próximo sinal
    const assinaturaCopias = JSON.stringify(copias);
    if (assinaturaCopias === copiasMostradas) return;
    copiasMostradas = assinaturaCopias;
    // fica na aba Cópias da LP; a contagem na aba avisa sem tirar o foco dos números
    const contagem = $("#contagem-copias");
    contagem.textContent = fmtNum(copias.length);
    contagem.classList.toggle("abas__contagem--alerta", copias.length > 0);
    const aviso = $("#aviso-copias");
    if (!copias.length) {
      aviso.replaceChildren(el("p", { class: "vazio" }, "Nenhum sinal de cópia nos últimos 30 dias."));
      return;
    }
    aviso.replaceChildren(
      el("p", { class: "aviso-copias__titulo" },
        el("strong", {}, copias.length === 1
          ? "Possível cópia desta LP em outro domínio"
          : `Possíveis cópias desta LP em ${fmtNum(copias.length)} domínios`),
        " · últimos 30 dias"),
      el("ul", { class: "aviso-copias__lista" }, copias.map((c) => el("li", {},
        el("strong", { class: "aviso-copias__dominio" }, c.dominio),
        el("span", {}, [
          `último sinal: ${fmtRelativo(c.ultimo_ts)}`,
          `primeiro: ${fmtDataHora.format(c.primeiro_ts)}`,
          c.visitas ? plural(c.visitas, "visita levada para a LP", "visitas levadas para a LP") : null,
          c.vindo_de ? `visitantes vindos de ${c.vindo_de}` : null,
        ].filter(Boolean).join(" · ")),
        el("span", { class: "aviso-copias__sinais" },
          String(c.sinais || "").split(",").map((s) => SINAIS_COPIA[s] || s).join("; ")),
        // texto, e não link: ninguém abre a cópia por engano daqui
        c.exemplo ? el("code", { class: "aviso-copias__endereco" }, c.exemplo) : null))),
      el("p", { class: "aviso-copias__acao" },
        "Se for golpe, denuncie no ",
        el("a", { href: "https://safebrowsing.google.com/safebrowsing/report_phish/?hl=pt-BR", target: "_blank", rel: "noopener noreferrer" }, "Google Safe Browsing"),
        " e ao provedor do domínio. Ao conferir a cópia, não preencha nada nela."),
    );
  }

  async function sincronizar() {
    if (DEMO) { sincronizarDemo(); return; }
    clearTimeout(espera);
    let mudou = false;
    const cadastrosNovos = [];
    try {
      for (let volta = 0; volta < 200; volta++) {
        const r = await fetch(`${API}?eventos=${dados.ultimo.eventos}&cadastros=${dados.ultimo.cadastros}&finais=${dados.ultimo.finais}`, {
          cache: "no-store",
          credentials: "same-origin",
          // sessão vencida: o Worker responde 401 (ver cloudflare/worker.js)
          redirect: "manual",
        });
        if (r.type === "opaqueredirect" || r.status === 401 || r.status === 403) {
          estadoConexao("sessao");
          return;
        }
        const corpo = await r.json().catch(() => null);
        if (!r.ok || !corpo) {
          throw new Error(corpo?.erro || (r.status === 404
            ? "A API do painel não respondeu (404): o Worker do Cloudflare não está rodando. Confira se o projeto publica com o wrangler.jsonc da raiz."
            : `Erro ${r.status} ao buscar os dados.`));
        }

        dados.desvio = corpo.agora - Date.now();
        if (corpo.email) texto("#usuario", corpo.email);
        if (corpo.copias) renderCopias(corpo.copias);
        if (corpo.linksFinais) dados.linksFinais = corpo.linksFinais;
        const ev = absorver(corpo.eventos, "eventos");
        const cad = absorver(corpo.cadastros, "cadastros");
        // Worker anterior às páginas finais: sem "finais" na resposta
        const fin = corpo.finais ? absorver(corpo.finais, "finais") : [];
        if (ev.length || cad.length || fin.length) mudou = true;
        if (dados.carregado) {
          cadastrosNovos.push(...cad);
          ev.forEach((e) => novosIds.add(`e${e.id}`));
          fin.forEach((e) => novosIds.add(`f${e.id}`));
        }
        if (corpo.eventos.completo && corpo.cadastros.completo && (corpo.finais?.completo ?? true)) break;
        estadoConexao("carregando", `Carregando… ${fmtNum(dados.eventos.length)} eventos`);
      }

      $("#aviso-erro").hidden = true;
      const primeira = !dados.carregado;
      dados.carregado = true;
      cadastrosNovos.forEach((c) => novosIds.add(c.id));
      if (primeira) {
        document.body.classList.remove("is-iniciando");
        render({ animar: true });
      } else if (mudou) {
        render({ aoVivo: true });
      } else {
        tempoReal();
      }
      novosIds.clear();
      cadastrosNovos.slice(-3).forEach(avisar);
      if (document.hidden && cadastrosNovos.length) {
        novosEnquantoOculto += cadastrosNovos.length;
        document.title = `(${novosEnquantoOculto}) ${tituloOriginal}`;
      }
      estadoConexao("ok", `Ao vivo · atualizado às ${fmtHora.format(relogio())}`);
    } catch (erro) {
      estadoConexao("erro", "Sem conexão com os dados. Tentando de novo…");
      const aviso = $("#aviso-erro");
      aviso.textContent = erro?.message && !String(erro.message).startsWith("Failed")
        ? erro.message
        : "Não foi possível falar com o servidor. Confira a conexão; o painel tenta de novo sozinho.";
      aviso.hidden = false;
    } finally {
      if ($("#ao-vivo").dataset.estado !== "sessao") {
        espera = setTimeout(sincronizar, document.hidden ? INTERVALO_OCULTO_MS : INTERVALO_MS);
      }
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    novosEnquantoOculto = 0;
    document.title = tituloOriginal;
    if ($("#ao-vivo").dataset.estado !== "sessao") sincronizar();
  });

  /* ---------------------------------------------------------
     Eventos da interface
     --------------------------------------------------------- */
  // atalhos de um cartão para outra aba (ex.: conversão por origem)
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ir-aba]");
    if (b) trocarAba(b.dataset.irAba);
  });
  $(".abas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-aba]");
    if (b) trocarAba(b.dataset.aba);
  });
  $(".abas").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const abas = $$(".abas__item");
    const i = abas.findIndex((b) => b.dataset.aba === prefs.aba);
    const proxima = abas[(i + (e.key === "ArrowRight" ? 1 : -1) + abas.length) % abas.length];
    trocarAba(proxima.dataset.aba, true);
  });
  window.addEventListener("resize", posicionarIndicador);
  document.fonts?.ready.then(posicionarIndicador);
  // o "ready" pode resolver antes de a Sora começar a baixar; medido com a
  // fonte reserva, o traço fica deslocado nas abas mais à direita
  document.fonts?.addEventListener?.("loadingdone", posicionarIndicador);

  $("#periodos").addEventListener("click", (e) => {
    const b = e.target.closest("[data-periodo]");
    if (!b) return;
    prefs.periodo = b.dataset.periodo;
    if (prefs.periodo === "personalizado" && !prefs.de) {
      prefs.de = paraCampoData(inicioDia(relogio()) - 6 * DIA);
      prefs.ate = paraCampoData(relogio());
    }
    aplicarFiltros();
  });
  ["#f-de", "#f-ate"].forEach((s) => $(s).addEventListener("change", () => {
    prefs.de = $("#f-de").value;
    prefs.ate = $("#f-ate").value;
    aplicarFiltros();
  }));

  // botões de escolha simples (métrica, agrupamento, ranking, mapa de calor)
  const escolhas = [
    ["#metricas", "metrica"],
    ["#granularidades", "granularidade"],
    ["#ranking-dimensoes", "ranking"],
    ["#calor-metricas", "calor"],
    ["#mapa-modos", "mapa"],
    ["#pessoas-filtros", "pessoas"],
    ["#finais-metricas", "finaisMetrica"],
    ["#finais-granularidades", "granularidade"],
  ];
  for (const [seletor, campo] of escolhas) {
    $(seletor).addEventListener("click", (e) => {
      const b = e.target.closest("button");
      const valor = b && Object.values(b.dataset)[0];
      if (!valor) return;
      prefs[campo] = valor;
      gravarPrefs();
      render({ animar: true });
    });
  }
  $("#comparar").addEventListener("change", (e) => {
    prefs.comparar = e.target.checked;
    gravarPrefs();
    render({ animar: true });
  });

  let esperaBusca = 0;
  const buscar = () => {
    clearTimeout(esperaBusca);
    esperaBusca = setTimeout(() => { estadoTabela.pagina = 0; render(); }, 150);
  };
  $("#busca").addEventListener("input", buscar);
  $("#busca-origens").addEventListener("input", buscar);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.target.closest("input, textarea, select")) return;
    e.preventDefault();
    if (prefs.aba !== "cadastros") trocarAba("cadastros");
    $("#busca").focus();
  });

  $("#por-pagina").addEventListener("change", (e) => {
    prefs.porPagina = Number(e.target.value);
    estadoTabela.pagina = 0;
    gravarPrefs();
    render({ animar: true });
  });
  $("#pagina-anterior").addEventListener("click", () => { estadoTabela.pagina--; render({ animar: true }); });
  $("#pagina-proxima").addEventListener("click", () => { estadoTabela.pagina++; render({ animar: true }); });
  $("#exportar").addEventListener("click", exportarCsv);
  ligarOrdenacao("#tabela-cadastros", "cadastros");
  ligarOrdenacao("#tabela-origens", "origens");
  ligarOrdenacao("#tabela-eventos", "eventos");

  const abrirLinhaCadastro = (e) => {
    if (e.target.closest("a")) return;
    const tr = e.target.closest("tr[data-id]");
    if (tr) abrirDetalhe(Number(tr.dataset.id));
  };
  $("#tabela-cadastros tbody").addEventListener("click", abrirLinhaCadastro);
  $("#tabela-cadastros tbody").addEventListener("keydown", (e) => { if (e.key === "Enter") abrirLinhaCadastro(e); });
  $("#detalhe-fechar").addEventListener("click", () => $("#detalhe").close());
  $("#detalhe").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  $("#dimensoes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-dimensao]");
    if (!b) return;
    prefs.dimensao = b.dataset.dimensao;
    $("#busca-origens").value = "";
    gravarPrefs();
    render({ animar: true });
  });
  $("#campanhas-lista").addEventListener("click", (e) => {
    const botao = e.target.closest("button[data-campanha]");
    if (botao) filtrarCampanha(botao.dataset.campanha, botao.dataset.aba);
  });
  // "toggle" não sobe pela árvore: escuta na captura
  $("#campanhas-lista").addEventListener("toggle", (e) => {
    const d = e.target;
    if (!d.matches?.("details[data-campanha]")) return;
    if (d.open) conjuntosAbertos.add(d.dataset.campanha); else conjuntosAbertos.delete(d.dataset.campanha);
  }, true);
  $("#tabela-origens tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-dimensao]");
    if (tr) filtrarPorLinha(tr);
  });
  $("#tabela-origens tbody").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-dimensao]");
    if (tr && e.key === "Enter") filtrarPorLinha(tr);
  });

  const escolherEvento = (e) => {
    const tr = e.target.closest("tr[data-evento]");
    if (!tr) return;
    prefs.evento = tr.dataset.evento;
    gravarPrefs();
    render({ animar: true });
    $(`#tabela-eventos tr[data-evento="${CSS.escape(prefs.evento)}"]`)?.focus();
  };
  $("#tabela-eventos tbody").addEventListener("click", escolherEvento);
  $("#tabela-eventos tbody").addEventListener("keydown", (e) => { if (e.key === "Enter") escolherEvento(e); });
  $("#busca-pessoas").addEventListener("input", () => {
    clearTimeout(esperaBusca);
    esperaBusca = setTimeout(() => render({ animar: true }), 150);
  });
  $("#pessoas-ordem").addEventListener("change", (e) => {
    prefs.pessoasOrdem = e.target.value;
    gravarPrefs();
    render({ animar: true });
  });

  $("#mostrar-pulsos").addEventListener("change", (e) => {
    prefs.pulsos = e.target.checked;
    gravarPrefs();
    render();
  });

  $("#copiar-link").addEventListener("click", async (e) => {
    const botao = e.currentTarget;
    const rotulo = $("span", botao);
    try {
      await navigator.clipboard.writeText(location.href);
      rotulo.textContent = "Link copiado";
      botao.classList.add("is-feito");
    } catch {
      rotulo.textContent = "Não foi possível copiar";
    }
    setTimeout(() => { rotulo.textContent = "Copiar link"; botao.classList.remove("is-feito"); }, 2000);
  });

  window.addEventListener("scroll", esconderDica, { passive: true });

  // relógio da interface: "agora na página" e "há x min" andam sozinhos
  setInterval(() => { if (dados.carregado && !document.hidden) tempoReal(); }, 15000);

  atualizarControles();
  trocarAba(prefs.aba);
  sincronizar();
})();
