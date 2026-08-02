# dashboard-metas-backend

Integração Bling API v3 → Dashboard de Performance da New York Store.

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `BLING_CLIENT_ID` | Client ID do app no Bling |
| `BLING_CLIENT_SECRET` | Client Secret do app no Bling |
| `REDIRECT_URI` | URL de callback registrada no Bling (`https://.../callback`) |
| `PORT` | Porta HTTP (o Render define automaticamente) |

## Lojas e vendedores

| Loja | ID | Funcionamento |
|---|---|---|
| Parque do Povo | `203654110` | Segunda a sábado |
| Prudenshopping | `203777302` | Todos os dias |

Vendedores: Guilherme `15596666568`, Felipe `15596595092`, Giovana `15596218776`, Ítalo `15596662555`.
Pedidos sem vendedor mapeado entram como **Gerentes**. Só pedidos com situação `9` (atendido) são contados.

## Rotas

### `GET /auth` → `GET /callback`
Fluxo OAuth. Acesse `/auth` no navegador para (re)conectar. O token é mantido **em memória** — depois de um restart do Render é preciso reconectar.

### `GET /vendas?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD`
Vendas do período. Sem parâmetros, usa o mês corrente. Cache de 30 min.

```jsonc
{
  "periodo": { "inicio": "2026-08-01", "fim": "2026-08-31" },
  "vendedores": [ { "nome", "faturamento", "pedidos", "pecas", "ticketMedio" } ],
  "totalPedidos": 220,
  "porLoja": {
    "203654110": { "id", "nome", "diasSemana", "faturamento", "pedidos", "pecas", "vendedores": [...] }
  },
  "diario": { "2026-08-01": { "faturamento", "pedidos", "porLoja": { "<id>": { "faturamento", "pedidos" } } } }
}
```

### `GET /historico?meses=6`
Aprende os padrões do Bling nos últimos N meses (1–24, padrão 6). Cache de 6 h. Não busca detalhe de itens, então é bem mais rápido que `/vendas` em janelas longas.

Retorna `geral` e um bloco por loja em `lojas`, cada um com:

| Campo | O que é |
|---|---|
| `diaSemana[]` | Peso de cada dia da semana (`peso` = % do faturamento), `mediaDia` e `baseMediaDia` (média excluindo janelas sazonais) |
| `semanaMes[]` | Peso de cada semana do mês (1ª a 5ª) |
| `meses[]` / `mesesFortes[]` | Faturamento por mês e `indice` (1,00 = média do período) |
| `sazonalidade[]` | Cada data comemorativa com `faturamento` na janela, `esperado`, `impacto` e `multiplicador`. `comHistorico: false` quando a data não caiu na janela analisada |
| `picos[]` | Dias 60%+ acima do normal daquele dia da semana, com a `possivelCausa` mais próxima |
| `diario[]` | Série diária (`data`, `faturamento`, `pedidos`, `evento`) |

O `baseMediaDia` é o peso "dia normal" — ele exclui as janelas sazonais para que o frontend possa aplicar o multiplicador do evento sem contar o efeito duas vezes.

Datas comemorativas cobertas: Volta às Aulas, Carnaval, Dia da Mulher, Páscoa, Dia do Trabalho, Dia das Mães, Dia dos Namorados, Festas Juninas, Dia dos Pais, Independência, Dia do Cliente, Dia das Crianças, Black Friday, Natal e Réveillon. Páscoa e Carnaval são calculados (Meeus/Jones/Butcher); Dia das Mães, Dia dos Pais e Black Friday são resolvidos pelo dia da semana do mês.

> Com `meses=6` só dá para medir as datas dos últimos 6 meses. Para capturar Natal, Black Friday e Dia das Mães, use `meses=12` ou mais.

### `GET /config`
Lojas, vendedores e a data de hoje no fuso de São Paulo.

### `GET /debug/:numero`
Inspeciona um pedido pelo número, incluindo quais campos a listagem do Bling devolve.

### `GET /status` · `GET /cache/limpar`
Estado da autenticação e dos caches / limpeza manual do cache.

## Notas de implementação

- **Fuso horário:** o Render roda em UTC. Todas as datas usam `hojeSP()` (UTC-3) para que "hoje" não vire o dia seguinte depois das 21h.
- **Vendedor por pedido:** a listagem do Bling não devolve o vendedor, só o filtro `idVendedor` resolve — por isso há uma varredura por vendedor. A loja, quando vem no payload, economiza metade das requisições (`coletarPedidos` detecta isso em tempo de execução).
- **Rate limit:** `blingGet` faz retry com backoff em 429/5xx e renova o token em 401. Detalhes de pedidos são buscados em lotes de 3 com pausa de 450 ms.
- **Auto-manutenção:** auto-ping a cada 14 min (evita o sleep do Render), renovação de token a cada 5 h e pré-carregamento de cache a cada 30 min.
