require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const { connectDb } = require("./config/db");
// ... (top of file)
const { createProxyMiddleware } = require("http-proxy-middleware");
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

// 💥 Forward AI/Parsing routes to Python Docker
app.use(
  "/api/invoices",
  createProxyMiddleware({
    target: "http://127.0.0.1:8000/api/v1/invoices",
    changeOrigin: true,
    onProxyRes: (proxyRes) => {
      proxyRes.headers['connection'] = 'keep-alive';
      proxyRes.headers['cache-control'] = 'no-cache';
    }
  })
);

// 💥 NEW: Forward PDF requests directly to Python's static file server
app.use(
  "/storage",
  createProxyMiddleware({
    target: "http://127.0.0.1:8000",
    changeOrigin: true,
    // Python serves files at http://127.0.0.1:8000/storage/...
    // So if Node gets /storage/pdfs/file.pdf, it passes it exactly as-is.
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