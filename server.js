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

// ─── Buscar pedidos de venda por período ──────────────────────────────
app.get("/vendas", async (req, res) => {
  if (!accessToken) return res.status(401).json({ erro: "Não autenticado. Acesse /auth primeiro." });

  const { dataInicio, dataFim } = req.query;
  const inicio = dataInicio || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const fim = dataFim || new Date().toISOString().slice(0, 10);

  try {
    let pagina = 1;
    let todosPedidos = [];

    while (true) {
      const response = await axios.get("https://www.bling.com.br/Api/v3/pedidos/vendas", {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { dataInicio: inicio, dataFim: fim, pagina, limite: 100 },
      });

      const pedidos = response.data.data || [];
      todosPedidos = [...todosPedidos, ...pedidos];
      if (pedidos.length < 100) break;
      pagina++;
    }

    // Agrupar por vendedor
    const porVendedor = {};
    for (const pedido of todosPedidos) {
      const vendedor = pedido.vendedor?.nome || "Sem vendedor";
      if (!porVendedor[vendedor]) {
        porVendedor[vendedor] = { nome: vendedor, faturamento: 0, pedidos: 0, pecas: 0, valorPedidos: [] };
      }
      const valor = pedido.totalProdutos || 0;
      porVendedor[vendedor].faturamento += valor;
      porVendedor[vendedor].pedidos += 1;
      porVendedor[vendedor].pecas += (pedido.itens || []).reduce((s, i) => s + (i.quantidade || 0), 0);
      porVendedor[vendedor].valorPedidos.push(valor);
    }

    // Calcular ticket médio
    const resultado = Object.values(porVendedor).map(v => ({
      ...v,
      ticketMedio: v.pedidos > 0 ? v.faturamento / v.pedidos : 0,
      valorPedidos: undefined,
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

// ─── Status ───────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({ ok: true, autenticado: !!accessToken });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
