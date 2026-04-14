const { getDb } = require("../config/db");

exports.getStats = async (req, res) => {
  // Empty scaffolding to fix 404 - will connect to DB later
  res.json({
    totalInvoices: 0,
    pendingVerification: 0,
    verified: 0,
    recentActivity: []
  });
};

exports.getSuppliers = async (req, res) => {
  // Empty scaffolding to fix 404
  res.json([]);
};