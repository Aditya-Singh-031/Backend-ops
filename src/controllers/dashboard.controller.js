const { getDb } = require("../config/db");
const { sendSuccess } = require("../utils/response");

exports.getStats = async (req, res) => {
  // Returns properly wrapped empty data so the frontend doesn't crash
  sendSuccess(res, {
    totalInvoices: 0,
    pendingVerification: 0,
    verified: 0,
    recentActivity: []
  });
};

exports.getSuppliers = async (req, res) => {
  // Wrapped as { success: true, data: [] }
  sendSuccess(res, []);
};