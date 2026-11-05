/* =========================================================
   Páginas finais do Typeform — medição (ver cloudflare/finais.js)

   Grava em /api/final (tabela finais_pf, separada das da LP: os números da
   LP no painel e no Data Gateway não mudam) o acesso, os cliques nos botões
   e o tempo com a página visível. Também empurra os cliques para o
   dataLayer, para as conversões do GTM:
     final_clique_grupo   botão do grupo de WhatsApp
     final_clique_compra  link secundário de compra (páginas "antecipar")
   Cada evento leva pagina_final, grupo_lead e intencao_lead (as mesmas
   variáveis empurradas no <head>, antes do GTM).

   O visitante é o mesmo identificador da LP (mesmo domínio, mesma chave):
   quem se cadastrou na LP Institucional aparece ligado ao cadastro no
   painel. Quem veio da Esquenta Black (outro domínio) chega como visitante
   novo; a origem dele vem do lead_origin que o Typeform repassa na URL.
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
    const tipo = link.dataset.link === "compra" ? "compra" : "grupo";
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
