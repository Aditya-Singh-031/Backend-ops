const { getDb } = require("../config/db");

exports.getList = async (req, res) => {
  // Empty scaffolding to fix 404
  res.json({
    operations: [],
    pagination: { page: 1, limit: 50, total: 0 }
  });
};