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
      const t = Math.min(1, (agora - inicio) / duracao);
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
      comparar: false, calor: "acessos", ranking: "utm_source", porPagina: 50, pulsos: false, mapa: "calor", pessoas: "gravadas", pessoasOrdem: "recentes",
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
      if (["geral", "cadastros", "pessoas", "origens", "eventos", "mapa"].includes(hash.get("aba"))) p.aba = hash.get("aba");
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
    ultimo: { eventos: 0, cadastros: 0 },
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
  function variacao(seletor, atual, anterior, modo = "relativo") {
    const alvo = $(seletor);
    if (anterior === null) { alvo.replaceChildren(); return; }
    const rotulo = ROTULOS_PERIODO_ANTERIOR[prefs.periodo] || "vs período anterior";
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
    alvo.replaceChildren(
      el("span", { class: `seta ${sobe ? "seta--sobe" : "seta--desce"}`, "aria-label": sobe ? "aumento de" : "queda de" }, sobe ? "▲ " : "▼ "),
      `${textoVar} ${rotulo}`,
    );
  }

  function resumo(f) {
    const visitantes = distintos(f.pvs, "visitante").size;
    return { visitantes, cadastros: f.cadastros.length, conversao: visitantes ? f.cadastros.length / visitantes : NaN, acessos: f.pvs.length };
  }

  function renderGeral(f, anterior, { animar, aoVivo }) {
    const r = resumo(f);
    contar("#k-cadastros", r.cadastros, fmtNum, aoVivo);
    contar("#k-acessos", r.acessos, fmtNum, aoVivo);
    contar("#k-visitantes", r.visitantes, fmtNum, aoVivo);
    contar("#k-conversao", r.conversao, (v) => fmtPct(v), aoVivo);
    texto("#k-cadastros-nota", plural(distintos(f.cadastros, "email").size, "e-mail único", "e-mails únicos"));
    texto("#k-acessos-nota", plural(distintos(f.pvs, "sessao").size, "visita (sessão)", "visitas (sessões)"));

    const a = anterior ? resumo(anterior) : null;
    variacao("#k-cadastros-delta", r.cadastros, a ? a.cadastros : null);
    variacao("#k-acessos-delta", r.acessos, a ? a.acessos : null);
    variacao("#k-visitantes-delta", r.visitantes, a ? a.visitantes : null);
    variacao("#k-conversao-delta", r.conversao, a ? a.conversao : null, "pontos");

    // minigráficos dos indicadores, na mesma grade do período
    const grade = gradeTempo(f.inicio, f.fim, escalaDe(f.inicio, f.fim));
    for (const metrica of ["acessos", "visitantes", "cadastros", "conversao"]) {
      faisca($(`#f-${metrica}`), { valores: valoresMetrica(metrica, f, grade), corSerie: METRICAS[metrica].cor(), animar });
    }

    renderEvolucao(f, anterior, grade, animar);
    renderFunil(f, animar);
    renderUltimos(f);
    renderRanking(f, animar);
    renderCalor(f, animar);
  }

  function renderEvolucao(f, anterior, grade, animar) {
    const metrica = METRICAS[prefs.metrica] ? prefs.metrica : "acessos";
    const def = METRICAS[metrica];
    $$("#metricas button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.metrica === metrica)));
    $$("#granularidades button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.granularidade === prefs.granularidade)));
    const comparar = $("#comparar");
    comparar.disabled = !anterior;
    comparar.checked = Boolean(anterior && prefs.comparar);

    const series = [{ nome: def.nome, cor: def.cor(), valores: valoresMetrica(metrica, f, grade) }];
    if (anterior && prefs.comparar) {
      series.push({ nome: `${def.nome} no período anterior`, cor: CORES.anterior, valores: valoresMetrica(metrica, anterior, grade, f.fim - f.inicio) });
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
      el("td", {}, fmtDataHora.format(c.ts)),
      el("td", { class: "forte", title: c.nome || "" }, destacarTermo(c.nome || "—", termo),
        (dados.emails.get(c.email) || 0) > 1 ? el("span", { class: "etiqueta etiqueta--repetido", title: "Este e-mail tem mais de um cadastro" }, "repetido") : null),
      el("td", { title: c.email || "" }, destacarTermo(c.email || "—", termo)),
      el("td", {}, c.telefone ? el("a", { href: `https://wa.me/55${c.telefone}`, target: "_blank", rel: "noopener noreferrer" }, fmtTelefone(c.telefone)) : "—"),
      el("td", { title: origemMidia(c) }, origemMidia(c)),
      el("td", { title: c.utm_campaign || "" }, c.utm_campaign || "—"),
      el("td", { title: c.utm_content || "" }, c.utm_content || "—"),
      el("td", { title: c.utm_term || "" }, c.utm_term || "—"),
      el("td", {}, CTAS[c.cta] || c.cta || "—"),
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
    const porBotao = new Map();
    const botao = (cta) => {
      const chave = cta || "";
      let b = porBotao.get(chave);
      if (!b) porBotao.set(chave, (b = { cta: chave, aberturas: 0, cadastros: 0 }));
      return b;
    };
    for (const e of aberturas) botao(e.detalhe).aberturas++;
    for (const c of f.cadastros) botao(c.cta).cadastros++;
    listaBarras($("#botoes"), [...porBotao.values()].sort((a, b) => b.aberturas - a.aberturas).map((b) => ({
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

  // a página fica no tamanho real do aparelho (o layout depende da altura da
  // tela) e só a imagem é reduzida para caber na coluna
  function escalarQuadro(q) {
    const { largura, altura } = q.cfg;
    const mapa = q.visor.closest(".mapa");
    const disponivel = q.cfg === APARELHOS.celular
      ? mapa.clientWidth - 22
      : q.visor.closest(".mapa__lado").clientWidth - 22;
    q.escala = Math.max(0.2, Math.min(1, disponivel / largura));
    q.visor.style.width = `${Math.floor(largura * q.escala)}px`;
    q.visor.style.height = `${Math.floor(altura * q.escala)}px`;
    q.iframe.style.transform = `scale(${q.escala})`;
  }
  window.addEventListener("resize", () => Object.values(quadros).forEach(escalarQuadro));

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
  };
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
        [v.pv.utm_term || origemMidia(v.pv), local(v.pv), o && o.total > 1 ? `${o.n}ª visita` : null].filter(Boolean).join(" · ")),
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

  function lerGravacao(partes) {
    if (!partes.length) return null;
    const g = { inicio: partes[0].inicio, largura: partes[0].largura, altura: partes[0].altura, alturaDoc: 0, rolagem: [], mouse: [], marcas: [] };
    for (const p of partes) {
      g.alturaDoc = Math.max(g.alturaDoc, p.altura_doc || 0);
      for (const item of String(p.dados || "").split(";")) {
        const [t, tipo, a, b, c] = item.split(",");
        const tn = Number(t);
        if (!Number.isFinite(tn)) continue;
        if (tipo === "s") g.rolagem.push([tn, Number(a)]);
        else if (tipo === "m") g.mouse.push([tn, Number(a), Number(b)]);
        else if (tipo === "i") {
          g.largura = Number(a) || g.largura;
          g.altura = Number(b) || g.altura;
          g.alturaDoc = Math.max(g.alturaDoc, Number(c) || 0);
        } else if (tipo) g.marcas.push([tn, tipo]);
      }
    }
    for (const lista of [g.rolagem, g.mouse, g.marcas]) lista.sort((x, y) => x[0] - y[0]);
    g.duracao = Math.max(0, ...g.rolagem.map((x) => x[0]), ...g.mouse.map((x) => x[0]), ...g.marcas.map((x) => x[0]));
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
    $("#rep-tocar").textContent = "▶";
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
    const medidor = (rotulo, valor, fracao, nota, classe = "") => el("div", { class: `medidor ${classe}` },
      el("span", { class: "medidor__rotulo" }, rotulo),
      el("strong", { class: "medidor__valor" }, valor),
      el("span", { class: "medidor__trilho" }, el("span", { class: "medidor__barra", style: { "--fracao": String(Math.max(0.02, Math.min(1, fracao))) } })),
      el("span", { class: "medidor__nota" }, nota));
    $("#f-metricas").replaceChildren(
      medidor("Tempo na página", fmtDuracao(v.tempo), v.tempo / 180, v.tempo >= 60 ? "leu com calma" : v.tempo >= 15 ? "passou os olhos" : "saiu logo"),
      medidor("Rolagem", `${v.rolagem}%`, v.rolagem / 100, v.rolagem >= 75 ? "viu quase tudo" : v.rolagem >= 40 ? "viu metade" : "ficou no topo"),
      medidor("Cliques", fmtNum(v.cliques.length), v.cliques.length / 10, v.cadastro ? "e se cadastrou" : v.abriu ? "abriu o formulário" : "não abriu o formulário"),
      medidor("Frustração", v.raiva || v.semEfeito ? `${v.raiva + v.semEfeito}` : "nenhuma", (v.raiva * 3 + v.semEfeito) / 8,
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
  };

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
      else if (e.evento === "lead_esquenta_black") itens.push({ t, rotulo: "Enviou o cadastro", sub: "", tipo: "cadastro" });
      else if (e.evento === "gtm.scrollDepth") itens.push({ t, rotulo: `Rolou ${e.detalhe}% da página`, sub: "", tipo: "rolagem" });
    }
    if (cadastro) itens.push({ t: cadastro.ts - inicio, rotulo: "Cadastrou", sub: cadastro.nome || cadastro.email, tipo: "cadastro" });
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
      ...(g ? [...g.rolagem, ...g.mouse, ...g.marcas].map((x) => x[0]) : []),
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
    const palco = $(".ficha__palco");
    const disponivel = Math.max(200, palco.clientWidth - (computador ? 28 : 24));
    const escala = Math.min(1, disponivel / largura, (computador ? window.innerHeight * 0.5 : window.innerHeight * 0.62) / altura);
    visor.style.width = `${Math.floor(largura * escala)}px`;
    visor.style.height = `${Math.floor(altura * escala)}px`;
    iframe.style.transform = `scale(${escala})`;
    Object.assign(rep, { iframe, largura, altura, escala, doc: null });

    iframe.addEventListener("load", () => {
      let doc = null;
      try { doc = iframe.contentDocument; } catch { /* outra origem */ }
      if (!doc?.body) {
        $("#rep-aviso").hidden = false;
        $("#rep-aviso").textContent = "Aberto do disco, o navegador não deixa o painel ler a página. A reprodução funciona no painel publicado.";
        return;
      }
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

  function desenharReproducao() {
    const t = rep.t;
    texto("#rep-tempo", `${fmtTempo(t)} / ${fmtTempo(rep.duracao)}${rep.foraDaAba?.some(([a, b]) => t >= a && t < b) ? " · fora da aba" : ""}`);
    $("#rep-barra").value = String(Math.round(t));

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
    janela.scrollTo(0, Math.max(0, y));

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
    $("#rep-tocar").textContent = "❚❚";
    $("#rep-tocar").setAttribute("aria-label", "Pausar");
    $("#f-aparelho").classList.add("is-tocando");
    rep.quadro = requestAnimationFrame(passoReproducao);
  }

  function marcarVelocidade() {
    $$("#rep-velocidades button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.velocidade) === rep.velocidade)));
  }
  marcarVelocidade();

  $("#rep-tocar").addEventListener("click", alternarReproducao);
  $("#rep-barra").addEventListener("input", (e) => { rep.t = Number(e.target.value); desenharReproducao(); });
  $("#rep-velocidades").addEventListener("click", (e) => {
    const b = e.target.closest("[data-velocidade]");
    if (!b) return;
    rep.velocidade = Number(b.dataset.velocidade);
    marcarVelocidade();
  });

  // lista: escolher, rolar sem fim e navegar pelo teclado
  $("#est-itens").addEventListener("click", (e) => {
    const li = e.target.closest(".est-item");
    if (li) abrirFicha(li.dataset.sessao);
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
    $("#datas").hidden = prefs.periodo !== "personalizado";
    $("#f-de").value = prefs.de;
    $("#f-ate").value = prefs.ate;
    atualizarBotoesFiltro();
  }

  /* ---------------------------------------------------------
     Abas e renderização
     --------------------------------------------------------- */
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
      const anterior = prefs.periodo === "tudo" ? null : fatiar(inicio - (fim - inicio), inicio);
      renderGeral(f, anterior, opcoes);
    } else if (prefs.aba === "cadastros") renderCadastros(f, opcoes);
    else if (prefs.aba === "origens") renderOrigens(f, opcoes);
    else if (prefs.aba === "eventos") renderEventos(f, opcoes);
    else if (prefs.aba === "mapa") renderMapa(f, opcoes);
    else if (prefs.aba === "pessoas") renderPessoas(f, opcoes);
    tempoReal(aoVivo);
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
    const ids = { eventos: 0, cadastros: 0 };
    let sessoes = 0;
    const sorteio = (lista) => lista[Math.floor(Math.random() * lista.length)];
    const ORIGENS = [
      ["facebook", "cpc", "black_vip", "criativo_01"], ["facebook", "cpc", "black_vip", "criativo_02"],
      ["instagram", "stories", "black_vip", "reels_a"], ["google", "cpc", "black_pesquisa", ""],
      ["email", "sfmc", "black_aquecimento", "email_1"], ["", "", "", ""], ["", "", "", ""],
    ];
    const LOCAIS = [["SP", "São Paulo"], ["RJ", "Rio de Janeiro"], ["MG", "Belo Horizonte"], ["PR", "Curitiba"], ["BA", "Salvador"], ["SP", "Campinas"], ["PE", "Recife"]];
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
      const segundos = aoVivo ? 3 : Math.round(5 + Math.random() * 240);
      eventos.push({ ts: ate(ts + segundos * 1000), evento: "engajamento", ...base, detalhe: String(Math.min(100, Math.round(Math.random() * 110))), valor: segundos });
      if (Math.random() < 0.3) eventos.push({ ts: ate(ts + 4000), evento: "gtm.scrollDepth", ...base, detalhe: sorteio(["25", "50", "75", "90"]) });
      if (Math.random() < 0.12) eventos.push({ ts: ate(ts + 2000), evento: "oferta_heroi_clique", ...base, detalhe: sorteio(["escola", "pos"]) });
      const chanceAbrir = 0.18 + (utm_source === "email" ? 0.1 : 0) + (aoVivo ? 0.1 : 0);
      if (Math.random() >= chanceAbrir) return;
      const cta = sorteio(["heroi", "heroi", "dock", "dock", "para-quem", "escola", "pos", "pos-reforma-tributaria", "pos-pericia", "final"]);
      eventos.push({ ts: ate(ts + 20000), evento: "lead_form_aberto", ...base, detalhe: cta });
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
    }

    return {
      inicial() {
        const eventos = [];
        const cadastros = [];
        const agora = relogio();
        for (let i = 0; i < 3200; i++) sessao(agora - Math.random() ** 0.7 * 6 * DIA - 120000, eventos, cadastros, false);
        for (let i = 0; i < 18; i++) sessao(agora - Math.random() * 100000, eventos, cadastros, true);
        return { eventos: lote(eventos, "eventos"), cadastros: lote(cadastros, "cadastros") };
      },
      aoVivo() {
        const eventos = [];
        const cadastros = [];
        const novas = Math.floor(Math.random() * 4);
        for (let i = 0; i < novas; i++) sessao(relogio() - Math.random() * 4000, eventos, cadastros, true);
        return { eventos: lote(eventos, "eventos"), cadastros: lote(cadastros, "cadastros") };
      },
    };
  })();

  function sincronizarDemo() {
    clearTimeout(espera);
    const primeira = !dados.carregado;
    const pacote = primeira ? demo.inicial() : demo.aoVivo();
    const eventos = absorver(pacote.eventos, "eventos");
    const cadastros = absorver(pacote.cadastros, "cadastros");
    dados.carregado = true;
    if (primeira) {
      document.body.classList.remove("is-iniciando");
      $("#aviso-demo").hidden = false;
      texto("#usuario", "modo demonstração");
      render({ animar: true });
    } else {
      eventos.forEach((e) => novosIds.add(`e${e.id}`));
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

  async function sincronizar() {
    if (DEMO) { sincronizarDemo(); return; }
    clearTimeout(espera);
    let mudou = false;
    const cadastrosNovos = [];
    try {
      for (let volta = 0; volta < 200; volta++) {
        const r = await fetch(`${API}?eventos=${dados.ultimo.eventos}&cadastros=${dados.ultimo.cadastros}`, {
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
        const ev = absorver(corpo.eventos, "eventos");
        const cad = absorver(corpo.cadastros, "cadastros");
        if (ev.length || cad.length) mudou = true;
        if (dados.carregado) {
          cadastrosNovos.push(...cad);
          ev.forEach((e) => novosIds.add(`e${e.id}`));
        }
        if (corpo.eventos.completo && corpo.cadastros.completo) break;
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
