const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");
const { escapeRegex } = require("../utils/helpers");

exports.create = async (req, res) => {
  const db = await getDb();
  const existing = await db.collection("product_master").findOne({
    part_number: req.body.part_number,
    is_deleted: { $ne: true },
  });
  if (existing) return sendError(res, `Part number '${req.body.part_number}' already exists`, 409);

  const product = {
    ...req.body,
    is_deleted: false,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const result = await db.collection("product_master").insertOne(product);
  product._id = result.insertedId;
  return sendSuccess(res, { product }, 201);
};

exports.list = async (req, res) => {
  const db = await getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const { search, brand } = req.query;

  const query = { is_deleted: { $ne: true } };
  if (brand) query.brand = brand;
  if (search) {
    const escaped = escapeRegex(search);
    query.$or = [
      { part_number: { $regex: escaped, $options: "i" } },
      { description: { $regex: escaped, $options: "i" } },
      { brand: { $regex: escaped, $options: "i" } },
    ];
  }

  const skip = (page - 1) * limit;
  const [products, total] = await Promise.all([
    db.collection("product_master").find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
    db.collection("product_master").countDocuments(query),
  ]);

  return sendSuccess(res, {
    products,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

exports.getByPartNumber = async (req, res) => {
  const db = await getDb();
  const product = await db.collection("product_master").findOne({
    part_number: req.params.partNumber,
    is_deleted: { $ne: true },
  });
  if (!product) return sendError(res, "Product not found", 404);
  return sendSuccess(res, { product });
};

exports.getById = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const product = await db.collection("product_master").findOne({ _id: oid, is_deleted: { $ne: true } });
  if (!product) return sendError(res, "Product not found", 404);
  return sendSuccess(res, { product });
};

exports.update = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const value = { ...req.body, updated_at: new Date() };
  const result = await db.collection("product_master").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $set: value },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Product not found", 404);
  return sendSuccess(res, { product: result });
};

exports.remove = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const result = await db.collection("product_master").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $set: { is_deleted: true, updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Product not found", 404);
  return sendSuccess(res, { message: "Product deleted successfully" });
};
