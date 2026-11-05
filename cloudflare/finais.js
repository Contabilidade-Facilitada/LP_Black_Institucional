/**
 * Páginas finais do Typeform da Black (pedido do Matheus Rabelo, 05/11/2026;
 * texto do documento "Páginas Typeform" do time de copy).
 *
 * O Typeform separa o lead pela pontuação (tela A: 0 a 78, menos qualificado;
 * tela B: 79 a 200, mais qualificado) e pela resposta sobre antecipar a
 * matrícula. Cada combinação leva a um endereço:
 *
 *   /final/a/antecipar   menos qualificado, quer antecipar
 *   /final/a/esperar     menos qualificado, não quer antecipar
 *   /final/b/antecipar   mais qualificado, quer antecipar
 *   /final/b/esperar     mais qualificado, não quer antecipar
 *
 * As quatro usam o mesmo arquivo (final/index.html). O Worker mantém só o
 * texto da página pedida (data-so-pagina) e põe nos botões os links do grupo
 * de qualificação (A ou B): a otimização do tráfego pago é feita pelo link do
 * botão, então cada grupo tem o seu.
 *
 * O foco é levar a pessoa ao grupo de WhatsApp. Na página B·antecipar o
 * botão principal é "Falar com especialista" (comercial), e o grupo vem
 * depois.
 *
 * Trocar um link aqui e publicar (push) basta: nada mais no código depende
 * deles. Link vazio deixa o botão desativado (e sem QR Code), com aviso no
 * console.
 */

export const LINKS_FINAIS = {
  a: {
    // PENDENTE: link do grupo de WhatsApp dos leads A (0 a 78)
    grupo: "",
  },
  b: {
    // PENDENTE: link do grupo de WhatsApp dos leads B (79 a 200)
    grupo: "",
    // PENDENTE: link do especialista (só aparece em /final/b/antecipar)
    especialista: "",
  },
};

export const GRUPOS_FINAIS = ["a", "b"];
export const INTENCOES_FINAIS = ["antecipar", "esperar"];

// "a/antecipar", "a/esperar", "b/antecipar", "b/esperar"
export const PAGINAS_FINAIS = GRUPOS_FINAIS.flatMap((g) => INTENCOES_FINAIS.map((i) => `${g}/${i}`));

// tipos de botão (data-link no modelo); os mesmos nomes viram os eventos
// clique_grupo e clique_especialista
export const TIPOS_LINK = ["grupo", "especialista"];

// /final/a/antecipar (com ou sem barra no fim) -> { grupo, intencao, pagina }
export function lerPaginaFinal(caminho) {
  const m = /^\/final\/([ab])\/(antecipar|esperar)\/?$/i.exec(caminho);
  if (!m) return null;
  const grupo = m[1].toLowerCase();
  const intencao = m[2].toLowerCase();
  return { grupo, intencao, pagina: `${grupo}/${intencao}` };
}

// só http(s): um link digitado errado aqui nunca vira javascript: na página
export function linkSeguro(endereco) {
  try {
    const u = new URL(String(endereco || ""));
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
}
