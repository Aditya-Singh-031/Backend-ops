const { getDb } = require("../config/db");
const { sendSuccess } = require("../utils/response");

exports.getList = async (req, res) => {
  sendSuccess(res, {
    operations: [],
    pagination: { page: 1, limit: 50, total: 0 }
  });
};