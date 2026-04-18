const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");
const { v4: uuidv4 } = require("uuid");

/**
 * Recalculate quantity_filled and quantity_pending for every item in an order
 * by summing qty_fulfilled across ALL outward_order_joins that reference this order.
 * This ensures correctness even when multiple outwards contribute to the same order.
 */
async function recalculateOrderFulfillment(db, orderOid, orderDetailDoc) {
  const allJoins = await db
    .collection("outward_order_joins")
    .find({ order_id: orderOid })
    .toArray();

  // Sum fulfilled per part_number across all joins
  const fulfilledMap = {};
  allJoins.forEach((join) => {
    (join.fulfilled_items || []).forEach((fi) => {
      if (fi.part_number) {
        fulfilledMap[fi.part_number] =
          (fulfilledMap[fi.part_number] || 0) + (Number(fi.qty_fulfilled) || 0);
      }
    });
  });

  const updatedItems = (orderDetailDoc.items || []).map((item) => {
    const totalFilled = Math.min(
      item.quantity || 0,
      fulfilledMap[item.part_number] || 0
    );
    return {
      ...item,
      quantity_filled: totalFilled,
      quantity_pending: Math.max(0, (item.quantity || 0) - totalFilled),
    };
  });

  await db.collection("order_details").updateOne(
    { order_id: orderOid, is_deleted: { $ne: true } },
    { $set: { items: updatedItems, updated_at: new Date() } }
  );

  return updatedItems;
}

/**
 * GET /outwards/:id/join
 * Returns the existing join record for an outward, enriched with order info.
 */
exports.getJoin = async (req, res) => {
  const { id } = req.params;
  const db = await getDb();

  const join = await db.collection("outward_order_joins").findOne({
    $or: [{ outward_id: id }, { join_order_id: id }]
  });
  if (!join) return sendSuccess(res, null);

  let order = null;
  let orderDetail = null;
  if (join.order_id) {
    [order, orderDetail] = await Promise.all([
      db.collection("orders").findOne({ _id: join.order_id, is_deleted: { $ne: true } }),
      db.collection("order_details").findOne({ order_id: join.order_id, is_deleted: { $ne: true } }),
    ]);
  }

  sendSuccess(res, { ...join, order, orderDetail });
};

/**
 * POST /outwards/:id/join
 * Creates or updates the join record for an outward.
 * Body: { order_id, buyer_id, fulfilled_items: [{ part_number, description, brand, qty_fulfilled }] }
 *
 * Side effects:
 *   - If switching to a different order than what was previously joined, reverts old order's quantities.
 *   - Recalculates quantity_filled / quantity_pending in order_details for the target order.
 *   - Updates outward.linked_order_id.
 */
exports.saveJoin = async (req, res) => {
  const { id } = req.params;
  const { order_id, buyer_id, fulfilled_items } = req.body;
  const db = await getDb();

  if (!order_id) return sendError(res, "order_id is required", 400);

  // Validate outward
  const outward = await db.collection("outwards").findOne({ outward_id: id });
  if (!outward) return sendError(res, "Outward not found", 404);

  // Validate order
  const orderOid = toObjectId(order_id);
  if (!orderOid) return sendError(res, "Invalid order_id", 400);

  const [order, orderDetail] = await Promise.all([
    db.collection("orders").findOne({ _id: orderOid, is_deleted: { $ne: true } }),
    db.collection("order_details").findOne({ order_id: orderOid, is_deleted: { $ne: true } }),
  ]);
  if (!order) return sendError(res, "Order not found", 404);
  if (!orderDetail) return sendError(res, "Order details not found", 404);

  // Check for an existing join on this outward
  const existingJoin = await db.collection("outward_order_joins").findOne({ outward_id: id });

  if (existingJoin) {
    // If updating, prevent changing the order or buyer
    if (existingJoin.order_id.toString() !== order_id) {
      return sendError(res, "Cannot change the order once it has been joined. Please delete or create a new outward for a different order.", 400);
    }
    if (buyer_id && existingJoin.buyer_id && existingJoin.buyer_id.toString() !== buyer_id) {
       return sendError(res, "Cannot change the buyer once it has been joined.", 400);
    }
  }


  // Build clean fulfilled_items payload
  const cleanFulfilled = (fulfilled_items || [])
    .filter((f) => (Number(f.qty_fulfilled) || 0) > 0)
    .map((f) => ({
      part_number: f.part_number || "",
      description: f.description || "",
      brand: f.brand || "",
      qty_fulfilled: Math.max(0, Number(f.qty_fulfilled) || 0),
    }));

  const now = new Date();
  const joinDoc = {
    outward_id: id,
    order_id: orderOid,
    buyer_id: buyer_id ? toObjectId(buyer_id) : null,
    fulfilled_items: cleanFulfilled,
    updated_at: now,
  };

  // Upsert join record
  const isNew = !existingJoin || existingJoin.order_id.toString() !== order_id;
  if (isNew) {
    joinDoc.join_order_id = `ORDJ-${uuidv4().substring(0, 8).toUpperCase()}`;
    joinDoc.created_at = now;
    await db.collection("outward_order_joins").insertOne(joinDoc);
  } else {
    joinDoc.join_order_id = existingJoin.join_order_id || `ORDJ-${uuidv4().substring(0, 8).toUpperCase()}`;
    await db.collection("outward_order_joins").updateOne({ outward_id: id }, { $set: joinDoc });
  }

  // Recalculate the target order's fulfillment quantities
  const updatedItems = await recalculateOrderFulfillment(db, orderOid, orderDetail);

  // Update outward with the linked order reference
  await db.collection("outwards").updateOne(
    { outward_id: id },
    { $set: { linked_order_id: orderOid, join_order_id: joinDoc.join_order_id, updated_at: now } }
  );

  const savedJoin = await db.collection("outward_order_joins").findOne({ outward_id: id });
  sendSuccess(res, { join: savedJoin, updated_order_items: updatedItems });
};

/**
 * GET /outwards/joins
 * Fetch all outward joins enriched with brief outward, order, and buyer details
 */
exports.listJoins = async (req, res) => {
  const db = await getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

  const skip = (page - 1) * limit;

  // Use aggregation to join with orders and buyers
  const pipeline = [
    { $sort: { created_at: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $lookup: {
        from: "orders",
        localField: "order_id",
        foreignField: "_id",
        as: "orderData"
      }
    },
    {
      $unwind: { path: "$orderData", preserveNullAndEmptyArrays: true }
    },
    {
      $lookup: {
        from: "buyers",
        localField: "buyer_id",
        foreignField: "_id",
        as: "buyerData"
      }
    },
    {
      $unwind: { path: "$buyerData", preserveNullAndEmptyArrays: true }
    },
    {
      $project: {
        outward_id: 1,
        join_order_id: 1,
        order_id: 1,
        buyer_id: 1,
        fulfilled_items: 1,
        created_at: 1,
        updated_at: 1,
        "order.order_number": "$orderData.order_number",
        "order.pi_number": "$orderData.pi_number",
        "order.status": "$orderData.status",
        "buyer.cust_name": "$buyerData.cust_name",
        "buyer.name": "$buyerData.name",
      }
    }
  ];

  const [joins, total] = await Promise.all([
    db.collection("outward_order_joins").aggregate(pipeline).toArray(),
    db.collection("outward_order_joins").countDocuments()
  ]);

  sendSuccess(res, {
    joins,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
};
