const { getDb } = require("../config/db");
const { sendSuccess } = require("../utils/response");

exports.getBrands = async (req, res) => {
  // Temporary empty array to stop the 404. We will connect the Excel logic here later.
  sendSuccess(res, []);
};

exports.createBrand = async (req, res) => {
  // Scaffolding for brand creation
  sendSuccess(res, { id: "temp-123", name: req.body.name, total_parts: 0 });
};