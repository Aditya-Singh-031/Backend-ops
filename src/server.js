require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const { connectDb } = require("./config/db");

const app = express();

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : ["https://ops-frontend.morsebiz.com", "http://localhost:5004"];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
// ... (top of file)
const { createProxyMiddleware } = require("http-proxy-middleware");

// 💥 Forward AI/Parsing routes to Python Docker (Port 8000)
app.use(
  "/api/invoices",
  createProxyMiddleware({
    target: "http://127.0.0.1:8000",
    changeOrigin: true,
    // THE FIX: Use a simple string dictionary. This tells the proxy:
    // "Whatever is handed to me, prepend /api/v1/invoices to it."
    pathRewrite: {
      "^/api/invoices": "/api/v1/invoices"
    },
    onProxyRes: (proxyRes) => {
      // Keep SSE connections alive through the proxy
      proxyRes.headers['connection'] = 'keep-alive';
      proxyRes.headers['cache-control'] = 'no-cache';
    },
    // Optional: Log errors if the proxy fails to connect to Python
    onError: (err, req, res) => {
      console.error("Proxy Error:", err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Proxy Error: Could not connect to Python backend.');
    }
  })
);

// Body parsers MUST stay below the proxy!
app.use(express.json({ limit: "50mb" }));
// ... (rest of file)
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());

app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.use("/api", require("./routes"));

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ error: err.message });
});

const PORT = process.env.PORT || 5003;

async function start() {
  await connectDb();
  app.listen(PORT, () => {
    console.log(`ops-backend running on port ${PORT}`);
  });
}

start().catch(console.error);