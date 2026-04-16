require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const { connectDb } = require("./config/db");
const { createProxyMiddleware } = require("http-proxy-middleware"); // 💥 Added Proxy

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

// 💥 THE MAGIC TRICK: Forward AI/Parsing routes to Python (Port 8000)
// This MUST be placed before express.json() so PDF file streams don't break
// 💥 THE MAGIC TRICK: Forward AI/Parsing routes to Python (Port 8000)
// ... (keep top imports and CORS)

// 💥 THE MAGIC TRICK: Forward AI/Parsing routes to Python Docker (Port 8000)
// Must be BEFORE express.json() so it doesn't corrupt PDF uploads
app.use(
  "/api/invoices", 
  createProxyMiddleware({
    target: "http://127.0.0.1:8000",
    changeOrigin: true,
    pathRewrite: {
      "^/api/invoices": "/api/v1/invoices", // Rewrites /api/invoices -> /api/v1/invoices for Docker
    },
    onProxyReq: (proxyReq, req, res) => {
       // Log to terminal so you can see traffic moving to Docker
       console.log(`[Proxy] Forwarding ${req.method} ${req.url} to Python Docker...`);
    }
  })
);

app.use(express.json({ limit: "50mb" }));
// ... (rest of your file)
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