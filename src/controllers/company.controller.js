const { getDb, toObjectId } = require("../config/db");
const { sendSuccess } = require("../utils/response");

exports.list = async (_req, res) => {
  const db = await getDb();
  const companies = await db.collection("companies").find({}).sort({ name: 1 }).toArray();
  return sendSuccess(res, companies);
};

exports.create = async (req, res) => {
  const db = await getDb();
  const company = {
    ...req.body,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const result = await db.collection("companies").insertOne(company);
  company._id = result.insertedId;
  return sendSuccess(res, company, 201);
};
