/* =========================================================
   Black 2026 (PF) — interações da página
   ========================================================= */
(() => {
  "use strict";

  /**
   * Destino e identidade do lead.
   *
   * O webhook é o mesmo que recebe os cadastros das landing pages do
   * Contabilidade Facilitada, então o corpo reproduz o formato do Elementor:
   * chaves "Nome:", "E-mail:" e "Celular:" com os dois-pontos, celular só com
   * dígitos e sem o 55.
   *
   * event_name, lead_origin e lead_product_interest vão iguais para o n8n
   * e para o Typeform; "_frios" separa esta página da Esquenta Black.
   */
  const CONFIG = {
    webhook: "https://n8n.srv1420397.hstgr.cloud/webhook/elementor-wtl",
    // cópia do mesmo corpo direto no Data Gateway (função lead-lp), para o lead
    // não depender só do n8n; aceita só a origem blacknovember.contabilidadefacilitada.com
    dataGateway: "https://hhxuiastzielrhiobegv.supabase.co/functions/v1/lead-lp",
    identidade: {
      event_name: "black_november_2026",
      lead_origin: "lp_black_november_2026_frios",
      lead_product_interest: "institucional",
    },
    // mesmo Typeform da Esquenta Black: o visitante vai para lá depois do
    // cadastro (endereço montado em urlPosCadastro). Vazio, a confirmação
    // aparece na própria gaveta
    destinoPosCadastro: "https://3rng23rvpr3.typeform.com/black-2026",
    // segundos de aviso na gaveta antes de abrir o destino
    esperaDestinoS: 4,
    formId: "black_pf_2026",
    formNome: "Lista VIP - Black PF 2026",
    // mesmo evento de conversão da Esquenta Black, para os gatilhos do GTM
    eventoCadastro: "lead_esquenta_black",
    tempoLimiteEnvioMs: 8000,
  };

  const raiz = document.documentElement;
  raiz.classList.remove("sem-js");

  const movimentoReduzido = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ponteiroFino = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const telaCelular = window.matchMedia("(max-width: 959px)");
  // abaixo de 640px: pós em carrossel, credenciais em stories e mural com
  // um cartão por vez
  const telaEstreita = window.matchMedia("(max-width: 639px)");
  // resolução máxima dos canvas: as partículas são brilhos pequenos e
  // difusos, e 1,5× basta nas telas de toque
  const dprMaximo = ponteiroFino ? 2 : 1.5;

  const $ = (seletor, contexto = document) => contexto.querySelector(seletor);
  const $$ = (seletor, contexto = document) => Array.from(contexto.querySelectorAll(seletor));

  const armazenamento = {
    ler(chave, tipo = localStorage) {
      try { return JSON.parse(tipo.getItem(chave)); } catch { return null; }
    },
    gravar(chave, valor, tipo = localStorage) {
      try { tipo.setItem(chave, JSON.stringify(valor)); } catch { /* navegação privada */ }
    },
    remover(chave, tipo = localStorage) {
      try { tipo.removeItem(chave); } catch { /* navegação privada */ }
    },
  };

  /* ---------------------------------------------------------
     Atribuição: guarda as UTMs da primeira página vista na sessão
     --------------------------------------------------------- */
  const CHAVES_UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
  // identificadores de clique que as plataformas de anúncio põem na URL
  const CLIQUES = {
    gclid: "google", gbraid: "google", wbraid: "google", fbclid: "meta",
    ttclid: "tiktok", msclkid: "microsoft", li_fat_id: "linkedin",
  };

  const atribuicao = (() => {
    const daUrl = new URLSearchParams(location.search);
    const salva = armazenamento.ler("cf_black_pf_utm", sessionStorage) || {};
    const temNaUrl = CHAVES_UTM.some((c) => daUrl.get(c));
    const novaEntrada = temNaUrl || !salva.urlCompleta;
    const clique = Object.keys(CLIQUES).find((c) => daUrl.get(c));
    let referencia = "";
    try {
      const host = document.referrer ? new URL(document.referrer).hostname : "";
      if (host !== location.hostname) referencia = host;
    } catch { /* referrer malformado */ }
    const dados = {
      urlCompleta: novaEntrada ? location.href : salva.urlCompleta,
      clique: clique ? CLIQUES[clique] : salva.clique || "",
      referencia: novaEntrada ? referencia : salva.referencia || "",
    };
    CHAVES_UTM.forEach((c) => { dados[c] = (temNaUrl ? daUrl.get(c) : salva[c]) || ""; });
    armazenamento.gravar("cf_black_pf_utm", dados, sessionStorage);
    return dados;
  })();

  function empurrarEvento(evento, extra = {}) {
    if (Array.isArray(window.dataLayer)) window.dataLayer.push({ event: evento, ...extra });
  }

  /* ---------------------------------------------------------
     Medição própria para o painel em /admin/: o acesso, todos os eventos
     que passam pelo dataLayer (os desta página e os do GTM), o engajamento,
     os cliques e uma cópia de cada cadastro. Vai em lotes para o Worker
     (cloudflare/worker.js), que grava no D1; falhas são silenciosas.
     Mesmo formato da LP Esquenta Black, sem o teste A/B.
     --------------------------------------------------------- */
  const rastreio = (() => {
    // relativo: api/coleta, atendido pelo Worker
    const DESTINO = "api/coleta";
    const novoId = () => crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

    let visitante = armazenamento.ler("cf_black_pf_vid");
    if (!visitante) { visitante = novoId(); armazenamento.gravar("cf_black_pf_vid", visitante); }
    let sessao = armazenamento.ler("cf_black_pf_sid", sessionStorage);
    if (!sessao) { sessao = novoId(); armazenamento.gravar("cf_black_pf_sid", sessao, sessionStorage); }

    const identificacao = { v: visitante, s: sessao };
    const contexto = {
      pagina: location.pathname,
      ref: atribuicao.referencia,
      clique: atribuicao.clique,
      ...Object.fromEntries(CHAVES_UTM.map((c) => [c, atribuicao[c]])),
    };

    const fila = [];
    let espera = 0;

    // "dt": há quanto tempo o evento aconteceu, para o servidor datar certo
    function enviar(saindo = false) {
      clearTimeout(espera);
      espera = 0;
      while (fila.length) {
        const agora = Date.now();
        const eventos = fila.splice(0, 20).map(({ t, ...e }) => ({ ...e, dt: agora - t }));
        const corpo = JSON.stringify({ ...identificacao, eventos });
        if (saindo && navigator.sendBeacon?.(DESTINO, new Blob([corpo], { type: "text/plain" }))) continue;
        fetch(DESTINO, { method: "POST", body: corpo, keepalive: true }).catch(() => {});
      }
    }

    function registrar(evento, { detalhe, valor, ctx } = {}) {
      fila.push({ e: evento, d: detalhe, n: valor, ctx, t: Date.now() });
      if (fila.length >= 20) enviar();
      else if (!espera) espera = setTimeout(enviar, 2000);
    }

    // Lê o dataLayer pelo índice em vez de interceptar o push: o GTM troca o
    // push do array quando carrega, e a leitura funciona antes e depois disso
    // (e também quando um bloqueador impede o GTM de carregar). Ficam de fora
    // os eventos internos do ciclo de carregamento do GTM.
    const IGNORADOS = /^gtm\.(js|dom|load|init|init_consent|timer|historyChange)/;
    let lidos = 0;
    function lerDataLayer() {
      const camada = window.dataLayer;
      if (!Array.isArray(camada)) return;
      for (; lidos < camada.length; lidos++) {
        const item = camada[lidos];
        if (!item || typeof item.event !== "string" || IGNORADOS.test(item.event)) continue;
        const detalhe = item.cta ?? item["gtm.elementText"] ?? item["gtm.scrollThreshold"]
          ?? item["gtm.elementUrl"] ?? item["gtm.videoStatus"];
        registrar(item.event, { detalhe: detalhe == null ? undefined : String(detalhe).trim().slice(0, 200) });
      }
    }

    // engajamento: segundos com a página visível e a maior rolagem (%)
    let visivelMs = 0;
    let visivelDesde = document.visibilityState === "visible" ? performance.now() : 0;
    let rolagemMax = 0;
    let pulsos = 0;
    let medindo = false;

    function medirRolagem() {
      medindo = false;
      const total = document.documentElement.scrollHeight - window.innerHeight;
      const pct = total > 0 ? Math.round(Math.min(1, window.scrollY / total) * 100) : 100;
      if (pct > rolagemMax) rolagemMax = pct;
    }
    window.addEventListener("scroll", () => {
      if (!medindo) { medindo = true; requestAnimationFrame(medirRolagem); }
    }, { passive: true });

    function engajamento() {
      const ms = visivelMs + (visivelDesde ? performance.now() - visivelDesde : 0);
      registrar("engajamento", { detalhe: String(rolagemMax), valor: Math.round(ms / 1000) });
    }

    // um pulso por minuto com a página à vista alimenta o "agora na página"
    // do painel; para depois de 30 minutos
    setInterval(() => {
      if (document.visibilityState !== "visible" || pulsos >= 30) return;
      pulsos++;
      engajamento();
    }, 60000);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        if (visivelDesde) { visivelMs += performance.now() - visivelDesde; visivelDesde = 0; }
        lerDataLayer();
        engajamento();
        enviar(true);
      } else {
        visivelDesde = performance.now();
      }
    });
    window.addEventListener("pagehide", () => { lerDataLayer(); enviar(true); });

    // Mapa de cliques do painel: cada clique ou toque vai preso ao elemento em
    // que caiu (caminho de seletores + ponto dentro dele, de 0 a 1), para ser
    // redesenhado por cima da página em qualquer largura de tela. Vai junto a
    // posição na página (relativa ao centro), usada quando o elemento não
    // existe na página estática do painel (os criados por script).
    const caminhoDe = (el) => {
      const partes = [];
      for (let no = el; no && no !== document.body && partes.length < 14; no = no.parentElement) {
        if (no.id) { partes.unshift(`#${CSS.escape(no.id)}`); return partes.join(">"); }
        let ordem = 1;
        for (let irmao = no.previousElementSibling; irmao; irmao = irmao.previousElementSibling) {
          if (irmao.tagName === no.tagName) ordem++;
        }
        partes.unshift(`${no.tagName.toLowerCase()}:nth-of-type(${ordem})`);
      }
      return partes.length ? `body>${partes.join(">")}` : "body";
    };
    const emElementoFixo = (el) => {
      for (let no = el; no && no !== document.body; no = no.parentElement) {
        if (getComputedStyle(no).position === "fixed") return true;
      }
      return false;
    };
    let cliques = 0;
    document.addEventListener("click", (e) => {
      if (cliques >= 40 || !(e.target instanceof Element)) return;
      cliques++;
      const CLICAVEIS = "a, button, input, select, textarea, label, summary, [role='button'], [data-abrir-lead]";
      let alvo = e.target.closest(CLICAVEIS) || e.target;
      while (alvo instanceof SVGElement && alvo.parentElement) alvo = alvo.parentElement;
      if (alvo === document.documentElement) alvo = document.body;
      const r = alvo.getBoundingClientRect();
      // rótulo legível para a lista do painel: innerText (sem o código dos
      // scripts); de campo, só o nome, nunca o valor. Imagem e ícone sem
      // texto levam o texto do bloco em volta (o cartão da pós, por exemplo)
      let texto = (/^(INPUT|SELECT|TEXTAREA)$/.test(alvo.tagName) ? `Campo ${alvo.name || alvo.type || ""}` : alvo.innerText) || "";
      for (let no = alvo.parentElement, n = 0; !texto.trim() && no && no !== document.body && n < 4; no = no.parentElement, n++) {
        texto = no.innerText || "";
      }
      const rotulo = alvo === document.body ? "(fundo da página)"
        : (alvo.getAttribute("aria-label") || alvo.getAttribute("alt") || texto)
          .trim().replace(/\s+/g, " ").slice(0, 60);
      registrar("clique", {
        valor: window.innerWidth,
        detalhe: JSON.stringify({
          c: caminhoDe(alvo),
          x: r.width ? +((e.clientX - r.left) / r.width).toFixed(3) : 0.5,
          y: r.height ? +((e.clientY - r.top) / r.height).toFixed(3) : 0.5,
          px: Math.round(e.pageX - window.innerWidth / 2),
          py: Math.round(e.pageY),
          f: emElementoFixo(alvo) ? 1 : 0,
          // 0 = clicou em algo que não é clicável ("clique sem efeito" no painel)
          k: alvo.matches(CLICAVEIS) ? 1 : 0,
          l: rotulo,
        }),
      });
    }, { capture: true, passive: true });

    // Gravação da visita para a reprodução do painel (aba Gravações): rolagem,
    // ponteiro do mouse, abertura do formulário e troca de aba, em texto
    // compacto ("tempo,tipo,a,b;..."); os cliques já vão como evento. Grava
    // sempre na memória, mas só envia em 20% das visitas (sorteio) e em toda
    // visita que abre o formulário, que leva junto tudo o que veio antes.
    // Para depois de 10 minutos. Nada do que é digitado entra na gravação.
    (() => {
      const LIMITE_MS = 600000;
      const PARTE_MAXIMA = 12000;
      const inicio = Date.now();
      const t0 = performance.now();
      const tempo = () => Math.round(performance.now() - t0);
      const alturaDoc = () => document.documentElement.scrollHeight;
      let enviando = Math.random() < 0.2;
      let parte = 0;
      let fila = [];
      let tamanho = 0;
      let parada = false;
      let formAberto = false;

      function despachar(saindo = false) {
        if (!enviando || !fila.length) return;
        while (fila.length) {
          // partes de até 12 mil caracteres (o Worker recusa acima de 24 mil)
          let n = 0;
          let soma = 0;
          while (n < fila.length && soma + fila[n].length < PARTE_MAXIMA) soma += fila[n++].length + 1;
          const itens = fila.splice(0, Math.max(1, n));
          const corpo = JSON.stringify({
            v: visitante, s: sessao, seq: parte++, ini: inicio,
            w: window.innerWidth, h: window.innerHeight, dh: alturaDoc(), d: itens.join(";"),
          });
          if (saindo && navigator.sendBeacon?.("api/gravacao", new Blob([corpo], { type: "text/plain" }))) continue;
          fetch("api/gravacao", { method: "POST", body: corpo, keepalive: saindo }).catch(() => {});
        }
        tamanho = 0;
      }

      function marcar(...valores) {
        if (parada) return;
        const t = tempo();
        if (t > LIMITE_MS) { parada = true; despachar(); return; }
        const item = [t, ...valores].join(",");
        fila.push(item);
        tamanho += item.length + 1;
        if (enviando && tamanho > PARTE_MAXIMA) despachar();
      }

      marcar("i", window.innerWidth, window.innerHeight, alturaDoc());
      marcar("s", Math.round(window.scrollY));

      let esperaRolagem = 0;
      let ultimaRolagem = Math.round(window.scrollY);
      window.addEventListener("scroll", () => {
        if (esperaRolagem) return;
        esperaRolagem = setTimeout(() => {
          esperaRolagem = 0;
          const y = Math.round(window.scrollY);
          if (y !== ultimaRolagem) { ultimaRolagem = y; marcar("s", y); }
        }, 100);
      }, { passive: true });

      let ultimoMouse = 0;
      window.addEventListener("pointermove", (e) => {
        if (e.pointerType !== "mouse") return;
        const agora = performance.now();
        if (agora - ultimoMouse < 100) return;
        ultimoMouse = agora;
        marcar("m", Math.round(e.pageX - window.innerWidth / 2), Math.round(e.pageY));
      }, { passive: true });

      window.addEventListener("resize", () => marcar("i", window.innerWidth, window.innerHeight, alturaDoc()));

      // o formulário aberto põe a classe lead-aberto no body (ver abrirLead)
      new MutationObserver(() => {
        const aberto = document.body.classList.contains("lead-aberto");
        if (aberto === formAberto) return;
        formAberto = aberto;
        marcar(aberto ? "a" : "f");
        if (aberto && !enviando) { enviando = true; despachar(); }
      }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

      document.addEventListener("visibilitychange", () => {
        marcar(document.hidden ? "h" : "v");
        if (document.hidden) despachar(true);
      });
      window.addEventListener("pagehide", () => despachar(true));
      setInterval(() => despachar(), 10000);
    })();

    registrar("page_view", { ctx: contexto });
    enviar();
    setInterval(lerDataLayer, 1000);
    medirRolagem();

    return {
      // chamado depois do envio ao n8n; keepalive mantém o envio vivo durante
      // a troca de página para o Typeform
      cadastro({ nome, email, telefone, cta }) {
        lerDataLayer();
        enviar();
        const corpo = JSON.stringify({
          ...identificacao,
          ctx: contexto,
          cadastro: { nome, email, telefone, cta, url: atribuicao.urlCompleta },
        });
        fetch("api/cadastro", { method: "POST", body: corpo, keepalive: true }).catch(() => {});
      },
    };
  })();

  /* ---------------------------------------------------------
     Título: cada palavra sobe sozinha. Sem JavaScript (ou com movimento
     reduzido), o título entra inteiro, pelo CSS.
     --------------------------------------------------------- */
  (() => {
    const titulo = $("[data-palavras]");
    if (!titulo || movimentoReduzido) return;
    let indice = 0;
    const dividir = (no) => {
      Array.from(no.childNodes).forEach((filho) => {
        if (filho.nodeType === Node.ELEMENT_NODE) { dividir(filho); return; }
        if (filho.nodeType !== Node.TEXT_NODE) return;
        const fragmento = document.createDocumentFragment();
        filho.textContent.split(/(\s+)/).forEach((parte) => {
          if (!parte) return;
          if (/^\s+$/.test(parte)) { fragmento.append(" "); return; }
          const palavra = document.createElement("span");
          const miolo = document.createElement("span");
          palavra.className = "palavra";
          miolo.textContent = parte;
          miolo.style.setProperty("--i", indice++);
          palavra.append(miolo);
          fragmento.append(palavra);
        });
        filho.replaceWith(fragmento);
      });
    };
    dividir(titulo);
    titulo.classList.add("is-dividido");
  })();

  /* ---------------------------------------------------------
     Vitrine de logos atrás do especialista (só no computador)

     Cada linha é o conjunto de logos duas vezes seguidas, e a animação anda
     metade da largura: quando termina, a segunda metade está exatamente onde
     a primeira começou, e o laço fica sem emenda.
     --------------------------------------------------------- */
  (() => {
    const alvo = $("[data-vitrine]");
    if (!alvo) return;
    const LOGOS = [
      "escola-contabil", "reforma-tributaria", "aprovacao-contabil",
      "rotinas-simples", "financas-controladoria", "setor-publico",
      "pericia-contabil", "departamento-pessoal", "auditoria-compliance",
    ];
    const LINHAS = 9;

    function montar() {
      const fragmento = document.createDocumentFragment();
      for (let i = 0; i < LINHAS; i++) {
        const deslocamento = (i * 4) % LOGOS.length;
        const ordem = LOGOS.slice(deslocamento).concat(LOGOS.slice(0, deslocamento));
        const grupo = () => {
          const g = document.createElement("div");
          g.className = "vitrine__grupo";
          ordem.forEach((nome) => {
            const item = document.createElement("span");
            item.className = "vitrine__item";
            item.innerHTML = `<img src="assets/img/cursos/${nome}.svg" alt="" decoding="async">`;
            g.appendChild(item);
          });
          return g;
        };
        const linha = document.createElement("div");
        linha.className = "vitrine__linha";
        const trilho = document.createElement("div");
        trilho.className = "vitrine__trilho";
        trilho.style.setProperty("--duracao", `${70 + i * 9}s`);
        trilho.append(grupo(), grupo());
        linha.appendChild(trilho);
        fragmento.appendChild(linha);
      }
      alvo.appendChild(fragmento);
    }

    // no celular a vitrine também aparece, atrás da foto do pôster
    montar();
  })();

  /* ---------------------------------------------------------
     Arrastar com o mouse as faixas que rolam de lado (carrossel das pós e
     mural de depoimentos). No toque a rolagem já é nativa. Ao soltar, a
     faixa segue no embalo e desacelera, como no dedo; depois desliza até a
     posição que alvoAoSoltar devolver (o cartão mais perto do centro). O
     encaixe do CSS fica desligado (is-arrastando) até o fim, para não dar
     tranco. O clique que termina um arrasto não abre o cartão.
     --------------------------------------------------------- */
  function arrastarComMouse(el, alvoAoSoltar) {
    let inicioX = 0;
    let inicioRolagem = 0;
    let ativo = false;
    let arrastou = false;
    let ultimoX = 0;
    let ultimoT = 0;
    let velocidade = 0; // px por ms, no sentido da rolagem
    let embalo = 0;
    let espera = 0;
    const bloquearClique = (e) => { e.preventDefault(); e.stopPropagation(); };

    function terminar() {
      clearTimeout(espera);
      el.classList.remove("is-arrastando");
    }
    function encaixar() {
      const alvo = alvoAoSoltar?.();
      if (alvo == null || movimentoReduzido) { terminar(); return; }
      el.scrollTo({ left: alvo, behavior: "smooth" });
      el.addEventListener("scrollend", terminar, { once: true });
      espera = setTimeout(terminar, 700); // navegador sem scrollend
    }

    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      cancelAnimationFrame(embalo);
      clearTimeout(espera);
      ativo = true;
      arrastou = false;
      inicioX = ultimoX = e.clientX;
      ultimoT = e.timeStamp;
      velocidade = 0;
      inicioRolagem = el.scrollLeft;
    });
    el.addEventListener("pointermove", (e) => {
      if (!ativo) return;
      const dx = e.clientX - inicioX;
      if (!arrastou) {
        if (Math.abs(dx) < 6) return;
        // a captura só começa no arrasto: um clique simples segue para o cartão
        arrastou = true;
        el.setPointerCapture(e.pointerId);
        el.classList.add("is-arrastando");
      }
      el.scrollLeft = inicioRolagem - dx;
      const dt = e.timeStamp - ultimoT;
      if (dt > 0) velocidade = 0.7 * ((ultimoX - e.clientX) / dt) + 0.3 * velocidade;
      ultimoX = e.clientX;
      ultimoT = e.timeStamp;
    });
    const soltar = (e) => {
      if (!ativo) return;
      ativo = false;
      if (!arrastou) return;
      el.addEventListener("click", bloquearClique, { capture: true, once: true });
      setTimeout(() => el.removeEventListener("click", bloquearClique, { capture: true }), 0);
      // parou o mouse antes de soltar: sem embalo
      let v = e.timeStamp - ultimoT > 90 ? 0 : velocidade;
      if (movimentoReduzido || Math.abs(v) < 0.15) { encaixar(); return; }
      let antes = performance.now();
      const passo = (agora) => {
        const dt = Math.min(32, agora - antes);
        antes = agora;
        el.scrollLeft += v * dt;
        v *= Math.pow(0.95, dt / 16);
        if (Math.abs(v) > 0.05) embalo = requestAnimationFrame(passo);
        else encaixar();
      };
      embalo = requestAnimationFrame(passo);
    };
    el.addEventListener("pointerup", soltar);
    el.addEventListener("pointercancel", soltar);
    el.addEventListener("dragstart", (e) => e.preventDefault());
  }

  /* ---------------------------------------------------------
     Contadores ("+4.000", "+8 mil", "100K+"...): sobem de zero quando
     aparecem. data-prefixo e data-sufixo ficam fixos em volta do número.
     --------------------------------------------------------- */
  (() => {
    if (movimentoReduzido) return;
    const formato = new Intl.NumberFormat("pt-BR");
    // a largura reservada é medida com a fonte final, não com a de reserva
    const fontesProntas = document.fonts?.ready || Promise.resolve();
    fontesProntas.then(() => $$("[data-contar]").forEach((el) => {
      const final = Number(el.dataset.contar);
      const prefixo = el.dataset.prefixo || "";
      const sufixo = el.dataset.sufixo || "";
      // largura do número final reservada: o texto ao lado não pula
      el.style.minWidth = `${el.getBoundingClientRect().width}px`;
      el.textContent = `${prefixo}0${sufixo}`;

      const contar = () => {
        const inicio = performance.now();
        const duracao = 1800;
        (function passo(agora) {
          const t = Math.min(1, (agora - inicio) / duracao);
          const suave = 1 - Math.pow(1 - t, 4);
          el.textContent = prefixo + formato.format(Math.round(final * suave)) + sufixo;
          if (t < 1) requestAnimationFrame(passo);
        })(inicio);
      };

      const observador = new IntersectionObserver(([e]) => {
        if (!e.isIntersecting) return;
        observador.disconnect();
        // espera o cartão terminar de entrar (ver .oferta no CSS)
        setTimeout(contar, Math.max(0, 1500 - performance.now()));
      }, { threshold: 0.6 });
      observador.observe(el);
    }));
  })();

  /* ---------------------------------------------------------
     Mural de depoimentos: a segunda linha é a primeira de trás para a
     frente, e cada linha leva o grupo duas vezes seguidas (a animação anda
     metade da largura, como as tarjas). Com movimento reduzido fica uma
     linha só, sem cópias, para rolar de lado.
     --------------------------------------------------------- */
  (() => {
    const mural = $("[data-mural]");
    if (!mural || movimentoReduzido) return;
    const primeira = $(".mural__linha", mural);
    const segunda = primeira.cloneNode(true);
    segunda.classList.add("mural__linha--reversa");
    segunda.setAttribute("aria-hidden", "true");
    const grupoReverso = $(".mural__grupo", segunda);
    Array.from(grupoReverso.children).reverse().forEach((item) => grupoReverso.appendChild(item));
    mural.appendChild(segunda);

    [primeira, segunda].forEach((linha) => {
      const trilho = $(".mural__trilho", linha);
      const copia = $(".mural__grupo", trilho).cloneNode(true);
      copia.setAttribute("aria-hidden", "true");
      trilho.appendChild(copia);
    });
  })();

  /* ---------------------------------------------------------
     Mural arrastável: cada linha rola de lado (scrollLeft) e anda sozinha
     um grupo a cada 70 s (80 s na reversa). Dedo, mouse ou roda pausam o
     movimento; ele volta 2,5 s depois que a pessoa solta. Como o trilho tem
     o grupo duas vezes, a posição dá a volta em um grupo e o laço não tem
     emenda. Com movimento reduzido só fica o arrasto.
     --------------------------------------------------------- */
  (() => {
    const mural = $("[data-mural]");
    if (!mural) return;
    mural.classList.add("is-rolavel");
    const linhas = $$(".mural__linha", mural).map((linha) => {
      const estado = {
        linha,
        grupo: $(".mural__grupo", linha),
        sentido: linha.classList.contains("mural__linha--reversa") ? -1 : 1,
        duracao: linha.classList.contains("mural__linha--reversa") ? 80000 : 70000,
        periodo: 0,
        pos: 0,
        mexendo: false,
        pausadoAte: 0,
      };
      // no celular, ao soltar, encaixa no cartão mais perto do centro; no
      // computador a faixa fica onde parou e volta a andar dali
      arrastarComMouse(linha, () => {
        if (!telaEstreita.matches) return null;
        const { itens, indice } = cartaoAtual(estado);
        return centroDe(linha, itens[indice]);
      });
      if (movimentoReduzido) return estado;

      const parar = () => { estado.mexendo = true; };
      const soltar = () => { estado.mexendo = false; estado.pausadoAte = performance.now() + 2500; };
      linha.addEventListener("pointerdown", parar);
      linha.addEventListener("touchstart", parar, { passive: true });
      ["pointerup", "pointercancel", "touchend", "touchcancel"].forEach((t) => linha.addEventListener(t, soltar, { passive: true }));
      linha.addEventListener("wheel", soltar, { passive: true });
      // mouse em cima: pausa para dar tempo de ler
      linha.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") parar(); });
      linha.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") soltar(); });

      // na mão da pessoa (inclusive no embalo depois de soltar), a posição
      // também dá a volta, para a faixa não acabar
      linha.addEventListener("scroll", () => {
        if (!estado.mexendo && performance.now() > estado.pausadoAte) return;
        estado.pausadoAte = Math.max(estado.pausadoAte, performance.now() + 1500);
        const fim = estado.periodo * 2 - linha.clientWidth;
        if (linha.scrollLeft < 2) linha.scrollLeft += estado.periodo;
        else if (linha.scrollLeft > fim - 2) linha.scrollLeft -= estado.periodo;
      }, { passive: true });
      return estado;
    });

    const medir = () => linhas.forEach((e) => {
      e.periodo = e.grupo.offsetWidth;
      if (e.sentido < 0 && !e.pos) e.pos = e.periodo / 2;
    });
    medir();
    new ResizeObserver(medir).observe(linhas[0].grupo);
    if (movimentoReduzido) return;

    /* Celular: uma linha só, com encaixe (CSS). Em vez de deslizar sem
       parar, que atrapalha a leitura, ela passa um cartão a cada 5 s. A
       posição fica entre o 2º cartão do primeiro grupo e o 2º da cópia: é
       sempre possível centralizar o cartão seguinte, e o salto de um grupo
       para trás não aparece (as duas metades são iguais). */
    const PASSO_MS = 5000;
    function centroDe(linha, li) {
      const caixa = linha.getBoundingClientRect();
      const r = li.getBoundingClientRect();
      return linha.scrollLeft + (r.left - caixa.left) - (caixa.width - r.width) / 2;
    }
    function cartaoAtual(e) {
      const itens = $$(".mural__grupo > li", e.linha);
      const caixa = e.linha.getBoundingClientRect();
      const meio = caixa.left + caixa.width / 2;
      let melhor = 0;
      let menor = Infinity;
      itens.forEach((li, i) => {
        const r = li.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - meio);
        if (d < menor) { menor = d; melhor = i; }
      });
      return { itens, indice: melhor, n: itens.length / 2 };
    }
    function passo(e) {
      let { itens, indice, n } = cartaoAtual(e);
      if (indice > n) { e.linha.scrollLeft -= e.periodo; indice -= n; }
      e.linha.scrollTo({ left: centroDe(e.linha, itens[indice + 1]), behavior: "smooth" });
    }
    function posicionarNoCelular() {
      linhas.forEach((e) => {
        if (!e.periodo || e.linha.dataset.iniciada) return;
        const { itens, n } = cartaoAtual(e);
        e.linha.scrollLeft = centroDe(e.linha, itens[n]);
        e.linha.dataset.iniciada = "1";
      });
    }

    let naTela = false;
    let rodando = false;
    let ultimo = 0;
    function quadro(agora) {
      if (!naTela || document.hidden) { rodando = false; return; }
      const dt = Math.min(64, agora - ultimo);
      ultimo = agora;
      if (telaEstreita.matches) {
        posicionarNoCelular();
        linhas.forEach((e) => {
          if (!e.periodo) return;
          if (e.mexendo || agora < e.pausadoAte) { e.proximoPasso = Math.max(e.pausadoAte, agora) + PASSO_MS; return; }
          if (!e.proximoPasso) e.proximoPasso = agora + PASSO_MS;
          if (agora >= e.proximoPasso) { passo(e); e.proximoPasso = agora + PASSO_MS; }
        });
        requestAnimationFrame(quadro);
        return;
      }
      linhas.forEach((e) => {
        if (!e.periodo) return;
        // parado: guarda onde a pessoa deixou para seguir dali
        if (e.mexendo || agora < e.pausadoAte) { e.pos = e.linha.scrollLeft; return; }
        e.pos += (e.sentido * e.periodo * dt) / e.duracao;
        if (e.pos >= e.periodo) e.pos -= e.periodo;
        else if (e.pos < 0) e.pos += e.periodo;
        e.linha.scrollLeft = e.pos;
      });
      requestAnimationFrame(quadro);
    }
    const acordar = () => {
      if (rodando || !naTela || document.hidden) return;
      rodando = true;
      ultimo = performance.now();
      requestAnimationFrame(quadro);
    };
    new IntersectionObserver(([e]) => { naTela = e.isIntersecting; acordar(); }, { rootMargin: "100px 0px" }).observe(mural);
    document.addEventListener("visibilitychange", acordar);
  })();

  // bonecos da dobra da Escola: entram em sequência (atraso por --i no CSS)
  $$(".bonecos li").forEach((li, i) => li.style.setProperty("--i", i));


  /* ---------------------------------------------------------
     Carrossel das pós (celular): o cartão mais perto do centro fica
     ativo, os pontos embaixo acompanham e levam ao cartão tocado. Acima
     de 640px o CSS volta à grade e os pontos somem.
     --------------------------------------------------------- */
  (() => {
    const lista = $("[data-carrossel]");
    if (!lista) return;
    const itens = Array.from(lista.children);
    const pontos = document.createElement("div");
    pontos.className = "carrossel__pontos";
    const botoes = itens.map((li, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "carrossel__ponto";
      b.setAttribute("aria-label", `Ver curso ${i + 1} de ${itens.length}`);
      b.addEventListener("click", () => centralizar(li));
      pontos.appendChild(b);
      return b;
    });
    lista.after(pontos);
    lista.classList.add("is-carrossel");

    function alvoDe(li) {
      const caixa = lista.getBoundingClientRect();
      const r = li.getBoundingClientRect();
      return lista.scrollLeft + (r.left - caixa.left) - (caixa.width - r.width) / 2;
    }
    function centralizar(li) {
      lista.scrollTo({ left: alvoDe(li), behavior: movimentoReduzido ? "auto" : "smooth" });
    }

    let ativo = -1;
    let tocando = false;
    function marcar() {
      const caixa = lista.getBoundingClientRect();
      const meio = caixa.left + caixa.width / 2;
      let melhor = 0;
      let menor = Infinity;
      itens.forEach((li, i) => {
        const r = li.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - meio);
        if (d < menor) { menor = d; melhor = i; }
      });
      if (melhor === ativo) return;
      ativo = melhor;
      itens.forEach((li, i) => li.classList.toggle("is-ativo", i === ativo));
      botoes.forEach((b, i) => {
        b.classList.toggle("is-ativo", i === ativo);
        b.setAttribute("aria-current", String(i === ativo));
      });
      // um toque leve a cada cartão que encaixa (Android)
      if (tocando) navigator.vibrate?.(6);
    }

    let pendente = false;
    lista.addEventListener("scroll", () => {
      if (pendente) return;
      pendente = true;
      requestAnimationFrame(() => { pendente = false; marcar(); });
    }, { passive: true });
    lista.addEventListener("touchstart", () => { tocando = true; }, { passive: true });
    lista.addEventListener("touchend", () => { tocando = false; }, { passive: true });
    marcar();
    window.addEventListener("resize", marcar);
    // ao soltar o arrasto do mouse, encaixa no cartão mais perto do centro
    arrastarComMouse(lista, () => { marcar(); return alvoDe(itens[ativo]); });

    // na primeira vez que aparece, os cartões dão um aceno para o lado:
    // mostra que dá para arrastar
    if (movimentoReduzido) return;
    const observador = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || !telaEstreita.matches) return;
      observador.disconnect();
      setTimeout(() => {
        if (lista.scrollLeft > 4) return;
        lista.classList.add("is-acenando");
        lista.addEventListener("animationend", () => lista.classList.remove("is-acenando"), { once: true });
      }, 500);
    }, { threshold: 0.7 });
    observador.observe(lista);
  })();

  /* ---------------------------------------------------------
     Credenciais do Gabriel como stories (celular): uma por vez sobre a
     foto, com as barras de progresso no topo do cartão. O tempo de cada
     uma é a animação da barra (CSS); quando ela termina, passa para a
     próxima. Toque à direita avança, à esquerda volta, segurar pausa.
     A lista continua inteira no HTML para leitores de tela. Com
     movimento reduzido fica a lista normal.
     --------------------------------------------------------- */
  (() => {
    const lista = $("[data-stories]");
    if (!lista || movimentoReduzido) return;
    const itens = $$(".credencial", lista);
    const caixa = document.createElement("div");
    caixa.className = "stories";
    const barras = document.createElement("div");
    barras.className = "stories__barras";
    barras.setAttribute("aria-hidden", "true");
    const listaBarras = itens.map(() => {
      const b = document.createElement("span");
      b.className = "stories__barra";
      b.appendChild(document.createElement("i"));
      barras.appendChild(b);
      return b;
    });
    lista.before(caixa);
    caixa.append(barras, lista);
    lista.classList.add("is-stories");

    let atual = 0;
    function mostrar(i) {
      const anterior = atual;
      atual = (i + itens.length) % itens.length;
      itens.forEach((li, k) => {
        li.classList.toggle("is-atual", k === atual);
        li.classList.toggle("is-saindo", k === anterior && k !== atual);
      });
      listaBarras.forEach((b, k) => {
        b.classList.toggle("is-lida", k < atual);
        b.classList.remove("is-atual");
      });
      void barras.offsetWidth; // reinicia a animação da barra
      listaBarras[atual].classList.add("is-atual");
    }
    mostrar(0);

    barras.addEventListener("animationend", (e) => {
      if (e.target.parentElement === listaBarras[atual]) mostrar(atual + 1);
    });

    let inicioToque = 0;
    caixa.addEventListener("pointerdown", () => {
      inicioToque = performance.now();
      caixa.classList.add("is-pausado");
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((tipo) => {
      caixa.addEventListener(tipo, () => caixa.classList.remove("is-pausado"));
    });
    caixa.addEventListener("click", (e) => {
      if (!telaEstreita.matches) return;
      // segurou para ler: não troca ao soltar
      if (performance.now() - inicioToque > 350) return;
      const r = caixa.getBoundingClientRect();
      mostrar(e.clientX - r.left < r.width * 0.3 ? atual - 1 : atual + 1);
    });
  })();

  /* ---------------------------------------------------------
     Revelação ao rolar
     --------------------------------------------------------- */
  const observadorRevelar = new IntersectionObserver((entradas) => {
    entradas.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("is-visto");
      observadorRevelar.unobserve(e.target);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
  $$("[data-revelar]").forEach((el) => observadorRevelar.observe(el));

  /* ---------------------------------------------------------
     Pausa das animações contínuas dos blocos fora da tela (ver style.css)
     --------------------------------------------------------- */
  const observadorPausa = new IntersectionObserver((entradas) => {
    entradas.forEach((e) => e.target.classList.toggle("is-fora", !e.isIntersecting));
  }, { rootMargin: "120px 0px" });
  $$(".faixa, .heroi, .cruzamento, .secao").forEach((el) => observadorPausa.observe(el));

  /* ---------------------------------------------------------
     Dock: aparece quando nenhum bloco com botão de cadastro está na tela
     --------------------------------------------------------- */
  const dock = $("#dock");
  const botaoDock = $(".botao", dock);
  const estadoDock = { botaoVisivel: true, leadAberto: false };

  function atualizarDock() {
    const mostrar = !estadoDock.botaoVisivel && !estadoDock.leadAberto;
    dock.classList.toggle("is-visivel", mostrar);
    dock.setAttribute("aria-hidden", String(!mostrar));
    botaoDock.tabIndex = mostrar ? 0 : -1;
  }

  function ajustarEspacoDock() {
    document.body.style.setProperty("--espaco-dock", telaCelular.matches ? "84px" : "0px");
  }
  ajustarEspacoDock();
  telaCelular.addEventListener?.("change", ajustarEspacoDock);

  const blocosVisiveis = new Set();
  const observadorBotoes = new IntersectionObserver((entradas) => {
    entradas.forEach((e) => {
      if (e.isIntersecting) blocosVisiveis.add(e.target);
      else blocosVisiveis.delete(e.target);
    });
    estadoDock.botaoVisivel = blocosVisiveis.size > 0;
    atualizarDock();
  });
  $$("[data-cta-bloco]").forEach((el) => observadorBotoes.observe(el));

  /* ---------------------------------------------------------
     Voltar ao topo: aparece depois da primeira tela; o anel em volta
     mostra quanto da página já foi lido. No celular sobe para ficar acima
     do dock quando ele aparece (CSS).
     --------------------------------------------------------- */
  (() => {
    const botao = $("#topo-botao");
    const lido = $(".topo__lido", botao);
    let pendente = false;
    const medir = () => {
      pendente = false;
      const maximo = document.documentElement.scrollHeight - window.innerHeight;
      const fracao = maximo > 0 ? Math.min(1, window.scrollY / maximo) : 0;
      lido.style.strokeDashoffset = (100 - fracao * 100).toFixed(2);
      const mostrar = window.scrollY > window.innerHeight;
      botao.classList.toggle("is-visivel", mostrar);
      botao.tabIndex = mostrar ? 0 : -1;
    };
    window.addEventListener("scroll", () => {
      if (pendente) return;
      pendente = true;
      requestAnimationFrame(medir);
    }, { passive: true });
    medir();

    botao.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: movimentoReduzido ? "auto" : "smooth" });
      // o foco volta para o começo da página (leitores de tela e teclado)
      $("#heroi-titulo").focus({ preventScroll: true });
      empurrarEvento("voltar_topo");
    });
  })();

  /* ---------------------------------------------------------
     Foco de rolagem (telas de toque): sem hover, o cartão que passa pela
     faixa do meio da tela recebe o mesmo realce do ponteiro (ver is-foco)
     --------------------------------------------------------- */
  if (!ponteiroFino) {
    const observadorFoco = new IntersectionObserver((entradas) => {
      entradas.forEach((e) => e.target.classList.toggle("is-foco", e.isIntersecting));
    }, { rootMargin: "-40% 0px -40% 0px" });
    $$(".quadro, .recurso, .rotina, .indicador, .cf-cartao").forEach((el) => observadorFoco.observe(el));
  }

  /* ---------------------------------------------------------
     Formulário lateral / folha inferior
     --------------------------------------------------------- */
  const lead = $("#lead");
  const painelLead = $(".lead__painel", lead);
  const form = $("#form-lead");
  const etapaForm = $('[data-etapa="form"]', lead);
  const etapaSucesso = $('[data-etapa="sucesso"]', lead);
  const etapaAviso = $('[data-etapa="aviso"]', lead);
  const etapas = { form: etapaForm, sucesso: etapaSucesso, aviso: etapaAviso };
  const botaoEnviar = $("#lead-enviar");
  const falha = $("#lead-falha");
  const CHAVE_LEAD = "cf_black_pf_lead";
  // intervalo da contagem do aviso até o destino (null fora dela)
  let contagemDestino = null;
  let origemCta = "";
  let focoAnterior = null;
  let historicoEmpilhado = false;

  const campos = {
    nome: $("#lead-nome"),
    email: $("#lead-email"),
    telefone: $("#lead-telefone"),
  };

  function focaveis() {
    return $$('a[href], button:not([disabled]), input:not([tabindex="-1"]), [tabindex="0"]', painelLead)
      .filter((el) => el.offsetParent !== null && !el.closest("[hidden]"));
  }

  function abrirLead(origem) {
    origemCta = origem || "desconhecido";
    focoAnterior = document.activeElement;

    // sempre o formulário, mesmo para quem já se cadastrou: cada envio
    // termina no destino (Typeform), com os dados da vez. Durante a contagem
    // para o destino, a gaveta reabre no aviso
    if (!contagemDestino) mostrarEtapa("form");

    lead.inert = false;
    lead.classList.add("is-aberto");
    document.body.classList.add("lead-aberto");
    estadoDock.leadAberto = true;
    atualizarDock();

    if (!historicoEmpilhado) {
      history.pushState({ lead: true }, "");
      historicoEmpilhado = true;
    }

    // no celular, focar o campo abriria o teclado por cima da animação
    setTimeout(() => {
      if (!etapaForm.hidden && !telaCelular.matches) campos.nome.focus({ preventScroll: true });
      else painelLead.focus({ preventScroll: true });
    }, 380);

    particulasLead?.iniciar();
    empurrarEvento("lead_form_aberto", { cta: origemCta });
  }

  function fecharLead({ pelaNavegacao = false } = {}) {
    if (!lead.classList.contains("is-aberto")) return;
    lead.classList.remove("is-aberto");
    lead.inert = true;
    document.body.classList.remove("lead-aberto");
    painelLead.style.setProperty("--arrasto", "0px");
    particulasLead?.parar();
    estadoDock.leadAberto = false;
    atualizarDock();

    if (historicoEmpilhado) {
      historicoEmpilhado = false;
      if (!pelaNavegacao && history.state?.lead) history.back();
    }
    focoAnterior?.focus?.({ preventScroll: true });
  }

  window.addEventListener("popstate", () => {
    if (lead.classList.contains("is-aberto")) {
      historicoEmpilhado = false;
      fecharLead({ pelaNavegacao: true });
    }
  });

  document.addEventListener("click", (e) => {
    // cartões da primeira dobra: a rolagem até a oferta é do próprio link
    const ir = e.target.closest("[data-ir-para]");
    if (ir) empurrarEvento("oferta_heroi_clique", { cta: ir.dataset.irPara });

    const abrir = e.target.closest("[data-abrir-lead]");
    if (abrir) {
      e.preventDefault();
      abrirLead(abrir.dataset.abrirLead);
      return;
    }
    if (e.target.closest("[data-fechar-lead]")) fecharLead();
  });

  lead.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      fecharLead();
      return;
    }
    if (e.key !== "Tab") return;
    const lista = focaveis();
    if (!lista.length) return;
    const primeiro = lista[0];
    const ultimo = lista[lista.length - 1];
    if (e.shiftKey && (document.activeElement === primeiro || document.activeElement === painelLead)) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && document.activeElement === ultimo) {
      e.preventDefault();
      primeiro.focus();
    }
  });

  /* arrastar para baixo fecha a folha no celular */
  (() => {
    const alcas = [$(".lead__alca", lead), $(".lead__faixa", lead)];
    let inicioY = 0;
    let inicioT = 0;
    let deslocamento = 0;
    let arrastando = false;

    const mover = (e) => {
      if (!arrastando) return;
      deslocamento = Math.max(0, e.clientY - inicioY);
      painelLead.style.setProperty("--arrasto", `${deslocamento}px`);
    };
    const soltar = () => {
      if (!arrastando) return;
      arrastando = false;
      painelLead.classList.remove("is-arrastando");
      const velocidade = deslocamento / Math.max(1, performance.now() - inicioT);
      if (deslocamento > 110 || velocidade > 0.7) fecharLead();
      else painelLead.style.setProperty("--arrasto", "0px");
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
      window.removeEventListener("pointercancel", soltar);
    };

    alcas.forEach((alca) => alca?.addEventListener("pointerdown", (e) => {
      if (!telaCelular.matches || e.button > 0) return;
      arrastando = true;
      inicioY = e.clientY;
      inicioT = performance.now();
      deslocamento = 0;
      painelLead.classList.add("is-arrastando");
      window.addEventListener("pointermove", mover);
      window.addEventListener("pointerup", soltar);
      window.addEventListener("pointercancel", soltar);
    }));
  })();

  /* ---- máscara e validação ---- */
  const soDigitos = (v) => v.replace(/\D/g, "");

  function formatarTelefone(valor) {
    let d = soDigitos(valor);
    if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
    d = d.slice(0, 11);
    if (d.length <= 2) return d.length ? `(${d}` : "";
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  campos.telefone.addEventListener("input", () => {
    const el = campos.telefone;
    const digitosAntes = soDigitos(el.value.slice(0, el.selectionStart)).length;
    el.value = formatarTelefone(el.value);
    // recoloca o cursor depois do mesmo número de dígitos
    let pos = 0;
    let contados = 0;
    while (pos < el.value.length && contados < digitosAntes) {
      if (/\d/.test(el.value[pos])) contados++;
      pos++;
    }
    el.setSelectionRange(pos, pos);
  });

  const validadores = {
    nome(v) {
      const t = v.trim().replace(/\s+/g, " ");
      if (!t) return "Informe seu nome.";
      if (t.length < 3 || !/[A-Za-zÀ-ÿ]{2,}/.test(t)) return "Digite seu nome completo.";
      return "";
    },
    email(v) {
      const t = v.trim();
      if (!t) return "Informe seu e-mail.";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) return "Confira o e-mail: parece incompleto.";
      return "";
    },
    telefone(v) {
      const d = soDigitos(v);
      if (!d) return "Informe seu WhatsApp com DDD.";
      if (d.length < 10) return "Número incompleto. Inclua o DDD.";
      if (Number(d.slice(0, 2)) < 11) return "DDD inválido.";
      if (d.length === 11 && d[2] !== "9") return "Celular com 11 dígitos começa com 9 depois do DDD.";
      return "";
    },
  };

  function validarCampo(nome, mostrar = true) {
    const el = campos[nome];
    const mensagem = validadores[nome](el.value);
    const caixa = el.closest(".campo");
    if (mostrar) {
      caixa.classList.toggle("is-invalido", Boolean(mensagem));
      caixa.classList.toggle("is-valido", !mensagem);
      el.setAttribute("aria-invalid", String(Boolean(mensagem)));
      $(".campo__erro", caixa).textContent = mensagem;
    }
    return !mensagem;
  }

  Object.keys(campos).forEach((nome) => {
    const el = campos[nome];
    el.addEventListener("blur", () => { if (el.value) validarCampo(nome); });
    el.addEventListener("input", () => {
      if (el.closest(".campo").classList.contains("is-invalido")) validarCampo(nome);
      falha.textContent = "";
    });
  });

  /* ---- envio ---- */
  function celularLocal(telefone) {
    const d = soDigitos(telefone);
    return d.startsWith("55") && d.length > 11 ? d.slice(2) : d;
  }

  // Independente do envio ao n8n: um caminho fora do ar não leva o outro junto.
  // sendBeacon sobrevive à troca de página para o Typeform; nunca lança erro.
  function enviarDataGateway(corpo) {
    try {
      if (navigator.sendBeacon?.(CONFIG.dataGateway, corpo)) return;
      fetch(CONFIG.dataGateway, { method: "POST", mode: "no-cors", body: corpo, keepalive: true }).catch(() => {});
    } catch {
      /* a cópia é extra; o cadastro segue pelo n8n */
    }
  }

  async function enviarLead({ nome, email, telefone }) {
    const corpo = new URLSearchParams({
      "Nome:": nome,
      "E-mail:": email,
      "Celular:": celularLocal(telefone),
      ...CONFIG.identidade,
      utm_source: atribuicao.utm_source,
      utm_medium: atribuicao.utm_medium,
      utm_term: atribuicao.utm_term,
      utm_content: atribuicao.utm_content,
      utm_campaign: atribuicao.utm_campaign,
      "Full URL": atribuicao.urlCompleta,
      form_id: CONFIG.formId,
      form_name: CONFIG.formNome,
      cta_origem: origemCta,
    });

    enviarDataGateway(corpo);

    const controle = new AbortController();
    const limite = setTimeout(() => controle.abort(), CONFIG.tempoLimiteEnvioMs);
    try {
      // "no-cors": o n8n não devolve cabeçalhos CORS; a resposta fica opaca,
      // mas o envio acontece. Só falhas de rede chegam até o catch.
      await fetch(CONFIG.webhook, {
        method: "POST",
        mode: "no-cors",
        body: corpo,
        keepalive: true,
        signal: controle.signal,
      });
    } finally {
      clearTimeout(limite);
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    falha.textContent = "";

    const validos = Object.keys(campos).map((n) => validarCampo(n));
    if (validos.includes(false)) {
      const primeiroInvalido = Object.keys(campos)[validos.indexOf(false)];
      campos[primeiroInvalido].focus();
      return;
    }

    const dados = {
      nome: campos.nome.value.trim().replace(/\s+/g, " "),
      email: campos.email.value.trim().toLowerCase(),
      telefone: campos.telefone.value,
    };

    // robô preencheu o campo invisível: finge sucesso e não envia
    if ($("#lead-site").value) {
      concluir(dados);
      return;
    }

    botaoEnviar.classList.add("is-carregando");
    botaoEnviar.setAttribute("aria-busy", "true");
    try {
      await enviarLead(dados);
      empurrarEvento(CONFIG.eventoCadastro, { cta: origemCta, lead_origin: CONFIG.identidade.lead_origin });
      rastreio.cadastro({ ...dados, telefone: celularLocal(dados.telefone), cta: origemCta });
      if (CONFIG.destinoPosCadastro) avisarEIrAoDestino(dados);
      else concluir(dados);
    } catch {
      falha.textContent = "Não conseguimos enviar agora. Confira sua conexão e tente de novo.";
    } finally {
      botaoEnviar.classList.remove("is-carregando");
      botaoEnviar.removeAttribute("aria-busy");
    }
  });

  // aviso na gaveta com contagem regressiva e, no fim, o destino. Fechar a
  // gaveta não cancela; "Responder agora" adianta
  function avisarEIrAoDestino(dados) {
    const url = urlPosCadastro(dados);
    const registro = { nome: dados.nome, em: new Date().toISOString() };
    armazenamento.gravar(CHAVE_LEAD, registro);

    const contagem = $("#lead-contagem");
    const unidade = $("#lead-contagem-unidade");
    let restante = CONFIG.esperaDestinoS;
    const escreverRestante = () => {
      contagem.textContent = restante;
      unidade.textContent = restante === 1 ? "segundo" : "segundos";
    };
    escreverRestante();
    etapaAviso.style.setProperty("--espera", `${CONFIG.esperaDestinoS}s`);
    $("#lead-ir-agora").href = url;
    mostrarEtapa("aviso", registro);
    comemorar(etapaAviso);

    clearInterval(contagemDestino);
    contagemDestino = setInterval(() => {
      restante -= 1;
      if (restante > 0) {
        escreverRestante();
        return;
      }
      clearInterval(contagemDestino);
      contagemDestino = null;
      location.assign(url);
    }, 1000);
  }

  $("#lead-ir-agora").addEventListener("click", () => {
    clearInterval(contagemDestino);
    contagemDestino = null;
  });

  // endereço no formato combinado com o Typeform: as 5 UTMs da sessão na
  // query (vazias também vão) e, depois do "#", os campos ocultos com os
  // dados do cadastro e a identidade; phone só com dígitos e com o 55 na
  // frente (5511999990000)
  // (encodeURIComponent e não URLSearchParams: espaço vira %20, não "+")
  function urlPosCadastro({ nome, email, telefone }) {
    const juntar = (pares) => pares.map(([c, v]) => `${c}=${encodeURIComponent(v)}`).join("&");
    const query = juntar(
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].map((c) => [c, atribuicao[c]])
    );
    const hash = juntar([
      ["name", nome],
      ["phone", `55${celularLocal(telefone)}`],
      ["email", email],
      ["lead_product_interest", CONFIG.identidade.lead_product_interest],
      ["event_name", CONFIG.identidade.event_name],
      ["lead_origin", CONFIG.identidade.lead_origin],
    ]);
    return `${CONFIG.destinoPosCadastro}?${query}#${hash}`;
  }

  // voltou do destino pelo "voltar" do navegador (página restaurada do
  // cache): solta o botão e mostra a confirmação em vez do formulário
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    clearInterval(contagemDestino);
    contagemDestino = null;
    botaoEnviar.classList.remove("is-carregando");
    botaoEnviar.removeAttribute("aria-busy");
    const registro = armazenamento.ler(CHAVE_LEAD);
    if (registro) mostrarEtapa("sucesso", registro);
  });

  function concluir(dados) {
    const registro = { nome: dados.nome, em: new Date().toISOString() };
    armazenamento.gravar(CHAVE_LEAD, registro);
    mostrarEtapa("sucesso", registro);
    comemorar(etapaSucesso);
  }

  function comemorar(etapa) {
    navigator.vibrate?.(35);
    const marca = $(".sucesso__marca", etapa);
    requestAnimationFrame(() => {
      const r = marca.getBoundingClientRect();
      brasas?.explodir(r.left + r.width / 2, r.top + r.height / 2);
    });
  }

  function mostrarEtapa(qual, registro) {
    Object.entries(etapas).forEach(([nome, el]) => { el.hidden = nome !== qual; });
    if (qual === "form") return;
    const etapa = etapas[qual];
    const primeiroNome = (registro?.nome || "").split(" ")[0];
    $("[data-lead-nome]", etapa).textContent = primeiroNome ? `${primeiroNome}, seu lugar está garantido.` : "Seu lugar está garantido.";
    // reinicia as animações de desenho do "check" (e a barra do aviso)
    etapa.style.animation = "none";
    $$(".sucesso__marca circle, .sucesso__marca path, .aviso__barra > span", etapa).forEach((el) => {
      el.style.animation = "none";
      void el.getBoundingClientRect();
      el.style.animation = "";
    });
    void etapa.offsetWidth;
    etapa.style.animation = "";
    if (lead.classList.contains("is-aberto")) {
      setTimeout(() => $(".lead__titulo", etapa).focus({ preventScroll: true }), 60);
    }
  }

  $("#lead-outro").addEventListener("click", () => {
    armazenamento.remover(CHAVE_LEAD);
    form.reset();
    $$(".campo", form).forEach((c) => {
      c.classList.remove("is-invalido", "is-valido");
      $(".campo__erro", c).textContent = "";
    });
    mostrarEtapa("form");
    campos.nome.focus();
  });

  /* ---------------------------------------------------------
     Partículas atrás do formulário

     Nascem rente à borda do painel que fica exposta (a esquerda da gaveta
     no computador, o topo da folha no celular) e se afastam devagar. O
     canvas fica entre o véu e o painel, então elas parecem sair de trás dele.
     --------------------------------------------------------- */
  const particulasLead = movimentoReduzido ? null : (() => {
    const canvas = $(".lead__particulas", lead);
    const ctx = canvas.getContext("2d");
    const lista = [];
    const RAJADA_MS = 1100;
    let largura = 0;
    let altura = 0;
    let ativo = false;
    let rodando = false;
    let inicio = 0;
    let ultimo = 0;

    function redimensionar() {
      const dpr = Math.min(window.devicePixelRatio || 1, dprMaximo);
      largura = window.innerWidth;
      altura = window.innerHeight;
      canvas.width = Math.round(largura * dpr);
      canvas.height = Math.round(altura * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function nascer(borda, naRajada) {
      const impulso = naRajada ? 1.6 : 0.7;
      const p = {
        raio: 0.7 + Math.random() * 2,
        vida: 0,
        duracao: 110 + Math.random() * 150,
        tom: 26 + Math.random() * 18,
        fase: Math.random() * Math.PI * 2,
      };
      if (telaCelular.matches) {
        p.x = borda.left + Math.random() * borda.width;
        p.y = borda.top + 8;
        p.vx = (Math.random() - 0.5) * 0.5;
        p.vy = -(0.3 + Math.random() * impulso);
      } else {
        p.x = borda.left + 8;
        p.y = borda.top + Math.random() * borda.height;
        p.vx = -(0.3 + Math.random() * impulso);
        p.vy = (Math.random() - 0.5) * 0.4 - 0.12;
      }
      return p;
    }

    function quadro(agora) {
      // passo em "quadros de 60 Hz": mesma velocidade em telas de 60, 120 ou 144 Hz
      const k = Math.min(3, (agora - ultimo) / (1000 / 60));
      ultimo = agora;
      ctx.clearRect(0, 0, largura, altura);

      if (ativo) {
        const borda = painelLead.getBoundingClientRect();
        const naRajada = agora - inicio < RAJADA_MS;
        // rajada na abertura, depois um fio contínuo e discreto
        let taxa = (naRajada ? 1.8 : 0.22) * k;
        while (taxa > 0) {
          if (Math.random() < taxa) lista.push(nascer(borda, naRajada));
          taxa -= 1;
        }
      }

      const atrito = Math.pow(0.99, k);
      ctx.globalCompositeOperation = "lighter";
      for (let i = lista.length - 1; i >= 0; i--) {
        const p = lista[i];
        p.vida += k;
        const t = p.vida / p.duracao;
        if (t >= 1) { lista.splice(i, 1); continue; }

        p.vx *= atrito;
        p.vy = p.vy * atrito - 0.003 * k; // sobe de leve, como calor
        p.x += (p.vx + Math.sin(p.vida / 22 + p.fase) * 0.12) * k;
        p.y += p.vy * k;

        const cintilar = 0.75 + Math.sin(p.vida * 0.18 + p.fase) * 0.25;
        const alfa = Math.sin(Math.PI * t) * cintilar;

        ctx.fillStyle = `hsla(${p.tom}, 100%, 60%, ${alfa * 0.1})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.raio * 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `hsla(${p.tom + 8}, 100%, 78%, ${alfa * 0.6})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.raio, 0, Math.PI * 2);
        ctx.fill();
      }

      if (ativo || lista.length) requestAnimationFrame(quadro);
      else rodando = false;
    }

    window.addEventListener("resize", () => { if (rodando) redimensionar(); });

    return {
      iniciar() {
        ativo = true;
        inicio = performance.now();
        if (!rodando) {
          ultimo = inicio;
          redimensionar();
          rodando = true;
          requestAnimationFrame(quadro);
        }
      },
      parar() { ativo = false; },
    };
  })();

  /* ---------------------------------------------------------
     Brasas (canvas): sobem atrás do conteúdo enquanto a página está à vista
     --------------------------------------------------------- */
  const brasas = movimentoReduzido ? null : (() => {
    const canvas = $("#brasas");
    const ctx = canvas.getContext("2d");
    const particulas = [];
    let largura = 0;
    let altura = 0;
    let dpr = 1;
    let alvoQuantidade = 0;
    let rodando = false;
    let ultimo = 0;

    function redimensionar() {
      const novaLargura = canvas.clientWidth;
      const novaAltura = canvas.clientHeight;
      const novoDpr = Math.min(window.devicePixelRatio || 1, dprMaximo);
      if (novaLargura === largura && novaAltura === altura && novoDpr === dpr) return;
      dpr = novoDpr;
      largura = novaLargura;
      altura = novaAltura;
      canvas.width = Math.round(largura * dpr);
      canvas.height = Math.round(altura * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      alvoQuantidade = Math.round(Math.min(56, Math.max(18, (largura * altura) / 28000)));
    }

    function criar(x, y, explosao = false) {
      const angulo = explosao ? Math.random() * Math.PI * 2 : -Math.PI / 2 + (Math.random() - 0.5) * 0.6;
      const velocidade = explosao ? 1.5 + Math.random() * 4 : 0.25 + Math.random() * 0.7;
      return {
        x: x ?? Math.random() * largura,
        y: y ?? altura + 10 + Math.random() * altura * 0.3,
        vx: Math.cos(angulo) * velocidade,
        vy: Math.sin(angulo) * velocidade,
        raio: explosao ? 1 + Math.random() * 2.4 : 0.6 + Math.random() * 1.9,
        vida: 0,
        duracao: explosao ? 50 + Math.random() * 50 : 280 + Math.random() * 380,
        fase: Math.random() * Math.PI * 2,
        tom: 18 + Math.random() * 22,
        explosao,
      };
    }

    function acordar() {
      if (rodando || document.hidden) return;
      rodando = true;
      ultimo = performance.now();
      requestAnimationFrame(quadro);
    }

    function quadro(agora) {
      if (document.hidden) { rodando = false; return; }
      // passo em "quadros de 60 Hz": mesma velocidade em telas de 60, 120 ou 144 Hz
      const k = Math.min(3, Math.max(0, (agora - ultimo) / (1000 / 60)));
      ultimo = agora;
      ctx.clearRect(0, 0, largura, altura);
      ctx.globalCompositeOperation = "lighter";

      const comuns = particulas.reduce((n, p) => n + (p.explosao ? 0 : 1), 0);
      if (comuns < alvoQuantidade && Math.random() < 0.35 * k) particulas.push(criar());

      const atrito = Math.pow(0.94, k);
      for (let i = particulas.length - 1; i >= 0; i--) {
        const p = particulas[i];
        p.vida += k;
        if (p.explosao) {
          p.vx *= atrito;
          p.vy = p.vy * atrito - 0.03 * k;
        } else {
          p.vx += Math.sin((p.vida + p.fase * 60) / 50) * 0.012 * k;
        }
        p.x += p.vx * k;
        p.y += p.vy * k;

        const t = p.vida / p.duracao;
        if (t >= 1 || p.y < -20) { particulas.splice(i, 1); continue; }

        const cintilar = 0.65 + Math.sin(p.vida * 0.25 + p.fase) * 0.35;
        const alfa = Math.sin(Math.PI * t) * cintilar * (p.explosao ? 1 : 0.8);

        ctx.fillStyle = `hsla(${p.tom}, 100%, 55%, ${alfa * 0.18})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.raio * 4.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `hsla(${p.tom + 10}, 100%, ${70 + cintilar * 15}%, ${alfa})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.raio, 0, Math.PI * 2);
        ctx.fill();
      }
      requestAnimationFrame(quadro);
    }

    redimensionar();
    for (let i = 0; i < alvoQuantidade * 0.6; i++) {
      const p = criar(undefined, Math.random() * altura);
      p.vida = Math.random() * p.duracao * 0.6;
      particulas.push(p);
    }
    acordar();

    let esperaRedimensionar;
    window.addEventListener("resize", () => {
      clearTimeout(esperaRedimensionar);
      esperaRedimensionar = setTimeout(redimensionar, 150);
    });
    document.addEventListener("visibilitychange", acordar);

    return {
      explodir(x, y) {
        for (let i = 0; i < 46; i++) particulas.push(criar(x, y, true));
        acordar();
      },
    };
  })();

  /* ---------------------------------------------------------
     Microinterações de ponteiro (só mouse/trackpad)
     --------------------------------------------------------- */
  if (ponteiroFino && !movimentoReduzido) {
    const luz = $(".luz-cursor");
    const visual = $(".heroi__visual");
    const heroi = $(".heroi");
    const ponteiro = { x: -999, y: -999 };
    const luzPos = { x: -999, y: -999 };
    const paralaxe = { x: 0, y: 0, ax: 0, ay: 0 };
    let heroiNaTela = true;

    new IntersectionObserver(([e]) => { heroiNaTela = e.isIntersecting; }).observe(heroi);

    window.addEventListener("pointermove", (e) => {
      ponteiro.x = e.clientX;
      ponteiro.y = e.clientY;
      if (luzPos.x === -999) { luzPos.x = e.clientX; luzPos.y = e.clientY; }
      luz.classList.add("is-ativa");
      paralaxe.ax = (e.clientX / window.innerWidth - 0.5) * 2;
      paralaxe.ay = (e.clientY / window.innerHeight - 0.5) * 2;
    }, { passive: true });

    document.addEventListener("pointerleave", () => luz.classList.remove("is-ativa"));

    (function suavizar() {
      luzPos.x += (ponteiro.x - luzPos.x) * 0.12;
      luzPos.y += (ponteiro.y - luzPos.y) * 0.12;
      luz.style.setProperty("--cx", `${luzPos.x}px`);
      luz.style.setProperty("--cy", `${luzPos.y}px`);

      if (heroiNaTela) {
        paralaxe.x += (paralaxe.ax - paralaxe.x) * 0.06;
        paralaxe.y += (paralaxe.ay - paralaxe.y) * 0.06;
        visual.style.setProperty("--mx", paralaxe.x.toFixed(3));
        visual.style.setProperty("--my", paralaxe.y.toFixed(3));
      }
      requestAnimationFrame(suavizar);
    })();

    // holofote nos cartões
    $$(".oferta, .quadro, .pos-cartao, .indicador, .recurso, .rotina, .cf-cartao, .credencial").forEach((cartao) => {
      cartao.addEventListener("pointermove", (e) => {
        const r = cartao.getBoundingClientRect();
        cartao.style.setProperty("--mx", `${e.clientX - r.left}px`);
        cartao.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    });

    // paralaxe de rolagem no pôster
    let pendente = false;
    window.addEventListener("scroll", () => {
      if (pendente) return;
      pendente = true;
      requestAnimationFrame(() => {
        pendente = false;
        const y = Math.min(window.scrollY, window.innerHeight * 1.2);
        visual.style.setProperty("--sy", y.toFixed(1));
      });
    }, { passive: true });
  }
})();
