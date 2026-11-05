/**
 * Páginas finais do Typeform da Black (pedido do Matheus Rabelo, 05/11/2026).
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
 * As quatro usam o mesmo arquivo (final/index.html). O Worker escolhe o texto
 * pela intenção (antecipar ou esperar) e põe nos botões os links do grupo
 * (A ou B): a otimização do tráfego pago é feita pelo link do botão, então
 * cada grupo de qualificação tem o seu.
 *
 * O foco é levar a pessoa ao grupo de WhatsApp. Nas páginas "antecipar" há
 * também um link secundário para a compra; vazio, ele some da página.
 *
 * Trocar um link aqui e publicar (push) basta: nada mais no código depende
 * deles. Link de grupo vazio deixa o botão desativado, com aviso no console.
 */

export const LINKS_FINAIS = {
  a: {
    // PENDENTE: link do grupo de WhatsApp dos leads A (0 a 78)
    grupo: "",
    // PENDENTE: link de compra (só aparece nas páginas "antecipar")
    compra: "",
  },
  b: {
    // PENDENTE: link do grupo de WhatsApp dos leads B (79 a 200)
    grupo: "",
    // PENDENTE: link de compra (só aparece nas páginas "antecipar")
    compra: "",
  },
};

export const GRUPOS_FINAIS = ["a", "b"];
export const INTENCOES_FINAIS = ["antecipar", "esperar"];

// "a/antecipar", "a/esperar", "b/antecipar", "b/esperar"
export const PAGINAS_FINAIS = GRUPOS_FINAIS.flatMap((g) => INTENCOES_FINAIS.map((i) => `${g}/${i}`));

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
