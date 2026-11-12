/* =========================================================
   Páginas finais do Typeform — medição e QR Code (ver cloudflare/finais.js)

   Grava em /api/final (tabela finais_pf, separada das da LP: os números da
   LP no painel e no Data Gateway não mudam) o acesso, os cliques nos botões
   e o tempo com a página visível. Também empurra os cliques para o
   dataLayer, para as conversões do GTM:
     final_clique_grupo         botão do grupo de WhatsApp
   Cada evento leva pagina_final, grupo_lead e intencao_lead (as mesmas
   variáveis empurradas no <head>, antes do GTM).

   O visitante é o mesmo identificador da LP (mesmo domínio, mesma chave):
   quem se cadastrou na LP Institucional aparece ligado ao cadastro no
   painel. Quem veio da Esquenta Black (outro domínio) chega como visitante
   novo; a origem dele vem do lead_origin que o Typeform repassa na URL.

   No computador, cada botão tem ao lado um ícone de QR Code que abre o QR
   do seu link numa janela flutuante, para abrir pelo celular (pedido do
   time de copy). Evento: final_qr_grupo.
   ========================================================= */
(() => {
  "use strict";

  const DESTINO = "/api/final";
  const raiz = document.documentElement;
  const pagina = raiz.dataset.pagina || "";
  const grupo = raiz.dataset.grupo || "";
  const intencao = raiz.dataset.intencao || "";
  // aberto fora do Worker (arquivo solto): não mede nada
  if (!/^[ab]\/(antecipar|esperar)$/.test(pagina)) return;

  /* ---------------- QR Code de cada link (só computador) ----------------
     Ao lado de cada botão há um ícone de QR; o clique abre a janela
     flutuante (#qr-janela) com o QR Code do link daquele botão. Sem link
     configurado (botão .is-pendente), a janela mostra um QR de modelo, com
     aviso. A biblioteca (qrcode.js) só é baixada no primeiro clique. */
  const computador = window.matchMedia("(min-width: 960px) and (hover: hover)");
  const janela = document.getElementById("qr-janela");
  const TEXTOS_QR = {
    grupo: { titulo: "Entre pelo celular", legenda: "Aponte a câmera do celular para entrar no grupo do WhatsApp." },
    especialista: { titulo: "Fale pelo celular", legenda: "Aponte a câmera do celular para falar com um especialista." },
  };
  const QR_MODELO = "Modelo de QR Code: link ainda não configurado.";

  function mostrarIconesQr() {
    document.querySelectorAll(".qr-botao").forEach((b) => { b.hidden = !computador.matches || !janela?.showModal; });
  }
  mostrarIconesQr();
  computador.addEventListener?.("change", () => {
    mostrarIconesQr();
    if (!computador.matches && janela?.open) janela.close();
  });

  let biblioteca = null;
  function carregarBiblioteca() {
    biblioteca ||= new Promise((ok, erro) => {
      const s = document.createElement("script");
      s.src = "/final/qrcode.js?v=1.4.4";
      s.onload = () => (typeof window.qrcode === "function" ? ok(window.qrcode) : erro(new Error("qrcode.js")));
      s.onerror = erro;
      document.head.append(s);
    });
    return biblioteca;
  }

  // um <path> só, com um quadrado por módulo escuro; 2 módulos de margem
  function svgDoQr(qrcode, texto, rotulo) {
    const q = qrcode(0, "M");
    q.addData(texto);
    q.make();
    const n = q.getModuleCount();
    let d = "";
    for (let l = 0; l < n; l++) {
      for (let c = 0; c < n; c++) if (q.isDark(l, c)) d += `M${c + 2} ${l + 2}h1v1h-1z`;
    }
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${n + 4} ${n + 4}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", rotulo);
    svg.setAttribute("shape-rendering", "crispEdges");
    const caminho = document.createElementNS(NS, "path");
    caminho.setAttribute("d", d);
    caminho.setAttribute("fill", "#050403");
    svg.append(caminho);
    return svg;
  }

  async function abrirQr(tipo, botao) {
    const link = botao.closest(".acao")?.querySelector(`[data-link='${tipo}']`);
    const destino = link && !link.classList.contains("is-pendente") ? link.href : "";
    const textos = TEXTOS_QR[tipo];
    let qrcode;
    try { qrcode = await carregarBiblioteca(); } catch { biblioteca = null; return; }
    janela.querySelector("#qr-janela-titulo").textContent = textos.titulo;
    janela.querySelector("[data-qr-legenda]").textContent = textos.legenda;
    janela.querySelector("[data-qr-modelo]").hidden = Boolean(destino);
    janela.querySelector("[data-qr-codigo]").replaceChildren(
      svgDoQr(qrcode, destino || QR_MODELO, destino ? `QR Code: ${textos.legenda}` : "QR Code de modelo"),
    );
    janela.showModal();
    if (Array.isArray(window.dataLayer)) {
      window.dataLayer.push({ event: `final_qr_${tipo}`, pagina_final: pagina, grupo_lead: grupo, intencao_lead: intencao });
    }
    registrar(`qr_${tipo}`);
  }

  document.addEventListener("click", (e) => {
    const botao = e.target instanceof Element ? e.target.closest("[data-qr-para]") : null;
    if (botao && janela) abrirQr(botao.dataset.qrPara, botao);
  });
  // fecha pelo X ou pelo clique fora do cartão (no fundo escurecido). O
  // clique no fundo também chega com o próprio <dialog> como alvo, assim
  // como o clique na margem interna dele: vale a posição do ponteiro.
  janela?.addEventListener("click", (e) => {
    if (e.target.closest("[data-qr-fechar]")) { janela.close(); return; }
    const r = janela.getBoundingClientRect();
    const fora = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (e.target === janela && fora) janela.close();
  });

  /* ---------------- Luz que acompanha o mouse nos cartões (computador) ----------------
     Só atualiza --mx/--my do cartão (ver .cartao::before em final.css);
     uma vez por quadro, e nada com "reduzir movimento" ou tela de toque. */
  const semMovimento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!semMovimento && window.matchMedia("(hover: hover)").matches) {
    let quadro = 0;
    document.addEventListener("pointermove", (e) => {
      const cartao = e.target instanceof Element ? e.target.closest(".cartao") : null;
      if (!cartao || quadro) return;
      quadro = requestAnimationFrame(() => {
        quadro = 0;
        const r = cartao.getBoundingClientRect();
        cartao.style.setProperty("--mx", `${e.clientX - r.left}px`);
        cartao.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    }, { passive: true });
  }

  /* ---------------- Medição ---------------- */
  const ler = (chave, tipo) => {
    try { return JSON.parse(tipo.getItem(chave)); } catch { return null; }
  };
  const gravar = (chave, valor, tipo) => {
    try { tipo.setItem(chave, JSON.stringify(valor)); } catch { /* navegação privada */ }
  };
  const novoId = () => crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

  // mesma chave de visitante da LP (assets/js/main.js); a sessão é própria
  // destas páginas, para não se misturar com as visitas à LP
  let visitante = ler("cf_black_pf_vid", localStorage);
  if (!visitante) { visitante = novoId(); gravar("cf_black_pf_vid", visitante, localStorage); }
  const sessao = novoId();

  const url = new URLSearchParams(location.search);
  let referencia = "";
  try {
    const host = document.referrer ? new URL(document.referrer).hostname : "";
    if (host !== location.hostname) referencia = host;
  } catch { /* referrer malformado */ }
  const contexto = {
    ref: referencia,
    utm_source: url.get("utm_source") || "",
    utm_medium: url.get("utm_medium") || "",
    utm_campaign: url.get("utm_campaign") || "",
    utm_content: url.get("utm_content") || "",
    utm_term: url.get("utm_term") || "",
    // repassados pelo Typeform no endereço de redirecionamento (opcionais)
    lead_origin: url.get("lead_origin") || "",
    pontuacao: url.get("score") || url.get("pontuacao") || "",
  };

  const fila = [];
  let espera = 0;

  function enviar(saindo = false) {
    clearTimeout(espera);
    espera = 0;
    if (!fila.length) return;
    const agora = Date.now();
    const eventos = fila.splice(0, 20).map(({ t, ...e }) => ({ ...e, dt: agora - t }));
    const corpo = JSON.stringify({ v: visitante, s: sessao, p: pagina, eventos });
    if (saindo && navigator.sendBeacon?.(DESTINO, new Blob([corpo], { type: "text/plain" }))) return;
    fetch(DESTINO, { method: "POST", body: corpo, keepalive: true }).catch(() => {});
  }

  function registrar(evento, extra = {}) {
    fila.push({ e: evento, ...extra, t: Date.now() });
    if (!espera) espera = setTimeout(enviar, 1500);
  }

  registrar("page_view", { ctx: contexto });

  // cliques: o envio sai antes da troca de página (sendBeacon sobrevive a ela)
  document.addEventListener("click", (e) => {
    const link = e.target instanceof Element ? e.target.closest("[data-link]") : null;
    if (!link) return;
    if (link.classList.contains("is-pendente")) { e.preventDefault(); return; }
    const tipo = link.dataset.link === "especialista" ? "especialista" : "grupo";
    if (Array.isArray(window.dataLayer)) {
      window.dataLayer.push({
        event: `final_clique_${tipo}`,
        pagina_final: pagina,
        grupo_lead: grupo,
        intencao_lead: intencao,
        link_destino: link.href,
      });
    }
    registrar(`clique_${tipo}`);
    enviar(true);
  });

  // segundos com a página à vista, enviados ao sair ou esconder a aba (o
  // painel fica com o maior valor de cada sessão)
  let visivelMs = 0;
  let visivelDesde = document.visibilityState === "visible" ? performance.now() : 0;
  function tempoNaPagina() {
    const ms = visivelMs + (visivelDesde ? performance.now() - visivelDesde : 0);
    registrar("engajamento", { n: Math.round(ms / 1000) });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (visivelDesde) { visivelMs += performance.now() - visivelDesde; visivelDesde = 0; }
      tempoNaPagina();
      enviar(true);
    } else {
      visivelDesde = performance.now();
    }
  });
  window.addEventListener("pagehide", () => enviar(true));

  // aviso para quem testa antes de os links existirem
  document.querySelectorAll("[data-link].is-pendente").forEach((l) => {
    console.warn(`[páginas finais] link "${l.dataset.link}" do grupo ${grupo.toUpperCase()} ainda não configurado (cloudflare/finais.js).`);
  });
})();
