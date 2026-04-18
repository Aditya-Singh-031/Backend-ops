require("dotenv").config();
const { MongoClient } = require("mongodb");
async function run() {
  const uri = process.env.MONGO_URI;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGO_DB);
  const collections = await db.listCollections().toArray();
  console.log("Collections:", collections.map(c => c.name));
  
  const companies = await db.collection("companies").find().count();
  const buyers = await db.collection("buyers").find().count();
  console.log("companies count:", companies);
  console.log("buyers count:", buyers);
  
  if (buyers > 0) {
      console.log(await db.collection("buyers").findOne());
  }
  
  process.exit(0);
}
run().catch(console.error);
