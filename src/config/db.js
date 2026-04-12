const { MongoClient, ObjectId } = require("mongodb");

const uri = process.env.MONGO_URI;
if (!uri) {
  throw new Error("MONGO_URI environment variable is required");
}

const DB_NAME = process.env.MONGO_DB || "morsebiz-ops-prod";

let _client = null;
let _connectPromise = null;

async function getClient() {
  if (_client) {
    try {
      await _client.db("admin").command({ ping: 1 });
      return _client;
    } catch {
      console.warn("MongoDB connection lost, reconnecting…");
      try { await _client.close(); } catch { /* ignore */ }
      _client = null;
      _connectPromise = null;
    }
  }

  if (!_connectPromise) {
    _connectPromise = (async () => {
      const client = new MongoClient(uri, {
        maxPoolSize: 20,
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 10000,
      });
      await client.connect();
      console.log(`MongoDB connected → ${DB_NAME}`);

      client.on("close", () => {
        console.warn("MongoDB client closed unexpectedly");
        _client = null;
        _connectPromise = null;
      });

      _client = client;
      return client;
    })().catch((err) => {
      _connectPromise = null;
      _client = null;
      throw err;
    });
  }

  return _connectPromise;
}

/** Get the single database */
async function getDb() {
  const client = await getClient();
  return client.db(DB_NAME);
}

/** Helper to convert string to ObjectId safely */
function toObjectId(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === "string" && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Connect to MongoDB (call once at startup) */
async function connectDb() {
  await getClient();
}

module.exports = { connectDb, getClient, getDb, toObjectId, ObjectId };
