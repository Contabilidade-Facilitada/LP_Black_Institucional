-- Tabelas do painel /admin da Black November (PF), no mesmo banco D1 da
-- Esquenta Black ("lp-black"). Os nomes terminam em _pf para não se misturar
-- com as tabelas da Esquenta Black, que continuam como estão.
--
-- Criar uma vez: Cloudflare > Storage & Databases > D1 > lp-black > Console,
-- colar este arquivo inteiro e executar; rodar de novo depois de uma tabela
-- nova é seguro (IF NOT EXISTS não mexe nas que já existem). (Ou:
-- npx wrangler d1 execute lp-black --remote --file=cloudflare/schema.sql)
--
-- Mesmas colunas da Esquenta Black, sem "cor" (esta página não tem teste A/B).
-- As tabelas só recebem INSERT. O painel sincroniza pelo id ("me dê o que
-- veio depois do id X"), então cada atualização em tempo real lê só as linhas
-- novas, e não a tabela inteira.

-- Tudo o que acontece na página: page_view, eventos do dataLayer (GTM) e o
-- engajamento periódico. Os campos de contexto (UTMs, dispositivo, local) são
-- preenchidos só no page_view; os demais eventos se ligam a ele pela sessão.
CREATE TABLE IF NOT EXISTS eventos_pf (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,  -- milissegundos desde 1970 (UTC)
  evento       TEXT    NOT NULL,  -- page_view, lead_form_aberto, engajamento...
  visitante    TEXT,              -- identificador anônimo guardado no navegador
  sessao       TEXT,              -- identificador da aba/visita
  detalhe      TEXT,              -- cta de origem, texto clicado, % de rolagem...
  valor        INTEGER,           -- engajamento: segundos com a página visível
  pagina       TEXT,
  referencia   TEXT,              -- domínio de onde o visitante veio
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  clique       TEXT,              -- google, meta, tiktok... (gclid, fbclid, ttclid)
  dispositivo  TEXT,              -- celular, tablet, computador
  navegador    TEXT,
  sistema      TEXT,
  pais         TEXT,
  estado       TEXT,
  cidade       TEXT
);

-- Cadastros da Lista VIP. Os mesmos dados também seguem para o n8n e para o
-- Typeform; esta cópia existe para o painel.
CREATE TABLE IF NOT EXISTS cadastros_pf (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  nome         TEXT,
  email        TEXT,
  telefone     TEXT,              -- só dígitos, sem o 55
  visitante    TEXT,
  sessao       TEXT,
  cta          TEXT,              -- botão que abriu o formulário
  referencia   TEXT,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  clique       TEXT,
  url          TEXT,              -- URL completa da primeira página da sessão
  dispositivo  TEXT,
  navegador    TEXT,
  sistema      TEXT,
  pais         TEXT,
  estado       TEXT,
  cidade       TEXT
);

-- Tentativas erradas de login no painel, para o limite contra quem tenta
-- adivinhar a senha (ver cloudflare/worker.js). Separada da Esquenta Black:
-- erros num painel não fecham o login do outro. Linhas com mais de um dia são
-- apagadas a cada nova tentativa errada.
CREATE TABLE IF NOT EXISTS tentativas_pf (
  ip TEXT    NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tentativas_pf_ts ON tentativas_pf (ts);

-- Gravações das visitas, para a reprodução da aba Gravações do painel: rolagem,
-- ponteiro e abertura do formulário em texto compacto, enviadas em partes
-- (seq). A LP grava 20% das visitas, por sorteio, e toda visita que abre o
-- formulário (ver main.js). O painel só baixa a gravação da visita que abrir.
-- Apagadas depois de 15 dias.
CREATE TABLE IF NOT EXISTS gravacoes_pf (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  sessao     TEXT    NOT NULL,
  visitante  TEXT,
  seq        INTEGER NOT NULL,  -- ordem da parte na visita
  inicio     INTEGER,           -- quando a página abriu (ms desde 1970)
  largura    INTEGER,           -- tela da pessoa
  altura     INTEGER,
  altura_doc INTEGER,           -- altura da página inteira
  dados      TEXT               -- "tempo,tipo,a,b;..." (ver main.js)
);
CREATE INDEX IF NOT EXISTS gravacoes_pf_sessao ON gravacoes_pf (sessao, seq);
CREATE INDEX IF NOT EXISTS gravacoes_pf_ts ON gravacoes_pf (ts);

-- Domínios onde apareceu uma cópia da LP (ver CÓPIAS DA PÁGINA em
-- cloudflare/worker.js), uma linha por domínio. Diferente das outras tabelas,
-- recebe UPDATE: cada novo sinal do mesmo domínio atualiza a linha. O painel
-- mostra os vistos nos últimos 30 dias.
CREATE TABLE IF NOT EXISTS copias_pf (
  dominio     TEXT    PRIMARY KEY,
  primeiro_ts INTEGER NOT NULL,
  ultimo_ts   INTEGER NOT NULL,
  sinais      TEXT    NOT NULL,   -- script, estilo, arquivo, envio (separados por vírgula)
  visitas     INTEGER NOT NULL DEFAULT 0,  -- avisos do script: uma por visita à cópia
  exemplo     TEXT,               -- endereço da cópia (completo quando veio do script)
  vindo_de    TEXT                -- domínio de onde o visitante chegou à cópia
);
CREATE INDEX IF NOT EXISTS copias_pf_ultimo ON copias_pf (ultimo_ts);

-- Páginas finais do Typeform (/final/{a|b}/{antecipar|esperar}, ver
-- cloudflare/finais.js). Tabela própria: os acessos a essas páginas não
-- entram nos números da LP (eventos_pf), nem no painel nem no Data Gateway.
-- Só recebe INSERT; o painel sincroniza pelo id, como eventos_pf.
-- Os campos de contexto são preenchidos só no page_view; os cliques e o
-- engajamento se ligam a ele pela sessão.
CREATE TABLE IF NOT EXISTS finais_pf (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  pagina       TEXT    NOT NULL,  -- a/antecipar, a/esperar, b/antecipar, b/esperar
  evento       TEXT    NOT NULL,  -- page_view, clique_grupo, clique_compra, engajamento
  visitante    TEXT,              -- o mesmo identificador da LP (mesmo domínio)
  sessao       TEXT,              -- uma por abertura da página
  valor        INTEGER,           -- engajamento: segundos com a página visível
  referencia   TEXT,
  utm_source   TEXT,              -- UTMs e origem repassadas pelo Typeform na URL
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  lead_origin  TEXT,              -- lp_black_november_2026_frios, _verde, _laranja...
  pontuacao    INTEGER,           -- pontuação do Typeform, quando repassada
  dispositivo  TEXT,
  navegador    TEXT,
  sistema      TEXT,
  pais         TEXT,
  estado       TEXT,
  cidade       TEXT
);
