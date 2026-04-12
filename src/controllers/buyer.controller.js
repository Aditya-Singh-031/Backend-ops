const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");
const { escapeRegex } = require("../utils/helpers");

exports.create = async (req, res) => {
  const db = await getDb();
  const buyer = {
    ...req.body,
    is_deleted: false,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const result = await db.collection("buyers").insertOne(buyer);
  buyer._id = result.insertedId;
  return sendSuccess(res, { buyer }, 201);
};

exports.list = async (req, res) => {
  const db = await getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const search = req.query.search;

  const query = { is_deleted: { $ne: true } };
  if (search) {
    const escaped = escapeRegex(search);
    query.$or = [
      { cust_name: { $regex: escaped, $options: "i" } },
      { cust_id: { $regex: escaped, $options: "i" } },
    ];
  }

  const skip = (page - 1) * limit;
  const [buyers, total] = await Promise.all([
    db.collection("buyers").find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
    db.collection("buyers").countDocuments(query),
  ]);

  return sendSuccess(res, {
    buyers,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

exports.getById = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const buyer = await db.collection("buyers").findOne({ _id: oid, is_deleted: { $ne: true } });
  if (!buyer) return sendError(res, "Buyer not found", 404);
  return sendSuccess(res, { buyer });
};

exports.update = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const value = { ...req.body, updated_at: new Date() };
  const result = await db.collection("buyers").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $set: value },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Buyer not found", 404);
  return sendSuccess(res, { buyer: result });
};

exports.remove = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const result = await db.collection("buyers").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $set: { is_deleted: true, updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Buyer not found", 404);
  return sendSuccess(res, { message: "Buyer deleted successfully" });
};
