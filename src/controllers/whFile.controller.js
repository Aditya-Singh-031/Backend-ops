const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerPath = process.env.AZURE_STORAGE_CONTAINER_NAME || "imagesmay2025/inventory-folder";
const [containerName, ...folderParts] = containerPath.split("/");
const baseFolder = folderParts.length > 0 ? folderParts.join("/") : "";

exports.uploadMiddleware = upload.single("file");

exports.upload = async (req, res) => {
  try {
    if (!connectionString) return res.status(500).json({ error: "Azure Storage not configured" });

    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file provided" });
    if (!file.mimetype.startsWith("image/")) return res.status(400).json({ error: "Only image files are allowed" });

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

    return res.json({ success: true, url: blockBlobClient.url });
  } catch (err) {
    console.error("File upload error:", err);
    return res.status(500).json({ error: err.message || "Failed to upload file" });
  }
};
