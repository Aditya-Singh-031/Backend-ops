const bcrypt = require("bcryptjs");
const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");

exports.list = async (_req, res) => {
  const db = await getDb();
  const users = await db
    .collection("users")
    .find({}, { projection: { hashed_password: 0 } })
    .sort({ created_at: -1 })
    .toArray();
  return sendSuccess(res, { users });
};

exports.create = async (req, res) => {
  const { name, email, username, role, status, password } = req.body;
  const db = await getDb();

  const existing = await db.collection("users").findOne({
    $or: [{ email }, { username: username || email }],
  });
  if (existing) return sendError(res, "User already exists", 409);

  const hashed_password = await bcrypt.hash(password, 10);
  const user = {
    name: name || "",
    email,
    username: username || email,
    role: role || "user",
    status: status || "active",
    hashed_password,
    created_at: new Date(),
  };

  const result = await db.collection("users").insertOne(user);
  user._id = result.insertedId;
  delete user.hashed_password;
  return sendSuccess(res, { user }, 201);
};

exports.update = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid user ID", 400);

  const db = await getDb();
  const update = {};
  const { name, email, username, role, status, password } = req.body;

  if (name !== undefined) update.name = name;
  if (email !== undefined) update.email = email;
  if (username !== undefined) update.username = username;
  if (role !== undefined) update.role = role;
  if (status !== undefined) update.status = status;
  if (password) update.hashed_password = await bcrypt.hash(password, 10);

  if (Object.keys(update).length === 0) return sendError(res, "No fields to update", 400);

  const result = await db
    .collection("users")
    .findOneAndUpdate({ _id: oid }, { $set: update }, { returnDocument: "after", projection: { hashed_password: 0 } });

  if (!result) return sendError(res, "User not found", 404);
  return sendSuccess(res, { user: result });
};

exports.remove = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid user ID", 400);

  const db = await getDb();
  const result = await db.collection("users").deleteOne({ _id: oid });
  if (result.deletedCount === 0) return sendError(res, "User not found", 404);
  return sendSuccess(res, { message: "User deleted" });
};
