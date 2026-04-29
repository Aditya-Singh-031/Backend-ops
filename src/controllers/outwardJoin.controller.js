const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");
const { v4: uuidv4 } = require("uuid");

/**
 * Recalculate quantity_filled and quantity_pending for every item in an order
 * by summing qty_fulfilled across ALL outward_order_joins that reference this order.
 * This ensures correctness even when multiple outwards contribute to the same order.
 */
exports.recalculateOrderFulfillment = async function recalculateOrderFulfillment(db, orderOid, orderDetailDoc) {
  // Find all joins that have ANY fulfilled_item referencing this order
  const orderIdStr = orderOid.toString();
  const allJoins = await db
    .collection("outward_order_joins")
    .find({ "fulfilled_items.order_id": orderIdStr })
    .toArray();

  // Sum fulfilled per part_number for THIS specific order only
  const fulfilledMap = {};
  allJoins.forEach((join) => {
    (join.fulfilled_items || []).forEach((fi) => {
      if (fi.part_number && fi.order_id === orderIdStr) {
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

  // No single order_id on join — buyer-based
  // orderDetail is derived from fulfilled_items per-order if needed

  // ── Enrich from invoice_line_items and product_master ──
  let enrichedFulfilledItems = join.fulfilled_items || [];
  const skuInfoMap = {};

  try {
    const outward = await db.collection("outwards").findOne({ outward_id: id });
    const partNumbersSet = new Set(enrichedFulfilledItems.map(fi => (fi.part_number || "").trim()).filter(Boolean));
    (outward?.boxes || []).forEach(b => (b.items || []).forEach(i => { if (i.sku) partNumbersSet.add(i.sku.trim()); }));
    const partNumbers = [...partNumbersSet];

    if (partNumbers.length > 0) {
      const lineItems = await db.collection("invoice_line_items")
        .find({ part_number: { $in: partNumbers } })
        .project({ part_number: 1, description: 1, part_net_wt: 1, net_weight: 1, unit_weight: 1, country_of_origin: 1, _id: 0 })
        .toArray();
      const invoiceMap = {};
      lineItems.forEach((li) => {
        if (li.part_number) invoiceMap[li.part_number.trim()] = li;
      });

      const pmItems = await db.collection("product_master")
        .find({ part_number: { $in: partNumbers }, is_deleted: { $ne: true } })
        .project({ part_number: 1, part_net_wt: 1, country_of_origin: 1, description: 1, _id: 0 })
        .toArray();
      const pmMap = {};
      pmItems.forEach(pm => {
        if (pm.part_number) pmMap[pm.part_number.trim()] = pm;
      });

      partNumbers.forEach(pn => {
        const inv = invoiceMap[pn] || {};
        const pm = pmMap[pn] || {};
        skuInfoMap[pn] = {
          description: inv.description || pm.description || "",
          part_net_wt: Number(inv.part_net_wt || inv.net_weight || inv.unit_weight || pm.part_net_wt || 0),
          country_of_origin: inv.country_of_origin || pm.country_of_origin || "",
          source: inv.description ? "invoice" : pm.description ? "product_master" : "none"
        };
      });

      enrichedFulfilledItems = enrichedFulfilledItems.map((fi) => {
        const pn = (fi.part_number || "").trim();
        const info = skuInfoMap[pn] || {};
        return {
          ...fi,
          description: info.description || fi.description || "",
          description_source: info.source !== "none" ? info.source : "join",
          part_net_wt: info.part_net_wt || fi.part_net_wt || 0,
          country_of_origin: info.country_of_origin || fi.country_of_origin || ""
        };
      });
    }
  } catch (err) {
    console.warn("[getJoin] Could not enrich descriptions/weights:", err.message);
  }

  sendSuccess(res, {
    ...join,
    fulfilled_items: enrichedFulfilledItems,
    buyer_order_stats: await getBuyerOrderStats(db, join.buyer_id, enrichedFulfilledItems),
    sku_info_map: skuInfoMap,
  });
};

/**
 * Aggregate total ordered & total fulfilled (from ALL joins) per part_number
 * across ALL confirmed orders for the buyer.
 */
async function getBuyerOrderStats(db, buyerId, fulfilledItems) {
  if (!buyerId) return null;
  try {
    const buyerOid = require("../config/db").toObjectId ? require("../config/db").toObjectId(buyerId) : null;
    if (!buyerOid) return null;

    // All confirmed orders for this buyer
    const orders = await db.collection("orders").find({
      buyer_id: buyerOid,
      status: "CONFIRMED",
      is_deleted: { $ne: true },
    }).toArray();

    if (orders.length === 0) return null;

    const orderIds = orders.map(o => o._id);
    const allDetails = await db.collection("order_details")
      .find({ order_id: { $in: orderIds }, is_deleted: { $ne: true } })
      .toArray();

    // Aggregate total qty ordered per part_number across all orders
    const totalOrderedMap = {};   // partNumber → total qty
    const orderQtyMap = {};       // orderId → { partNumber → qty }
    allDetails.forEach(d => {
      const oidStr = d.order_id.toString();
      orderQtyMap[oidStr] = {};
      (d.items || []).forEach(item => {
        const pn = (item.part_number || "").trim();
        if (!pn) return;
        totalOrderedMap[pn] = (totalOrderedMap[pn] || 0) + (Number(item.quantity) || 0);
        orderQtyMap[oidStr][pn] = (Number(item.quantity) || 0);
      });
    });

    // Aggregate total fulfilled per part_number from ALL joins for this buyer
    const allJoins = await db.collection("outward_order_joins")
      .find({ buyer_id: buyerOid })
      .toArray();

    const totalFilledMap = {};    // partNumber → total qty fulfilled across ALL joins
    allJoins.forEach(j => {
      (j.fulfilled_items || []).forEach(fi => {
        const pn = (fi.part_number || "").trim();
        if (pn) totalFilledMap[pn] = (totalFilledMap[pn] || 0) + (Number(fi.qty_fulfilled) || 0);
      });
    });

    // Build per-part stats
    const partStats = {};
    const allParts = new Set([
      ...Object.keys(totalOrderedMap),
      ...(fulfilledItems || []).map(fi => (fi.part_number || "").trim()).filter(Boolean),
    ]);

    allParts.forEach(pn => {
      const ordered = totalOrderedMap[pn] || 0;
      const filled  = Math.min(ordered, totalFilledMap[pn] || 0);
      partStats[pn] = {
        total_ordered:   ordered,
        total_fulfilled: filled,
        total_pending:   Math.max(0, ordered - filled),
      };
    });

    return {
      orders_count: orders.length,
      part_stats: partStats,
      total_ordered:   Object.values(partStats).reduce((s, p) => s + p.total_ordered, 0),
      total_fulfilled: Object.values(partStats).reduce((s, p) => s + p.total_fulfilled, 0),
      total_pending:   Object.values(partStats).reduce((s, p) => s + p.total_pending, 0),
    };
  } catch (err) {
    console.warn("[getBuyerOrderStats] Error:", err.message);
    return null;
  }
}

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

  // Build clean fulfilled_items (only items with qty > 0)
  const cleanFulfilled = (fulfilled_items || [])
    .filter((f) => (Number(f.qty_fulfilled) || 0) > 0)
    .map((f) => ({
      part_number: f.part_number || "",
      description: f.description || "",
      brand: f.brand || "",
      qty_fulfilled: Math.max(0, Number(f.qty_fulfilled) || 0),
      rate: Number(f.rate) || 0,
      currency: f.currency || "",
      order_id: f.order_id || null,       // per-item order ref (for recalc)
      order_number: f.order_number || "",
    }));

  if (cleanFulfilled.length === 0) {
    return sendError(res, "At least one part number must have qty_fulfilled > 0", 400);
  }

  const now = new Date();

  // Check for existing join
  const existingJoin = await db.collection("outward_order_joins").findOne({ outward_id: id });

  // Buyer-based join doc — NO top-level order_id
  const joinDoc = {
    outward_id: id,
    buyer_id: buyerOid,
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
      await exports.recalculateOrderFulfillment(db, orderOid, orderDetail);
    }
  }

  // Update outward — mark as joined (no single linked_order_id)
  await db.collection("outwards").updateOne(
    { outward_id: id },
    { $set: { join_order_id: joinOrderId, updated_at: now } }
  );

  const savedJoin = await db.collection("outward_order_joins").findOne({ outward_id: id });
  sendSuccess(res, { join: savedJoin });
};

/**
 * POST /outwards/:id/trigger-ai
 * Manually trigger AI fetching for missing metadata for a joined order
 */
exports.triggerAiProcessing = async (req, res) => {
  const { id } = req.params;
  const dbInstance = await getDb();
  
  // Quick validation
  const joinOrder = await dbInstance.collection("outward_order_joins").findOne({ outward_id: id });
  if (!joinOrder) return sendError(res, "Join order not found", 404);

  const outward = await dbInstance.collection("outwards").findOne({ outward_id: id });
  if (!outward) return sendError(res, "Outward not found", 404);

  // Mark as processing immediately
  await dbInstance.collection("outward_order_joins").updateOne(
    { outward_id: id },
    { $set: { ai_status: 'processing' } }
  );

  sendSuccess(res, { message: "AI processing started in background" });

  // Run the AI logic in the background
  (async () => {
    try {
      const cleanFulfilled = joinOrder.fulfilled_items || [];
      const skuSet = new Set(cleanFulfilled.map(f => f.part_number).filter(Boolean));
      (outward.boxes || []).forEach(b => (b.items || []).forEach(i => { if (i.sku) skuSet.add(i.sku); }));
      const allSkus = [...skuSet];
      
      if (allSkus.length > 0) {
        const lineItems = await dbInstance.collection("invoice_line_items")
          .find({ part_number: { $in: allSkus } })
          .project({ part_number: 1, part_net_wt: 1, net_weight: 1, unit_weight: 1, country_of_origin: 1 })
          .toArray();
        const liMap = {};
        lineItems.forEach((li) => {
          if (li.part_number) liMap[li.part_number] = {
            part_net_wt: Number(li.part_net_wt || li.net_weight || li.unit_weight || 0),
            country_of_origin: li.country_of_origin || ""
          };
        });

        const missingFromInvoice = allSkus.filter(pn => !liMap[pn]?.part_net_wt || !liMap[pn]?.country_of_origin);
        if (missingFromInvoice.length > 0) {
          const pmItems = await dbInstance.collection("product_master")
            .find({ part_number: { $in: missingFromInvoice }, is_deleted: { $ne: true } })
            .project({ part_number: 1, part_net_wt: 1, country_of_origin: 1 })
            .toArray();
          const pmMap = {};
          pmItems.forEach(pm => { if (pm.part_number) pmMap[pm.part_number] = pm; });

          const completelyMissing = missingFromInvoice.filter(pn => !pmMap[pn]?.part_net_wt || !pmMap[pn]?.country_of_origin);
          
          if (completelyMissing.length > 0) {
            const aiService = require("../services/ai.service");
            const aiResults = await aiService.fetchPartsInfoAI(completelyMissing);
            for (const res of aiResults) {
              if (!res.part_number) continue;
              const updateSet = { updated_at: new Date() };
              if (res.part_net_wt) updateSet.part_net_wt = Number(res.part_net_wt);
              if (res.country_of_origin) updateSet.country_of_origin = res.country_of_origin;
              
              if (Object.keys(updateSet).length > 1) {
                await dbInstance.collection("product_master").updateOne(
                  { part_number: res.part_number },
                  { $set: updateSet, $setOnInsert: { part_number: res.part_number, is_deleted: false, created_at: new Date() } },
                  { upsert: true }
                );
              }
            }

            await dbInstance.collection("outward_order_joins").updateOne(
              { outward_id: id },
              { $set: { ai_status: 'completed' } }
            );
          } else {
            // No missing parts, instantly completed
            await dbInstance.collection("outward_order_joins").updateOne(
              { outward_id: id },
              { $set: { ai_status: 'completed' } }
            );
          }
        } else {
            // No missing parts from invoice
            await dbInstance.collection("outward_order_joins").updateOne(
              { outward_id: id },
              { $set: { ai_status: 'completed' } }
            );
        }
      }
    } catch (err) {
      console.error("Background AI processing error:", err);
      try {
        await dbInstance.collection("outward_order_joins").updateOne(
          { outward_id: id },
          { $set: { ai_status: 'failed' } }
        );
      } catch (e) {}
    }
  })();
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

  const pipeline = [
    { $sort: { created_at: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $lookup: {
        from: "buyers",
        localField: "buyer_id",
        foreignField: "_id",
        as: "buyerData"
      }
    },
    { $unwind: { path: "$buyerData", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        outward_id: 1,
        join_order_id: 1,
        buyer_id: 1,
        fulfilled_items: 1,
        created_at: 1,
        updated_at: 1,
        // Distinct order count from fulfilled_items
        orders_count: {
          $size: {
            $setUnion: {
              $map: {
                input: {
                  $filter: {
                    input: { $ifNull: ["$fulfilled_items", []] },
                    as: "fi",
                    cond: { $and: [{ $ne: ["$$fi.order_id", null] }, { $ne: ["$$fi.order_id", ""] }] }
                  }
                },
                as: "fi",
                in: "$$fi.order_number"
              }
            }
          }
        },
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

exports.removeJoin = async (req, res) => {
  const { joinId } = req.params;
  const db = await getDb();

  const join = await db.collection("outward_order_joins").findOne({ _id: toObjectId(joinId) });
  if (!join) return sendError(res, "Join not found", 404);

  const cleanFulfilled = join.fulfilled_items || [];
  const distinctOrderIds = [...new Set(
    cleanFulfilled.map((f) => f.order_id).filter(Boolean)
  )];

  // Delete the join
  await db.collection("outward_order_joins").deleteOne({ _id: join._id });

  // Recalculate fulfillment for affected orders
  for (const oidStr of distinctOrderIds) {
    const orderOid = toObjectId(oidStr);
    if (!orderOid) continue;
    const orderDetail = await db.collection("order_details").findOne({
      order_id: orderOid, is_deleted: { $ne: true }
    });
    if (orderDetail) {
      await exports.recalculateOrderFulfillment(db, orderOid, orderDetail);
    }
  }

  // Clear join_order_id in outward
  if (join.outward_id) {
    await db.collection("outwards").updateOne(
      { outward_id: join.outward_id },
      { $set: { join_order_id: null, updated_at: new Date() } }
    );
  }

  return sendSuccess(res, { message: "Joined orders deleted successfully" });
};

