const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { sendSuccess, sendError } = require("../utils/response");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerPath = process.env.AZURE_STORAGE_CONTAINER_NAME || "imagesmay2025/inventory-folder";
const [containerName, ...folderParts] = containerPath.split("/");
const baseFolder = folderParts.length > 0 ? folderParts.join("/") : "";

exports.uploadMiddleware = upload.single("file");

exports.upload = async (req, res) => {
  try {
    if (!connectionString) return sendError(res, "Azure Storage not configured", 500);

    const file = req.file;
    if (!file) return sendError(res, "No file provided", 400);
    if (!file.mimetype.startsWith("image/")) return sendError(res, "Only image files are allowed", 400);

    const type = req.query.type;
    let folderPrefix = baseFolder ? baseFolder + "/" : "";
    if (type === "label") folderPrefix += "label-photos/";
    else if (type === "damage") folderPrefix += "damage-photos/";

    const ext = file.originalname?.split(".").pop()?.toLowerCase() || "jpg";
    const blobName = `${folderPrefix}${uuidv4()}.${ext}`;

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const cClient = blobServiceClient.getContainerClient(containerName);
    await cClient.createIfNotExists({ access: "blob" });

    const blockBlobClient = cClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadData(file.buffer, { blobHTTPHeaders: { blobContentType: file.mimetype } });

    return sendSuccess(res, { url: blockBlobClient.url });
  } catch (err) {
    console.error("File upload error:", err);
    return sendError(res, err.message || "Failed to upload file");
  }
};

