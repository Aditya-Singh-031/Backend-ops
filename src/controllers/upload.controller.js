const path = require("path");
const { uploadToAzure } = require("../config/azure");
const { sendSuccess, sendError } = require("../utils/response");

exports.upload = async (req, res) => {
  if (!req.file) return sendError(res, "No image file provided", 400);

  const safeName = path.basename(req.file.originalname).replace(/\s+/g, "-");
  const blobName = `${Date.now()}-${safeName}`;
  const url = await uploadToAzure(req.file.buffer, blobName, req.file.mimetype);
  return sendSuccess(res, { message: "Upload successful", url });
};

