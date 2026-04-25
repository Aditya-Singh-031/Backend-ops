const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");

exports.getStats = async (req, res) => {
  try {
    const db = await getDb();
    
    const userCount = await db.collection("users").countDocuments({});
    const invoiceCount = await db.collection("invoices").countDocuments({});
    const supplierCount = await db.collection("suppliers").countDocuments({});
    const poCount = await db.collection("purchase_orders").countDocuments({});
    
    return sendSuccess(res, {
        users: userCount,
        invoices_parsed: invoiceCount,
        suppliers: supplierCount,
        purchase_orders: poCount,
        active_jobs: 0 
    });
  } catch (error) {
    console.error("Stats Error:", error);
    return sendError(res, "Failed to fetch stats");
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
    return sendSuccess(res, results);

  } catch (error) {
    console.error("Suppliers Error:", error);
    return sendError(res, "Failed to fetch suppliers");
  }
};

exports.getSupplierById = async (req, res) => {
  try {
    const db = await getDb();
    const oid = toObjectId(req.params.id);
    if (!oid) return sendError(res, "Invalid supplier ID", 400);

    const supplier = await db.collection("suppliers").findOne({ _id: oid });
    if (!supplier) return sendError(res, "Supplier not found", 404);

    // Enrich with invoice count
    const invoiceCount = await db.collection("invoices").countDocuments({ vendor_name: supplier.supp_name });
    return sendSuccess(res, { ...supplier, invoice_count: invoiceCount });
  } catch (error) {
    console.error("GetSupplierById Error:", error);
    return sendError(res, "Failed to fetch supplier details");
  }
};

exports.updateSupplier = async (req, res) => {
  try {
    const db = await getDb();
    const oid = toObjectId(req.params.id);
    if (!oid) return sendError(res, "Invalid supplier ID", 400);

    const { supp_name, gstin, address_lines, city, contact_name, contact_email, contact_phone } = req.body;
    if (!supp_name) return sendError(res, "Supplier name is required", 400);

    await db.collection("suppliers").updateOne(
      { _id: oid },
      {
        $set: {
          supp_name,
          gstin: gstin || "",
          address: { address_lines: address_lines || "", city: city || "" },
          contact: { name: contact_name || "", email: contact_email || "", phone: contact_phone || "" },
          updated_at: new Date(),
        }
      }
    );

    const updated = await db.collection("suppliers").findOne({ _id: oid });
    return sendSuccess(res, updated);
  } catch (error) {
    console.error("UpdateSupplier Error:", error);
    return sendError(res, "Failed to update supplier");
  }
};