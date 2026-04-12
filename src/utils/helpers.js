/** Wrap async route handler to catch errors */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function safeParseFloat(val) {
  if (!val) return 0;
  const clean = String(val).replace(/[,₹$\s]/g, "");
  const num = parseFloat(clean);
  return isNaN(num) ? 0 : num;
}

function toBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  const normalized = String(value || "").toLowerCase().trim();
  return normalized === "true" || normalized === "on" || normalized === "yes";
}

function parseDateOnly(val) {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  const str = String(val).trim();
  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (ymdMatch) {
    return new Date(Number(ymdMatch[1]), Number(ymdMatch[2]) - 1, Number(ymdMatch[3]));
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? new Date() : d;
}

function sanitizeFilename(name) {
  if (!name) return "document";
  return String(name).trim().replace(/[\n\r]/g, "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeHeaderKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  asyncHandler,
  safeParseFloat,
  toBoolean,
  parseDateOnly,
  sanitizeFilename,
  normalizeHeaderKey,
  hasValue,
  escapeRegex,
};
