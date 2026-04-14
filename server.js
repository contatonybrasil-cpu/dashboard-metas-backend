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
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&state=dashboard`;
  res.redirect(url);
});

app.get("/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const response = await axios.post(
      "https://www.bling.com.br/Api/v3/oauth/token",
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
      "https://www.bling.com.br/Api/v3/oauth/token",
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
};

function nomeVendedor(id) {
  if (!id || id === 0) return "Gerentes";
  return VENDEDORES[id] || ("Vendedor " + id);
}

async function buscarDetalhe(id, tentativas) {
  tentativas = tentativas || 3;
  for (var i = 0; i < tentativas; i++) {
    try {
      const det = await axios.get("https://www.bling.com.br/Api/v3/pedidos/vendas/" + id, {
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

async function buscarPedidos(inicio, fim) {
  var pagina = 1;
  var todos = [];
  while (true) {
    const response = await axios.get("https://www.bling.com.br/Api/v3/pedidos/vendas", {
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

async function processarPedidos(todosPedidos) {
  var porVendedor = {};
  for (var i = 0; i < todosPedidos.length; i++) {
    var pedido = todosPedidos[i];
    const d = await buscarDetalhe(pedido.id);
    const codigoVendedor = d.vendedor && d.vendedor.id ? d.vendedor.id : 0;
    var pecas = 0;
    if (d.itens) {
      for (var j = 0; j < d.itens.length; j++) {
        pecas += Number(d.itens[j].quantidade) || 0;
      }
    }
    await delay(400);
    const nome = nomeVendedor(codigoVendedor);
    if (!porVendedor[nome]) porVendedor[nome] = { nome: nome, faturamento: 0, pedidos: 0, pecas: 0 };
    porVendedor[nome].faturamento += pedido.total || 0;
    porVendedor[nome].pedidos += 1;
    porVendedor[nome].pecas += pecas;
  }
  return Object.values(porVendedor).map(function(v) {
    return {
      nome: v.nome,
      faturamento: +v.faturamento.toFixed(2),
      pedidos: v.pedidos,
      pecas: v.pecas,
      ticketMedio: v.pedidos > 0 ? +(v.faturamento / v.pedidos).toFixed(2) : 0,
    };
  });
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
    const todosPedidos = await buscarPedidos(inicio, fim);
    const vendedores = await processarPedidos(todosPedidos);
    const resposta = { periodo: { inicio: inicio, fim: fim }, vendedores: vendedores, totalPedidos: todosPedidos.length };
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
    const lista = await axios.get("https://www.bling.com.br/Api/v3/pedidos/vendas", {
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
    const todosPedidos = await buscarPedidos(inicio, fim);
    const vendedores = await processarPedidos(todosPedidos);
    const resposta = { periodo: { inicio: inicio, fim: fim }, vendedores: vendedores, totalPedidos: todosPedidos.length };
    cache[key] = { data: resposta, ts: Date.now() };
    console.log("Cache pre-carregado! " + todosPedidos.length + " pedidos.");
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
