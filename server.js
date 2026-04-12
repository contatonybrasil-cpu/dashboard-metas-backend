const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.BLING_CLIENT_ID;
const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

let accessToken = null;
let refreshToken = null;

// ─── Autenticação OAuth2 ───────────────────────────────────────────────
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
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
      { headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" } }
    );
    accessToken = response.data.access_token;
    refreshToken = response.data.refresh_token;
    res.send("✅ Conectado ao Bling com sucesso! Pode fechar esta aba e usar o dashboard.");
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

// ─── Mapeamento de códigos de vendedor ───────────────────────────────
const VENDEDORES = {
  "v17":  "Felipe",
  "vp3":  "Giovana",
  "vp4":  "Guilherme",
  "":     "Gerentes",
};

function nomeVendedor(codigo) {
  if (!codigo) return "Gerentes";
  const c = codigo.trim().toLowerCase();
  for (const [key, nome] of Object.entries(VENDEDORES)) {
    if (key && c === key.toLowerCase()) return nome;
  }
  return codigo; // retorna o código se não encontrar
}

// ─── Buscar pedidos de venda por período ──────────────────────────────
app.get("/vendas", async (req, res) => {
  if (!accessToken) return res.status(401).json({ erro: "Não autenticado. Acesse /auth primeiro." });

  const { dataInicio, dataFim } = req.query;
  const inicio = dataInicio || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const fim = dataFim || new Date().toISOString().slice(0, 10);

  try {
    let pagina = 1;
    let todosPedidos = [];

    const delay = ms => new Promise(r => setTimeout(r, ms));

    while (true) {
      const response = await axios.get("https://www.bling.com.br/Api/v3/pedidos/vendas", {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { dataInicial: inicio, dataFinal: fim, pagina, limite: 100 },
      });

      const pedidos = response.data.data || [];
      todosPedidos = [...todosPedidos, ...pedidos];
      if (pedidos.length < 100) break;
      pagina++;
      await delay(400); // respeita o limite de 3 req/segundo do Bling
    }

    // Buscar detalhes de cada pedido para obter vendedor e itens
    const porVendedor = {};
    for (const pedido of todosPedidos) {
      let codigoVendedor = "";
      let pecas = 0;

      try {
        const det = await axios.get(`https://www.bling.com.br/Api/v3/pedidos/vendas/${pedido.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const d = det.data.data || {};
        codigoVendedor = d.vendedor?.nome || d.vendedor?.codigo || "";
        pecas = (d.itens || []).reduce((s, i) => s + (Number(i.quantidade) || 0), 0);
        await delay(400);
      } catch (e) {
        // se falhar, ignora e continua
      }

      const nome = nomeVendedor(codigoVendedor);
      if (!porVendedor[nome]) {
        porVendedor[nome] = { nome, faturamento: 0, pedidos: 0, pecas: 0 };
      }
      const valor = pedido.totalProdutos || pedido.total || 0;
      porVendedor[nome].faturamento += valor;
      porVendedor[nome].pedidos += 1;
      porVendedor[nome].pecas += pecas;
    }

    // Calcular ticket médio
    const resultado = Object.values(porVendedor).map(v => ({
      ...v,
      ticketMedio: v.pedidos > 0 ? +(v.faturamento / v.pedidos).toFixed(2) : 0,
      faturamento: +v.faturamento.toFixed(2),
    }));

    res.json({ periodo: { inicio, fim }, vendedores: resultado, totalPedidos: todosPedidos.length });
  } catch (err) {
    if (err.response?.status === 401) {
      await renovarToken();
      return res.status(401).json({ erro: "Token renovado, tente novamente." });
    }
    const detalhe = err.response?.data || err.message;
    console.error("ERRO BLING:", JSON.stringify(detalhe));
    res.status(500).json({ erro: "Erro ao buscar vendas no Bling.", detalhe });
  }
});

// ─── Debug: ver detalhe completo de um pedido por ID ─────────────────
app.get("/debug", async (req, res) => {
  if (!accessToken) return res.status(401).json({ erro: "Não autenticado." });
  try {
    // Pega o ID do primeiro pedido de abril
    const lista = await axios.get("https://www.bling.com.br/Api/v3/pedidos/vendas", {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { dataInicial: "2026-04-01", dataFinal: "2026-04-12", pagina: 1, limite: 1 },
    });
    const primeiroPedido = lista.data.data?.[0];
    if (!primeiroPedido) return res.json({ erro: "Nenhum pedido encontrado" });

    // Busca o detalhe completo pelo ID
    const detalhe = await axios.get(`https://www.bling.com.br/Api/v3/pedidos/vendas/${primeiroPedido.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    res.json(detalhe.data);
  } catch (err) {
    res.status(500).json({ erro: err.response?.data || err.message });
  }
});

// ─── Status ───────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({ ok: true, autenticado: !!accessToken });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
