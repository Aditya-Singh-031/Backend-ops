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

  // ── Enrich fulfilled_items descriptions from invoice_line_items ──
  // Direct lookup by part_number — no chain needed
  let enrichedFulfilledItems = join.fulfilled_items || [];

  try {
    const partNumbers = enrichedFulfilledItems
      .map((fi) => (fi.part_number || "").trim())
      .filter(Boolean);

    if (partNumbers.length > 0) {
      const lineItems = await db
        .collection("invoice_line_items")
        .find({ part_number: { $in: partNumbers } })
        .project({ part_number: 1, description: 1, _id: 0 })
        .toArray();

      // part_number → description map (last match wins)
      const descMap = {};
      lineItems.forEach((li) => {
        if (li.part_number && li.description) {
          descMap[li.part_number.trim()] = li.description;
        }
      });

      enrichedFulfilledItems = enrichedFulfilledItems.map((fi) => {
        const invoiceDesc = descMap[(fi.part_number || "").trim()];
        return {
          ...fi,
          description: invoiceDesc || fi.description || "",
          description_source: invoiceDesc ? "invoice" : "join",
        };
      });
    }
  } catch (err) {
    console.warn("[getJoin] Could not enrich descriptions from invoice_line_items:", err.message);
  }

  sendSuccess(res, {
    ...join,
    fulfilled_items: enrichedFulfilledItems,
    order,
    orderDetail,
  });
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
/**
 * POST /outwards/:id/join
 * Creates or updates the join record for an outward.
 *
 * NEW BEHAVIOUR: Instead of picking a single order_id, we take buyer_id
 * and fulfilled_items (each with part_number + qty_fulfilled).
 * The system finds which CONFIRMED order each part_number belongs to
 * and updates fulfillment quantities accordingly across all matched orders.
 *
 * Body: { buyer_id, fulfilled_items: [{ part_number, description, brand, qty_fulfilled, order_id? }] }
 * order_id on each fulfilled_item is the specific order it maps to (sent from frontend after aggregation).
 */
exports.saveJoin = async (req, res) => {
  const { id } = req.params;
  const { buyer_id, fulfilled_items, order_id } = req.body;
  const db = await getDb();

  // Validate outward
  const outward = await db.collection("outwards").findOne({ outward_id: id });
  if (!outward) return sendError(res, "Outward not found", 404);

  if (!buyer_id) return sendError(res, "buyer_id is required", 400);
  const buyerOid = toObjectId(buyer_id);
  if (!buyerOid) return sendError(res, "Invalid buyer_id", 400);

  // Build clean fulfilled_items payload (only items with qty > 0)
  const cleanFulfilled = (fulfilled_items || [])
    .filter((f) => (Number(f.qty_fulfilled) || 0) > 0)
    .map((f) => ({
      part_number: f.part_number || "",
      description: f.description || "",
      brand: f.brand || "",
      qty_fulfilled: Math.max(0, Number(f.qty_fulfilled) || 0),
      rate: Number(f.rate) || 0,
      currency: f.currency || "",             // separate currency key
      order_id: f.order_id || null,
      order_number: f.order_number || "",
    }));

  if (cleanFulfilled.length === 0) {
    return sendError(res, "At least one part number must have qty_fulfilled > 0", 400);
  }

  // Determine primary order_id: use the first item's order_id, or fallback to body order_id
  // (used for outward.linked_order_id — we pick the first matched order)
  const primaryOrderIdStr = cleanFulfilled.find((f) => f.order_id)?.order_id || order_id || null;
  const primaryOrderOid = primaryOrderIdStr ? toObjectId(primaryOrderIdStr) : null;

  const now = new Date();

  // Check for an existing join on this outward
  const existingJoin = await db.collection("outward_order_joins").findOne({ outward_id: id });

  const joinDoc = {
    outward_id: id,
    buyer_id: buyerOid,
    order_id: primaryOrderOid,        // primary order reference (first matched)
    fulfilled_items: cleanFulfilled,
    updated_at: now,
  };

  let joinOrderId;
  if (!existingJoin) {
    joinOrderId = `ORDJ-${uuidv4().substring(0, 8).toUpperCase()}`;
    joinDoc.join_order_id = joinOrderId;
    joinDoc.created_at = now;
    await db.collection("outward_order_joins").insertOne(joinDoc);
  } else {
    joinOrderId = existingJoin.join_order_id || `ORDJ-${uuidv4().substring(0, 8).toUpperCase()}`;
    joinDoc.join_order_id = joinOrderId;
    await db.collection("outward_order_joins").updateOne({ outward_id: id }, { $set: joinDoc });
  }

  // Recalculate fulfillment for every distinct order touched by this join
  const distinctOrderIds = [...new Set(
    cleanFulfilled.map((f) => f.order_id).filter(Boolean)
  )];

  for (const oidStr of distinctOrderIds) {
    const orderOid = toObjectId(oidStr);
    if (!orderOid) continue;
    const orderDetail = await db.collection("order_details").findOne({
      order_id: orderOid, is_deleted: { $ne: true }
    });
    if (orderDetail) {
      await recalculateOrderFulfillment(db, orderOid, orderDetail);
    }
  }

  // Update outward with the linked order reference
  await db.collection("outwards").updateOne(
    { outward_id: id },
    {
      $set: {
        linked_order_id: primaryOrderOid,
        join_order_id: joinOrderId,
        updated_at: now,
      },
    }
  );

  const savedJoin = await db.collection("outward_order_joins").findOne({ outward_id: id });
  sendSuccess(res, { join: savedJoin });
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
