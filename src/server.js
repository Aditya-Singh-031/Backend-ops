require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const { connectDb } = require("./config/db");
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
// Body parsers MUST stay below the proxy!
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());

// New uploads: storage/uploads/ served at /api/uploads
app.use("/api/uploads", express.static(path.join(__dirname, "..", "storage", "uploads")));

// Old uploads (backward compat): uploads/ folder, files have no extension — force PDF content-type
app.use("/uploads", (req, _res, next) => {
  // If URL has no extension, it's an old multer file — tell browser it's a PDF
  if (!path.extname(req.path)) {
    _res.setHeader("Content-Type", "application/pdf");
    _res.setHeader("Content-Disposition", "inline");
  }
  next();
}, express.static(path.join(__dirname, "..", "uploads")));

// Legacy storage path
app.use("/api/storage", express.static(path.join(__dirname, "..", "storage")));

const { sendSuccess, sendError } = require("./utils/response");

app.get("/api/health", (_req, res) => {
  return sendSuccess(res, { status: "ok", time: new Date().toISOString() });
});

app.use("/api", require("./routes"));

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  return sendError(res, err.message, err.status || 500);
});


const PORT = process.env.PORT || 5003;

async function start() {
  await connectDb();
  app.listen(PORT, () => {
    console.log(`ops-backend running on port ${PORT}`);
  });
}

start().catch(console.error);