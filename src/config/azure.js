const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerPath = process.env.AZURE_STORAGE_CONTAINER_NAME || "imagesmay2025";
const [containerName, ...folderParts] = containerPath.split("/");
const baseFolder = folderParts.length > 0 ? folderParts.join("/") : "";

async function uploadToAzure(buffer, originalName, mimeType, subfolder) {
  if (!connectionString) {
    throw new Error("Azure Storage not configured (AZURE_STORAGE_CONNECTION_STRING missing)");
  }

  let folderPrefix = baseFolder ? baseFolder + "/" : "";
  if (subfolder) folderPrefix += subfolder + "/";

  const ext = originalName?.split(".").pop()?.toLowerCase() || "bin";
  const blobName = `${folderPrefix}${uuidv4()}.${ext}`;

  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobServiceClient.getContainerClient(containerName);
  await containerClient.createIfNotExists({ access: "blob" });

  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: mimeType },
  });

  return blockBlobClient.url;
}

async function uploadFilePathToAzure(localFilePath, originalName, mimeType) {
  const fs = require("fs");
  const buffer = fs.readFileSync(localFilePath);
  return uploadToAzure(buffer, originalName, mimeType);
}

module.exports = { uploadToAzure, uploadFilePathToAzure };
