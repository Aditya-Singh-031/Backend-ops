function sendSuccess(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data: data ?? null });
}

function sendError(res, error, statusCode = 500) {
  return res.status(statusCode).json({ success: false, error });
}

module.exports = { sendSuccess, sendError };
