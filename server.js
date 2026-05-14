const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const CLIENT_ID = process.env.BLING_CLIENT_ID;
const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

let accessToken = null;
let refreshToken = null;

const delay = ms => new Promise(r => setTimeout(r, ms));

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
  try {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const response = await axios.post(
      "https://api.bling.com.br/Api/v3/oauth/token",
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      { headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" } }
    );
    accessToken = response.data.access_token;
    refreshToken = response.data.refresh_token;
  } catch (err) {
    console.error("Erro ao renovar token:", err.message);
  }
}

const cache = {};
const CACHE_TTL = 30 * 60 * 1000;

function cacheKey(inicio, fim) { return inicio + "_" + fim; }
function cacheValido(key) { return cache[key] && (Date.now() - cache[key].ts) < CACHE_TTL; }

const VENDEDORES = {
  15596666568: "Guilherme",
  15596595092: "Felipe",
  15596218776: "Giovana",
  15596662555: "Ítalo",
};

function nomeVendedor(id) {
  if (!id || id === 0) return "Gerentes";
  return VENDEDORES[id] || ("Vendedor " + id);
}

async function buscarDetalhe(id, tentativas) {
  tentativas = tentativas || 3;
  for (var i = 0; i < tentativas; i++) {
    try {
      const det = await axios.get("https://api.bling.com.br/Api/v3/pedidos/vendas/" + id, {
        headers: { Authorization: "Bearer " + accessToken },
      });
      return det.data.data || {};
    } catch (e) {
      const tipo = e.response && e.response.data && e.response.data.error && e.response.data.error.type;
      const status = e.response && e.response.status;
      if (tipo === "TOO_MANY_REQUESTS" || status === 429) {
        console.log("Rate limit pedido " + id + ", tentativa " + (i+1) + "/" + tentativas);
        await delay(2000 * (i + 1));
      } else {
        break;
      }
    }
  }
  return {};
}

// ─── Buscar pedidos por vendedor (novo modelo rápido) ─────────────────
async function buscarPedidosPorVendedor(idVendedor, inicio, fim) {
  var pagina = 1;
  var todos = [];
  while (true) {
    const response = await axios.get("https://api.bling.com.br/Api/v3/pedidos/vendas", {
      headers: { Authorization: "Bearer " + accessToken },
      params: { dataInicial: inicio, dataFinal: fim, pagina: pagina, limite: 100, idSituacao: 9, idVendedor: idVendedor },
    });
    const pedidos = response.data.data || [];
    todos = todos.concat(pedidos);
    if (pedidos.length < 100) break;
    pagina++;
    await delay(400);
  }
  return todos;
}

// ─── Buscar pedidos sem vendedor (Gerentes) ───────────────────────────
async function buscarPedidosSemVendedor(inicio, fim) {
  // Busca todos e filtra os que não têm vendedor mapeado
  var pagina = 1;
  var todos = [];
  while (true) {
    const response = await axios.get("https://api.bling.com.br/Api/v3/pedidos/vendas", {
      headers: { Authorization: "Bearer " + accessToken },
      params: { dataInicial: inicio, dataFinal: fim, pagina: pagina, limite: 100, idSituacao: 9 },
    });
    const pedidos = response.data.data || [];
    todos = todos.concat(pedidos);
    if (pedidos.length < 100) break;
    pagina++;
    await delay(400);
  }
  return todos;
}

// ─── Buscar peças em lotes paralelos de 3 ────────────────────────────
async function buscarPecasLote(pedidos) {
  var resultado = new Array(pedidos.length).fill(0);
  var LOTE = 3;
  for (var i = 0; i < pedidos.length; i += LOTE) {
    var lote = pedidos.slice(i, i + LOTE);
    var promessas = lote.map(function(p) {
      return buscarDetalhe(p.id).then(function(d) {
        return (d.itens || []).reduce(function(s, item) { return s + (Number(item.quantidade) || 0); }, 0);
      });
    });
    var pecasLote = await Promise.all(promessas);
    pecasLote.forEach(function(pecas, j) { resultado[i + j] = pecas; });
    await delay(450);
  }
  return resultado;
}

async function buscarPedidos(inicio, fim) {
  var idsVendedores = Object.keys(VENDEDORES).map(Number);

  // Busca por vendedor em paralelo (respeitando rate limit — sequencial entre vendedores)
  var todosPedidos = [];
  var pedidosPorVendedor = {};

  for (var k = 0; k < idsVendedores.length; k++) {
    var idV = idsVendedores[k];
    var nome = VENDEDORES[idV];
    var peds = await buscarPedidosPorVendedor(idV, inicio, fim);
    pedidosPorVendedor[nome] = peds;
    todosPedidos = todosPedidos.concat(peds);
    await delay(400);
  }

  // Busca todos os pedidos para identificar os sem vendedor (Gerentes)
  var todosGeral = await buscarPedidosSemVendedor(inicio, fim);
  var idsComVendedor = new Set(todosPedidos.map(function(p) { return p.id; }));
  var pedidosGerentes = todosGeral.filter(function(p) { return !idsComVendedor.has(p.id); });
  pedidosPorVendedor["Gerentes"] = pedidosGerentes;
  var totalGeral = todosGeral.length;

  // Retorna estrutura para processamento
  return { pedidosPorVendedor: pedidosPorVendedor, totalPedidos: totalGeral };
}

async function processarPedidos(resultado) {
  var pedidosPorVendedor = resultado.pedidosPorVendedor;
  var totalPedidos = resultado.totalPedidos;
  var vendedores = [];

  for (var nome in pedidosPorVendedor) {
    var peds = pedidosPorVendedor[nome];
    if (peds.length === 0) continue;

    var faturamento = peds.reduce(function(s, p) { return s + (p.total || 0); }, 0);

    // Busca peças em lotes paralelos
    var pecasArr = await buscarPecasLote(peds);
    var pecas = pecasArr.reduce(function(s, n) { return s + n; }, 0);

    vendedores.push({
      nome: nome,
      faturamento: +faturamento.toFixed(2),
      pedidos: peds.length,
      pecas: pecas,
      ticketMedio: peds.length > 0 ? +(faturamento / peds.length).toFixed(2) : 0,
    });
  }

  return { vendedores: vendedores, totalPedidos: totalPedidos };
}

app.get("/vendas", async (req, res) => {
  if (!accessToken) return res.status(401).json({ erro: "Nao autenticado. Acesse /auth primeiro." });
  const dataInicio = req.query.dataInicio;
  const dataFim = req.query.dataFim;
  const inicio = dataInicio || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const fim = dataFim || new Date().toISOString().slice(0, 10);
  const key = cacheKey(inicio, fim);
  if (cacheValido(key)) {
    console.log("Cache hit: " + key);
    return res.json(cache[key].data);
  }
  console.log("Cache miss: " + key);
  try {
    const resultado = await buscarPedidos(inicio, fim);
    const { vendedores, totalPedidos } = await processarPedidos(resultado);
    const resposta = { periodo: { inicio: inicio, fim: fim }, vendedores: vendedores, totalPedidos: totalPedidos };
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

app.get("/debug/:numero", async (req, res) => {
  if (!accessToken) return res.status(401).json({ erro: "Nao autenticado." });
  try {
    const lista = await axios.get("https://api.bling.com.br/Api/v3/pedidos/vendas", {
      headers: { Authorization: "Bearer " + accessToken },
      params: { numero: req.params.numero, pagina: 1, limite: 1 },
    });
    const pedido = lista.data.data && lista.data.data[0];
    if (!pedido) return res.json({ erro: "Pedido nao encontrado" });
    const d = await buscarDetalhe(pedido.id);
    res.json({ numero: d.numero, vendedor: d.vendedor, total: d.total, totalProdutos: d.totalProdutos });
  } catch (err) {
    res.status(500).json({ erro: err.response && err.response.data ? err.response.data : err.message });
  }
});

app.get("/cache/limpar", (req, res) => {
  Object.keys(cache).forEach(function(k) { delete cache[k]; });
  res.json({ ok: true, msg: "Cache limpo!" });
});

app.get("/status", (req, res) => {
  const caches = Object.keys(cache).map(function(k) {
    return { periodo: k, idadeMinutos: Math.round((Date.now() - cache[k].ts) / 60000), valido: cacheValido(k) };
  });
  res.json({ ok: true, autenticado: !!accessToken, caches: caches });
});

async function preCarregarCache() {
  if (!accessToken) return;
  const inicio = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const fim = new Date().toISOString().slice(0, 10);
  const key = cacheKey(inicio, fim);
  if (cacheValido(key)) { console.log("Cache ja valido."); return; }
  console.log("Pre-carregando cache...");
  try {
    const resultado = await buscarPedidos(inicio, fim);
    const { vendedores, totalPedidos } = await processarPedidos(resultado);
    const resposta = { periodo: { inicio: inicio, fim: fim }, vendedores: vendedores, totalPedidos: totalPedidos };
    cache[key] = { data: resposta, ts: Date.now() };
    console.log("Cache pre-carregado! " + totalPedidos + " pedidos.");
  } catch (e) {
    console.error("Erro no pre-carregamento:", e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Servidor rodando na porta " + PORT);

  setInterval(async function() {
    try {
      await axios.get("https://dashboard-metas.onrender.com/status");
      console.log("Auto-ping OK");
    } catch (e) {
      console.log("Auto-ping falhou:", e.message);
    }
  }, 14 * 60 * 1000);

  setInterval(async function() {
    if (refreshToken) {
      console.log("Renovando token...");
      await renovarToken();
      setTimeout(preCarregarCache, 3000);
    }
  }, 5 * 60 * 60 * 1000);

  setInterval(function() { preCarregarCache(); }, 30 * 60 * 1000);
});
