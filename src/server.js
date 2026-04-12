require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const { connectDb } = require("./config/db");

const app = express();

// ── Middleware ────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS)
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());

app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

// ── Health check ─────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ── Routes ───────────────────────────────────────────
app.use("/api", require("./routes"));

// ── Global error handler ─────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
  });
});

// ── Start ────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

async function start() {
  await connectDb();
  app.listen(PORT, () => {
    console.log(`ops-backend running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
