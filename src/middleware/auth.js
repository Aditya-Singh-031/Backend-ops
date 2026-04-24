const jwt = require("jsonwebtoken");
const { sendError } = require("../utils/response");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1d";

function extractToken(req) {
  if (req.cookies && req.cookies.token) return req.cookies.token;
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) return authHeader.split(" ")[1];
  return null;
}

function authMiddleware(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return sendError(res, "Authentication required", 401);
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return sendError(res, "Invalid or expired token", 401);
  }
}


function generateToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { authMiddleware, generateToken, verifyToken, extractToken };
