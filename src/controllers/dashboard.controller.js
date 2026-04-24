const { getDb } = require("../config/db");

exports.getStats = async (req, res) => {
  try {
    const db = await getDb();
    
    const userCount = await db.collection("users").countDocuments({});
    const invoiceCount = await db.collection("invoices").countDocuments({});
    const supplierCount = await db.collection("suppliers").countDocuments({});
    const poCount = await db.collection("purchase_orders").countDocuments({});
    
    // Return direct JSON to match Python API format for the frontend
    res.json({
        users: userCount,
        invoices_parsed: invoiceCount,
        suppliers: supplierCount,
        purchase_orders: poCount,
        active_jobs: 0 
    });
  } catch (error) {
    console.error("Stats Error:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
};

exports.getSuppliers = async (req, res) => {
  try {
    const db = await getDb();

    // 1. Auto-sync logic
    const pipeline = [
        { $match: { vendor_name: { $ne: null } } },
        { $group: { _id: "$vendor_name", gstin: { $first: "$vendor_gstin" } } }
    ];

    const uniqueVendors = await db.collection("invoices").aggregate(pipeline).toArray();

    for (const doc of uniqueVendors) {
        const vendorName = doc._id;
        if (vendorName) {
            const exists = await db.collection("suppliers").findOne({ supp_name: vendorName });
            if (!exists) {
                await db.collection("suppliers").insertOne({
                    supp_name: vendorName,
                    gstin: doc.gstin || "",
                    address: { address_lines: "", city: "" },
                    brands: [],
                    contact: { name: "", email: "", phone: "" },
                    created_at: new Date(),
                    updated_at: new Date()
                });
            }
        }
    }

    // 2. Fetch data for UI
    const aggPipeline = [
        {
            $lookup: {
                from: "invoices",
                localField: "supp_name",
                foreignField: "vendor_name",
                as: "invoice_docs"
            }
        },
        {
            $project: {
                _id: 0,
                id: { $toString: "$_id" },
                name: "$supp_name",
                gstin: "$gstin",
                invoice_count: { $size: "$invoice_docs" },
                last_active: "$updated_at"
            }
        },
        { $sort: { invoice_count: -1 } }
    ];

    const results = await db.collection("suppliers").aggregate(aggPipeline).toArray();
    res.json(results);

  } catch (error) {
    console.error("Suppliers Error:", error);
    res.status(500).json({ error: "Failed to fetch suppliers" });
  }
};