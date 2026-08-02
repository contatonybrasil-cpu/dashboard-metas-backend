const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const CLIENT_ID = process.env.BLING_CLIENT_ID;
const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const BASE = "https://api.bling.com.br/Api/v3";

let accessToken = null;
let refreshToken = null;

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Configuração de negócio ──────────────────────────────────────────
const VENDEDORES = {
  15596666568: "Guilherme",
  15596595092: "Felipe",
  15596218776: "Giovana",
  15596662555: "Ítalo",
};

// diasSemana: 0 = domingo ... 6 = sábado
const LOJAS = {
  "203654110": { nome: "Parque do Povo", curto: "Parque do Povo", diasSemana: [1, 2, 3, 4, 5, 6] },
  "203777302": { nome: "Prudenshopping", curto: "Prudenshopping", diasSemana: [0, 1, 2, 3, 4, 5, 6] },
};

const IDS_LOJAS = Object.keys(LOJAS);
const IDS_VENDEDORES = Object.keys(VENDEDORES);

function nomeVendedor(id) {
  if (!id || id === 0) return "Gerentes";
  return VENDEDORES[id] || ("Vendedor " + id);
}

// ─── Datas (fuso America/Sao_Paulo, UTC-3 fixo) ───────────────────────
function ymd(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function hojeSP() {
  return ymd(new Date(Date.now() - 3 * 3600 * 1000));
}
function dataUTC(str) {
  return new Date(str + "T12:00:00Z");
}
function diaDaSemana(str) {
  return dataUTC(str).getUTCDay();
}
function semanaDoMes(str) {
  return Math.min(5, Math.ceil(Number(str.slice(8, 10)) / 7));
}
function addDias(d, n) {
  return new Date(d.getTime() + n * 86400000);
}
function inicioMes(str) {
  return str.slice(0, 7) + "-01";
}
function mesesAtras(str, n) {
  var ano = Number(str.slice(0, 4));
  var mes = Number(str.slice(5, 7)) - 1 - n;
  var d = new Date(Date.UTC(ano, mes, 1, 12));
  return ymd(d);
}

// ─── OAuth ────────────────────────────────────────────────────────────
app.get("/auth", (req, res) => {
  const url = `https://api.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&state=dashboard`;
  res.redirect(url);
});

app.get("/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const response = await axios.post(
      "https://api.bling.com.br/Api/v3/oauth/token",
      new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
      { headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" } }
    );
    accessToken = response.data.access_token;
    refreshToken = response.data.refresh_token;
    res.send("Conectado ao Bling com sucesso! Pode fechar esta aba e usar o dashboard.");
    setTimeout(preCarregarCache, 2000);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Erro ao autenticar com o Bling.");
  }
});

async function renovarToken() {
  if (!refreshToken) return;
  try {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const response = await axios.post(
      "https://api.bling.com.br/Api/v3/oauth/token",
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      { headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" } }
    );
    accessToken = response.data.access_token;
    refreshToken = response.data.refresh_token;
    console.log("Token renovado.");
  } catch (err) {
    console.error("Erro ao renovar token:", err.message);
  }
}

// ─── Cliente Bling com retry (401 / 429 / 5xx) ────────────────────────
async function blingGet(path, params, tentativas) {
  tentativas = tentativas || 4;
  var ultimoErro = null;
  for (var i = 0; i < tentativas; i++) {
    try {
      const r = await axios.get(BASE + path, {
        headers: { Authorization: "Bearer " + accessToken },
        params: params,
        timeout: 40000,
      });
      return r.data || {};
    } catch (e) {
      ultimoErro = e;
      const status = e.response && e.response.status;
      const tipo = e.response && e.response.data && e.response.data.error && e.response.data.error.type;
      if (status === 401) {
        await renovarToken();
        await delay(400);
        continue;
      }
      if (status === 429 || tipo === "TOO_MANY_REQUESTS") {
        await delay(1500 * (i + 1));
        continue;
      }
      if (status >= 500) {
        await delay(1000 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw ultimoErro;
}

// ─── Cache ────────────────────────────────────────────────────────────
const cache = {};
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_TTL_HIST = 6 * 60 * 60 * 1000;

function cacheKey(inicio, fim) { return inicio + "_" + fim; }
function cacheValido(key, ttl) { return cache[key] && (Date.now() - cache[key].ts) < (ttl || CACHE_TTL); }

// ─── Listagem paginada de pedidos ─────────────────────────────────────
async function listarPedidos(params, maxPaginas) {
  maxPaginas = maxPaginas || 120;
  var pagina = 1;
  var todos = [];
  while (pagina <= maxPaginas) {
    const data = await blingGet("/pedidos/vendas", Object.assign({}, params, { pagina: pagina, limite: 100 }));
    const pedidos = data.data || [];
    todos = todos.concat(pedidos);
    if (pedidos.length < 100) break;
    pagina++;
    await delay(400);
  }
  if (pagina > maxPaginas) console.log("AVISO: limite de " + maxPaginas + " páginas atingido.");
  return todos;
}

// O endpoint de listagem do Bling não devolve o vendedor, então a atribuição
// por vendedor só é possível filtrando por idVendedor. A loja, por outro lado,
// pode vir no payload — se vier, economizamos metade das requisições.
function temCampoLoja(pedidos) {
  return pedidos.some(function (p) { return p.loja && p.loja.id != null; });
}

function lojaDoPedido(p) {
  if (p.loja && p.loja.id != null) return String(p.loja.id);
  return null;
}

function registro(p, lojaId, vendedor) {
  return {
    id: p.id,
    numero: p.numero,
    data: (p.data || "").slice(0, 10),
    total: Number(p.total) || 0,
    lojaId: lojaId,
    vendedor: vendedor,
  };
}

// ─── Coleta de pedidos com loja + vendedor resolvidos ─────────────────
// Retorna { registros, totalPedidos, lojaViaCampo }
async function coletarPedidos(inicio, fim) {
  const base = { dataInicial: inicio, dataFinal: fim, idSituacao: 9 };

  // Sweep global: total de pedidos + descobre se a loja vem no payload
  const todosGeral = await listarPedidos(base);
  const lojaViaCampo = temCampoLoja(todosGeral);
  await delay(400);

  var registros = [];
  const vistos = new Set();

  if (lojaViaCampo) {
    // 4 sweeps (um por vendedor), loja lida do próprio pedido
    for (var i = 0; i < IDS_VENDEDORES.length; i++) {
      const idV = IDS_VENDEDORES[i];
      const peds = await listarPedidos(Object.assign({}, base, { idVendedor: idV }));
      peds.forEach(function (p) {
        vistos.add(p.id);
        registros.push(registro(p, lojaDoPedido(p) || "outras", VENDEDORES[idV]));
      });
      await delay(400);
    }
  } else {
    // 8 sweeps (loja × vendedor), loja garantida pelo filtro da API
    for (var l = 0; l < IDS_LOJAS.length; l++) {
      const lojaId = IDS_LOJAS[l];
      for (var v = 0; v < IDS_VENDEDORES.length; v++) {
        const idV2 = IDS_VENDEDORES[v];
        const peds2 = await listarPedidos(Object.assign({}, base, { idVendedor: idV2, idLoja: lojaId }));
        peds2.forEach(function (p) {
          vistos.add(p.id);
          registros.push(registro(p, lojaId, VENDEDORES[idV2]));
        });
        await delay(400);
      }
    }
  }

  // Tudo que não caiu em nenhum vendedor é Gerentes
  todosGeral.forEach(function (p) {
    if (vistos.has(p.id)) return;
    registros.push(registro(p, lojaDoPedido(p) || "outras", "Gerentes"));
  });

  return { registros: registros, totalPedidos: todosGeral.length, lojaViaCampo: lojaViaCampo };
}

// Coleta leve para histórico: só data + total + loja (sem quebra por vendedor,
// sem detalhe de itens). Muito mais rápido em janelas longas.
async function coletarPedidosLeve(inicio, fim) {
  const base = { dataInicial: inicio, dataFinal: fim, idSituacao: 9 };
  const todosGeral = await listarPedidos(base, 400);
  if (temCampoLoja(todosGeral)) {
    return todosGeral.map(function (p) { return registro(p, lojaDoPedido(p) || "outras", null); });
  }
  // Sem o campo loja no payload: refaz por loja usando o filtro da API
  var registros = [];
  for (var l = 0; l < IDS_LOJAS.length; l++) {
    const lojaId = IDS_LOJAS[l];
    await delay(400);
    const peds = await listarPedidos(Object.assign({}, base, { idLoja: lojaId }), 400);
    peds.forEach(function (p) { registros.push(registro(p, lojaId, null)); });
  }
  return registros;
}

// ─── Peças (exige detalhe do pedido) ──────────────────────────────────
async function buscarDetalhe(id, tentativas) {
  tentativas = tentativas || 3;
  for (var i = 0; i < tentativas; i++) {
    try {
      const det = await blingGet("/pedidos/vendas/" + id, null, 1);
      return det.data || {};
    } catch (e) {
      const tipo = e.response && e.response.data && e.response.data.error && e.response.data.error.type;
      const status = e.response && e.response.status;
      if (tipo === "TOO_MANY_REQUESTS" || status === 429) {
        console.log("Rate limit pedido " + id + ", tentativa " + (i + 1) + "/" + tentativas);
        await delay(2000 * (i + 1));
      } else {
        break;
      }
    }
  }
  return {};
}

// Busca peças de uma lista de ids em lotes paralelos de 3 → { id: pecas }
async function buscarPecasPorId(ids) {
  var mapa = {};
  var LOTE = 3;
  for (var i = 0; i < ids.length; i += LOTE) {
    var lote = ids.slice(i, i + LOTE);
    var promessas = lote.map(function (id) {
      return buscarDetalhe(id).then(function (d) {
        return (d.itens || []).reduce(function (s, item) { return s + (Number(item.quantidade) || 0); }, 0);
      });
    });
    var pecasLote = await Promise.all(promessas);
    pecasLote.forEach(function (pecas, j) { mapa[lote[j]] = pecas; });
    await delay(450);
  }
  return mapa;
}

// ─── Agregação por vendedor / por loja ────────────────────────────────
function agruparVendedores(registros, pecasPorId) {
  var mapa = {};
  registros.forEach(function (r) {
    if (!mapa[r.vendedor]) mapa[r.vendedor] = { nome: r.vendedor, faturamento: 0, pedidos: 0, pecas: 0 };
    var m = mapa[r.vendedor];
    m.faturamento += r.total;
    m.pedidos += 1;
    m.pecas += pecasPorId[r.id] || 0;
  });
  return Object.keys(mapa).map(function (nome) {
    var m = mapa[nome];
    return {
      nome: m.nome,
      faturamento: +m.faturamento.toFixed(2),
      pedidos: m.pedidos,
      pecas: m.pecas,
      ticketMedio: m.pedidos > 0 ? +(m.faturamento / m.pedidos).toFixed(2) : 0,
    };
  }).sort(function (a, b) { return b.faturamento - a.faturamento; });
}

function montarPorLoja(registros, pecasPorId) {
  var out = {};
  IDS_LOJAS.forEach(function (lojaId) {
    var regs = registros.filter(function (r) { return r.lojaId === lojaId; });
    var vendedores = agruparVendedores(regs, pecasPorId);
    out[lojaId] = {
      id: lojaId,
      nome: LOJAS[lojaId].nome,
      diasSemana: LOJAS[lojaId].diasSemana,
      faturamento: +regs.reduce(function (s, r) { return s + r.total; }, 0).toFixed(2),
      pedidos: regs.length,
      pecas: regs.reduce(function (s, r) { return s + (pecasPorId[r.id] || 0); }, 0),
      vendedores: vendedores,
    };
  });
  var outras = registros.filter(function (r) { return IDS_LOJAS.indexOf(r.lojaId) === -1; });
  if (outras.length) {
    out["outras"] = {
      id: "outras",
      nome: "Outras origens",
      diasSemana: [0, 1, 2, 3, 4, 5, 6],
      faturamento: +outras.reduce(function (s, r) { return s + r.total; }, 0).toFixed(2),
      pedidos: outras.length,
      pecas: outras.reduce(function (s, r) { return s + (pecasPorId[r.id] || 0); }, 0),
      vendedores: agruparVendedores(outras, pecasPorId),
    };
  }
  return out;
}

// Série diária por vendedor (usada pelo painel "Hoje" e projeções)
function serieDiaria(registros) {
  var out = {};
  registros.forEach(function (r) {
    if (!r.data) return;
    if (!out[r.data]) out[r.data] = { faturamento: 0, pedidos: 0, porLoja: {} };
    var d = out[r.data];
    d.faturamento += r.total;
    d.pedidos += 1;
    if (!d.porLoja[r.lojaId]) d.porLoja[r.lojaId] = { faturamento: 0, pedidos: 0 };
    d.porLoja[r.lojaId].faturamento += r.total;
    d.porLoja[r.lojaId].pedidos += 1;
  });
  Object.keys(out).forEach(function (k) { out[k].faturamento = +out[k].faturamento.toFixed(2); });
  return out;
}

// ─── /vendas ──────────────────────────────────────────────────────────
app.get("/vendas", async (req, res) => {
  if (!accessToken) return res.status(401).json({ erro: "Nao autenticado. Acesse /auth primeiro." });
  const hoje = hojeSP();
  const inicio = req.query.dataInicio || inicioMes(hoje);
  const fim = req.query.dataFim || hoje;
  const key = cacheKey(inicio, fim);
  if (cacheValido(key)) {
    console.log("Cache hit: " + key);
    return res.json(cache[key].data);
  }
  console.log("Cache miss: " + key);
  try {
    const coleta = await coletarPedidos(inicio, fim);
    const ids = coleta.registros.map(function (r) { return r.id; });
    const pecasPorId = await buscarPecasPorId(ids);
    const resposta = {
      periodo: { inicio: inicio, fim: fim },
      vendedores: agruparVendedores(coleta.registros, pecasPorId),
      totalPedidos: coleta.totalPedidos,
      porLoja: montarPorLoja(coleta.registros, pecasPorId),
      diario: serieDiaria(coleta.registros),
      lojas: LOJAS,
      atualizadoEm: new Date().toISOString(),
    };
    cache[key] = { data: resposta, ts: Date.now() };
    res.json(resposta);
  } catch (err) {
    if (err.response && err.response.status === 401) {
      await renovarToken();
      return res.status(401).json({ erro: "Token renovado, tente novamente." });
    }
    const detalhe = err.response && err.response.data ? err.response.data : err.message;
    console.error("ERRO BLING:", JSON.stringify(detalhe));
    res.status(500).json({ erro: "Erro ao buscar vendas no Bling.", detalhe: detalhe });
  }
});

// ═══ INTELIGÊNCIA DE HISTÓRICO ════════════════════════════════════════

// Páscoa — algoritmo de Meeus/Jones/Butcher
function pascoa(ano) {
  var a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  var d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  var g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  var i = Math.floor(c / 4), k = c % 4;
  var l = (32 + 2 * e + 2 * i - h - k) % 7;
  var m = Math.floor((a + 11 * h + 22 * l) / 451);
  var mes = Math.floor((h + l - 7 * m + 114) / 31);
  var dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia, 12));
}

// n-ésima ocorrência de um dia da semana no mês (mes 1-12)
function nDiaSemana(ano, mes, diaSemana, n) {
  var d = new Date(Date.UTC(ano, mes - 1, 1, 12));
  var desloc = (diaSemana - d.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(ano, mes - 1, 1 + desloc + (n - 1) * 7, 12));
}

function ultimoDiaSemana(ano, mes, diaSemana) {
  var ultimo = new Date(Date.UTC(ano, mes, 0, 12));
  var desloc = (ultimo.getUTCDay() - diaSemana + 7) % 7;
  return new Date(Date.UTC(ano, mes - 1, ultimo.getUTCDate() - desloc, 12));
}

function dataFixa(ano, mes, dia) {
  return new Date(Date.UTC(ano, mes - 1, dia, 12));
}

// Calendário comercial de varejo de moda (antes = dias de aquecimento)
const EVENTOS = [
  { nome: "Volta às Aulas", emoji: "🎒", antes: 0, depois: 14, quando: function (a) { return dataFixa(a, 2, 1); } },
  { nome: "Carnaval", emoji: "🎭", antes: 4, depois: 1, quando: function (a) { return addDias(pascoa(a), -47); } },
  { nome: "Dia da Mulher", emoji: "🌷", antes: 5, depois: 0, quando: function (a) { return dataFixa(a, 3, 8); } },
  { nome: "Páscoa", emoji: "🐣", antes: 5, depois: 0, quando: function (a) { return pascoa(a); } },
  { nome: "Dia do Trabalho", emoji: "🛠", antes: 2, depois: 0, quando: function (a) { return dataFixa(a, 5, 1); } },
  { nome: "Dia das Mães", emoji: "💐", antes: 8, depois: 0, quando: function (a) { return nDiaSemana(a, 5, 0, 2); } },
  { nome: "Dia dos Namorados", emoji: "❤️", antes: 6, depois: 0, quando: function (a) { return dataFixa(a, 6, 12); } },
  { nome: "Festas Juninas", emoji: "🎪", antes: 6, depois: 0, quando: function (a) { return dataFixa(a, 6, 24); } },
  { nome: "Dia dos Pais", emoji: "👔", antes: 8, depois: 0, quando: function (a) { return nDiaSemana(a, 8, 0, 2); } },
  { nome: "Independência", emoji: "🇧🇷", antes: 2, depois: 1, quando: function (a) { return dataFixa(a, 9, 7); } },
  { nome: "Dia do Cliente", emoji: "🤝", antes: 3, depois: 1, quando: function (a) { return dataFixa(a, 9, 15); } },
  { nome: "Dia das Crianças", emoji: "🧒", antes: 6, depois: 0, quando: function (a) { return dataFixa(a, 10, 12); } },
  { nome: "Black Friday", emoji: "🖤", antes: 5, depois: 3, quando: function (a) { return ultimoDiaSemana(a, 11, 5); } },
  { nome: "Natal", emoji: "🎄", antes: 14, depois: 0, quando: function (a) { return dataFixa(a, 12, 25); } },
  { nome: "Réveillon", emoji: "🎉", antes: 4, depois: 0, quando: function (a) { return dataFixa(a, 12, 31); } },
];

// Instancia os eventos de todos os anos que a janela cobre
function eventosNoPeriodo(inicio, fim) {
  var anoIni = Number(inicio.slice(0, 4));
  var anoFim = Number(fim.slice(0, 4));
  var lista = [];
  for (var ano = anoIni; ano <= anoFim; ano++) {
    EVENTOS.forEach(function (ev) {
      var d = ev.quando(ano);
      var janela = [];
      for (var i = -ev.antes; i <= ev.depois; i++) janela.push(ymd(addDias(d, i)));
      lista.push({
        nome: ev.nome,
        emoji: ev.emoji,
        ano: ano,
        data: ymd(d),
        janela: janela,
        janelaInicio: janela[0],
        janelaFim: janela[janela.length - 1],
      });
    });
  }
  return lista;
}

const NOMES_MES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const NOMES_DIA = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

// Núcleo do aprendizado: recebe registros já filtrados e devolve os pesos
function analisar(registros, inicio, fim, diasSemanaLoja) {
  var serie = {};
  registros.forEach(function (r) {
    if (!r.data || r.data < inicio || r.data > fim) return;
    if (!serie[r.data]) serie[r.data] = { faturamento: 0, pedidos: 0 };
    serie[r.data].faturamento += r.total;
    serie[r.data].pedidos += 1;
  });

  var datas = Object.keys(serie).sort();
  var faturamentoTotal = datas.reduce(function (s, d) { return s + serie[d].faturamento; }, 0);
  var pedidosTotal = datas.reduce(function (s, d) { return s + serie[d].pedidos; }, 0);

  var eventos = eventosNoPeriodo(inicio, fim);
  var diasDeEvento = {};
  eventos.forEach(function (ev) {
    ev.janela.forEach(function (d) { if (!diasDeEvento[d]) diasDeEvento[d] = ev.nome; });
  });

  // ── Peso por dia da semana (% do faturamento) ──
  var porDia = [];
  for (var ds = 0; ds < 7; ds++) porDia.push({ dia: ds, nome: NOMES_DIA[ds], faturamento: 0, pedidos: 0, dias: 0, baseFat: 0, baseDias: 0 });
  datas.forEach(function (d) {
    var ds2 = diaDaSemana(d);
    var b = porDia[ds2];
    b.faturamento += serie[d].faturamento;
    b.pedidos += serie[d].pedidos;
    if (serie[d].faturamento > 0) b.dias += 1;
    // baseline "dia normal": exclui janelas sazonais
    if (serie[d].faturamento > 0 && !diasDeEvento[d]) {
      b.baseFat += serie[d].faturamento;
      b.baseDias += 1;
    }
  });

  var diaSemana = porDia.map(function (b) {
    return {
      dia: b.dia,
      nome: b.nome,
      abre: !diasSemanaLoja || diasSemanaLoja.indexOf(b.dia) !== -1,
      faturamento: +b.faturamento.toFixed(2),
      pedidos: b.pedidos,
      dias: b.dias,
      peso: faturamentoTotal > 0 ? +(b.faturamento / faturamentoTotal).toFixed(5) : 0,
      mediaDia: b.dias > 0 ? +(b.faturamento / b.dias).toFixed(2) : 0,
      ticketMedio: b.pedidos > 0 ? +(b.faturamento / b.pedidos).toFixed(2) : 0,
      baseMediaDia: b.baseDias > 0 ? +(b.baseFat / b.baseDias).toFixed(2) : 0,
    };
  });

  // baseline por dia da semana, com fallback para a média geral
  var mediaGeralDia = datas.length > 0 ? faturamentoTotal / datas.filter(function (d) { return serie[d].faturamento > 0; }).length : 0;
  function baseline(dataStr) {
    var b = diaSemana[diaDaSemana(dataStr)];
    if (b.baseMediaDia > 0) return b.baseMediaDia;
    if (b.mediaDia > 0) return b.mediaDia;
    return mediaGeralDia || 0;
  }

  var abertos = diaSemana.filter(function (b) { return b.abre; });
  var melhorDia = abertos.slice().sort(function (a, b) { return b.mediaDia - a.mediaDia; })[0] || null;
  var piorDia = abertos.filter(function (b) { return b.dias > 0; }).sort(function (a, b) { return a.mediaDia - b.mediaDia; })[0] || null;

  // ── Peso por semana do mês ──
  var sem = [1, 2, 3, 4, 5].map(function (n) { return { semana: n, faturamento: 0, pedidos: 0, dias: 0 }; });
  datas.forEach(function (d) {
    var s = sem[semanaDoMes(d) - 1];
    s.faturamento += serie[d].faturamento;
    s.pedidos += serie[d].pedidos;
    if (serie[d].faturamento > 0) s.dias += 1;
  });
  var semanaMes = sem.map(function (s) {
    return {
      semana: s.semana,
      rotulo: s.semana === 5 ? "Dias 29-31" : "Dias " + ((s.semana - 1) * 7 + 1) + "-" + (s.semana * 7),
      faturamento: +s.faturamento.toFixed(2),
      pedidos: s.pedidos,
      dias: s.dias,
      peso: faturamentoTotal > 0 ? +(s.faturamento / faturamentoTotal).toFixed(5) : 0,
      mediaDia: s.dias > 0 ? +(s.faturamento / s.dias).toFixed(2) : 0,
    };
  });

  // ── Meses ──
  var mesMapa = {};
  datas.forEach(function (d) {
    var k = d.slice(0, 7);
    if (!mesMapa[k]) mesMapa[k] = { chave: k, faturamento: 0, pedidos: 0, dias: 0 };
    mesMapa[k].faturamento += serie[d].faturamento;
    mesMapa[k].pedidos += serie[d].pedidos;
    if (serie[d].faturamento > 0) mesMapa[k].dias += 1;
  });
  var chavesMes = Object.keys(mesMapa).sort();
  // Mês corrente é parcial — não entra na média de referência
  var mesCorrente = hojeSP().slice(0, 7);
  var completos = chavesMes.filter(function (k) { return k !== mesCorrente; });
  var mediaMes = completos.length > 0
    ? completos.reduce(function (s, k) { return s + mesMapa[k].faturamento; }, 0) / completos.length
    : 0;

  var meses = chavesMes.map(function (k) {
    var m = mesMapa[k];
    var idxMes = Number(k.slice(5, 7)) - 1;
    return {
      chave: k,
      ano: Number(k.slice(0, 4)),
      mes: idxMes + 1,
      nome: NOMES_MES[idxMes],
      rotulo: NOMES_MES[idxMes].slice(0, 3) + "/" + k.slice(2, 4),
      faturamento: +m.faturamento.toFixed(2),
      pedidos: m.pedidos,
      dias: m.dias,
      mediaDia: m.dias > 0 ? +(m.faturamento / m.dias).toFixed(2) : 0,
      parcial: k === mesCorrente,
      indice: mediaMes > 0 ? +(m.faturamento / mediaMes).toFixed(3) : null,
      peso: faturamentoTotal > 0 ? +(m.faturamento / faturamentoTotal).toFixed(5) : 0,
    };
  });

  var mesesFortes = meses.filter(function (m) { return !m.parcial; })
    .slice().sort(function (a, b) { return b.faturamento - a.faturamento; })
    .map(function (m) { return { chave: m.chave, nome: m.nome, rotulo: m.rotulo, faturamento: m.faturamento, indice: m.indice }; });

  // ── Sazonalidade: impacto medido de cada data comemorativa ──
  var sazonalidade = eventos.map(function (ev) {
    var diasComDados = ev.janela.filter(function (d) { return d >= inicio && d <= fim; });
    var real = 0, esperado = 0, diasReais = 0;
    diasComDados.forEach(function (d) {
      if (diasSemanaLoja && diasSemanaLoja.indexOf(diaDaSemana(d)) === -1) return;
      var f = serie[d] ? serie[d].faturamento : 0;
      real += f;
      esperado += baseline(d);
      if (f > 0) diasReais += 1;
    });
    var temHistorico = diasReais >= 2 && esperado > 0;
    return {
      nome: ev.nome,
      emoji: ev.emoji,
      ano: ev.ano,
      data: ev.data,
      diaSemana: NOMES_DIA[diaDaSemana(ev.data)],
      janelaInicio: ev.janelaInicio,
      janelaFim: ev.janelaFim,
      diasJanela: ev.janela.length,
      diasMedidos: diasReais,
      faturamento: +real.toFixed(2),
      esperado: +esperado.toFixed(2),
      impacto: temHistorico ? +(real / esperado - 1).toFixed(4) : null,
      multiplicador: temHistorico ? +(real / esperado).toFixed(3) : null,
      comHistorico: temHistorico,
    };
  }).sort(function (a, b) { return a.data < b.data ? -1 : 1; });

  // ── Picos detectados automaticamente ──
  var picos = datas.filter(function (d) {
    var b = baseline(d);
    return b > 0 && serie[d].faturamento / b >= 1.6;
  }).map(function (d) {
    var b = baseline(d);
    // evento comemorativo mais próximo (até 12 dias)
    var maisProximo = null, menorDist = 99;
    eventos.forEach(function (ev) {
      var dist = Math.round(Math.abs(dataUTC(d) - dataUTC(ev.data)) / 86400000);
      if (dist < menorDist) { menorDist = dist; maisProximo = ev; }
    });
    return {
      data: d,
      diaSemana: NOMES_DIA[diaDaSemana(d)],
      faturamento: +serie[d].faturamento.toFixed(2),
      pedidos: serie[d].pedidos,
      esperado: +b.toFixed(2),
      razao: +(serie[d].faturamento / b).toFixed(2),
      possivelCausa: maisProximo && menorDist <= 12 ? maisProximo.nome : null,
      distanciaEvento: maisProximo && menorDist <= 12 ? menorDist : null,
    };
  }).sort(function (a, b) { return b.razao - a.razao; }).slice(0, 20);

  var diasComVenda = datas.filter(function (d) { return serie[d].faturamento > 0; }).length;

  return {
    faturamentoTotal: +faturamentoTotal.toFixed(2),
    pedidosTotal: pedidosTotal,
    diasComVenda: diasComVenda,
    mediaDiaria: diasComVenda > 0 ? +(faturamentoTotal / diasComVenda).toFixed(2) : 0,
    ticketMedio: pedidosTotal > 0 ? +(faturamentoTotal / pedidosTotal).toFixed(2) : 0,
    diaSemana: diaSemana,
    melhorDia: melhorDia,
    piorDia: piorDia,
    semanaMes: semanaMes,
    meses: meses,
    mesesFortes: mesesFortes,
    sazonalidade: sazonalidade,
    picos: picos,
    diario: datas.map(function (d) {
      return { data: d, diaSemana: diaDaSemana(d), faturamento: +serie[d].faturamento.toFixed(2), pedidos: serie[d].pedidos, evento: diasDeEvento[d] || null };
    }),
  };
}

// ─── /historico ───────────────────────────────────────────────────────
app.get("/historico", async (req, res) => {
  if (!accessToken) return res.status(401).json({ erro: "Nao autenticado. Acesse /auth primeiro." });
  var meses = Math.min(24, Math.max(1, Number(req.query.meses) || 6));
  const hoje = hojeSP();
  const inicio = inicioMes(mesesAtras(hoje, meses - 1));
  const fim = req.query.dataFim || hoje;
  const key = "hist_" + meses + "_" + cacheKey(inicio, fim);

  if (cacheValido(key, CACHE_TTL_HIST)) {
    console.log("Cache hit histórico: " + key);
    return res.json(cache[key].data);
  }
  console.log("Cache miss histórico: " + key + " (" + meses + " meses)");

  try {
    const registros = await coletarPedidosLeve(inicio, fim);
    const lojasOut = {};
    IDS_LOJAS.forEach(function (lojaId) {
      const regs = registros.filter(function (r) { return r.lojaId === lojaId; });
      lojasOut[lojaId] = Object.assign(
        { id: lojaId, nome: LOJAS[lojaId].nome, diasSemana: LOJAS[lojaId].diasSemana },
        analisar(regs, inicio, fim, LOJAS[lojaId].diasSemana)
      );
    });
    const resposta = {
      periodo: { inicio: inicio, fim: fim, meses: meses },
      geral: analisar(registros, inicio, fim, null),
      lojas: lojasOut,
      config: { lojas: LOJAS, vendedores: VENDEDORES },
      atualizadoEm: new Date().toISOString(),
    };
    cache[key] = { data: resposta, ts: Date.now() };
    res.json(resposta);
  } catch (err) {
    if (err.response && err.response.status === 401) {
      await renovarToken();
      return res.status(401).json({ erro: "Token renovado, tente novamente." });
    }
    const detalhe = err.response && err.response.data ? err.response.data : err.message;
    console.error("ERRO HISTORICO:", JSON.stringify(detalhe));
    res.status(500).json({ erro: "Erro ao buscar histórico no Bling.", detalhe: detalhe });
  }
});

// ─── Rotas auxiliares ─────────────────────────────────────────────────
app.get("/config", (req, res) => {
  res.json({ lojas: LOJAS, vendedores: VENDEDORES, hoje: hojeSP() });
});

app.get("/debug/:numero", async (req, res) => {
  if (!accessToken) return res.status(401).json({ erro: "Nao autenticado." });
  try {
    const lista = await blingGet("/pedidos/vendas", { numero: req.params.numero, pagina: 1, limite: 1 });
    const pedido = lista.data && lista.data[0];
    if (!pedido) return res.json({ erro: "Pedido nao encontrado" });
    const d = await buscarDetalhe(pedido.id);
    res.json({
      numero: d.numero, data: d.data, vendedor: d.vendedor, loja: d.loja,
      total: d.total, totalProdutos: d.totalProdutos,
      camposDaListagem: Object.keys(pedido),
    });
  } catch (err) {
    res.status(500).json({ erro: err.response && err.response.data ? err.response.data : err.message });
  }
});

app.get("/cache/limpar", (req, res) => {
  Object.keys(cache).forEach(function (k) { delete cache[k]; });
  res.json({ ok: true, msg: "Cache limpo!" });
});

app.get("/status", (req, res) => {
  const caches = Object.keys(cache).map(function (k) {
    const hist = k.indexOf("hist_") === 0;
    return {
      periodo: k,
      tipo: hist ? "historico" : "vendas",
      idadeMinutos: Math.round((Date.now() - cache[k].ts) / 60000),
      valido: cacheValido(k, hist ? CACHE_TTL_HIST : CACHE_TTL),
    };
  });
  res.json({ ok: true, autenticado: !!accessToken, hoje: hojeSP(), lojas: LOJAS, caches: caches });
});

async function preCarregarCache() {
  if (!accessToken) return;
  const hoje = hojeSP();
  const inicio = inicioMes(hoje);
  const key = cacheKey(inicio, hoje);
  if (!cacheValido(key)) {
    console.log("Pre-carregando vendas do mês...");
    try {
      const coleta = await coletarPedidos(inicio, hoje);
      const pecasPorId = await buscarPecasPorId(coleta.registros.map(function (r) { return r.id; }));
      cache[key] = {
        data: {
          periodo: { inicio: inicio, fim: hoje },
          vendedores: agruparVendedores(coleta.registros, pecasPorId),
          totalPedidos: coleta.totalPedidos,
          porLoja: montarPorLoja(coleta.registros, pecasPorId),
          diario: serieDiaria(coleta.registros),
          lojas: LOJAS,
          atualizadoEm: new Date().toISOString(),
        },
        ts: Date.now(),
      };
      console.log("Cache de vendas pre-carregado! " + coleta.totalPedidos + " pedidos.");
    } catch (e) {
      console.error("Erro no pre-carregamento de vendas:", e.message);
    }
  }

  // Histórico de 6 meses (usado pelas abas Semana / Mês / Sazonalidade)
  const inicioHist = inicioMes(mesesAtras(hoje, 5));
  const keyHist = "hist_6_" + cacheKey(inicioHist, hoje);
  if (!cacheValido(keyHist, CACHE_TTL_HIST)) {
    console.log("Pre-carregando histórico de 6 meses...");
    try {
      const registros = await coletarPedidosLeve(inicioHist, hoje);
      const lojasOut = {};
      IDS_LOJAS.forEach(function (lojaId) {
        const regs = registros.filter(function (r) { return r.lojaId === lojaId; });
        lojasOut[lojaId] = Object.assign(
          { id: lojaId, nome: LOJAS[lojaId].nome, diasSemana: LOJAS[lojaId].diasSemana },
          analisar(regs, inicioHist, hoje, LOJAS[lojaId].diasSemana)
        );
      });
      cache[keyHist] = {
        data: {
          periodo: { inicio: inicioHist, fim: hoje, meses: 6 },
          geral: analisar(registros, inicioHist, hoje, null),
          lojas: lojasOut,
          config: { lojas: LOJAS, vendedores: VENDEDORES },
          atualizadoEm: new Date().toISOString(),
        },
        ts: Date.now(),
      };
      console.log("Histórico pre-carregado! " + registros.length + " pedidos analisados.");
    } catch (e) {
      console.error("Erro no pre-carregamento do histórico:", e.message);
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log("Servidor rodando na porta " + PORT);

  setInterval(async function () {
    try {
      await axios.get("https://dashboard-metas.onrender.com/status");
      console.log("Auto-ping OK");
    } catch (e) {
      console.log("Auto-ping falhou:", e.message);
    }
  }, 14 * 60 * 1000);

  setInterval(async function () {
    if (refreshToken) {
      console.log("Renovando token...");
      await renovarToken();
      setTimeout(preCarregarCache, 3000);
    }
  }, 5 * 60 * 60 * 1000);

  setInterval(function () { preCarregarCache(); }, 30 * 60 * 1000);
});
