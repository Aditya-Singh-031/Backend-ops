const bcrypt = require("bcryptjs");
const { getDb } = require("../config/db");
const { generateToken } = require("../middleware/auth");
const { sendSuccess, sendError } = require("../utils/response");
const { ObjectId } = require("mongodb");

exports.login = async (req, res) => {
  const { email, password } = req.body;
  const db = await getDb();
  const user = await db.collection("users").findOne({
    $or: [{ email }, { username: email }],
  });

  if (!user || !(await bcrypt.compare(password, user.hashed_password))) {
    return sendError(res, "Invalid credentials", 400);
  }

  const token = generateToken(user);
  await db.collection("users").updateOne(
    { _id: user._id },
    { $set: { last_login: new Date() } }
  );

  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 24 * 60 * 60 * 1000,
  });

  return sendSuccess(res, {
    token,
    access_token: token,
    user: {
      id: user._id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role,
    },
  });
};

exports.me = async (req, res) => {
  const db = await getDb();
  const user = await db.collection("users").findOne(
    { _id: new ObjectId(req.user.id) },
    { projection: { hashed_password: 0 } }
  );
  if (!user) return sendError(res, "User not found", 404);
  return sendSuccess(res, { user });
};

exports.logout = (_req, res) => {
  res.clearCookie("token");
  return sendSuccess(res, { message: "Logged out" });
};
