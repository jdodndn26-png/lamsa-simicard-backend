const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const Checkout = require("../models/Checkout");
const Product = require("../models/Product");
const { calculateShippingPrice } = require("../services/shippingService");
const authMiddleware = require("../middleware/auth");

const RATE_LIMIT_MAX = 4;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 دقايق

// ─── Fix 4: userRateLimitMap مع cleanup تلقائي ───────────────────────────────
// الـ Map القديمة كانت تنمو بلا حد — الآن نحذف الـ entries منتهية الصلاحية
// عند كل request بدل انتظار cleanup خارجي
const userRateLimitMap = new Map();

function userRateLimit(req, res, next) {
  const { whatsapp, nationalId } = req.body;
  const key = whatsapp || nationalId;
  if (!key) return next();

  const now = Date.now();
  const entry = userRateLimitMap.get(key);

  if (entry) {
    const elapsed = now - entry.windowStart;
    if (elapsed < RATE_LIMIT_WINDOW_MS) {
      if (entry.count >= RATE_LIMIT_MAX) {
        const retryAfterMs = RATE_LIMIT_WINDOW_MS - elapsed;
        return res.status(429).json({
          ok: false,
          error: "لقد تجاوزت الحد المسموح به من الطلبات",
          retryAfterMs,
          retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        });
      }
      entry.count++;
    } else {
      // نافذة جديدة — نُعيد تعيين العداد
      userRateLimitMap.set(key, { count: 1, windowStart: now });
    }
  } else {
    userRateLimitMap.set(key, { count: 1, windowStart: now });
  }

  next();
}

// تنظيف دوري للـ Map كل 10 دقائق — يحذف الـ entries التي تجاوزت الـ window
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, entry] of userRateLimitMap) {
    if (entry.windowStart < cutoff) userRateLimitMap.delete(key);
  }
}, 10 * 60 * 1000);

// ─── Helper: تحميل وتحقق من المنتجات دفعة واحدة (Fix 3) ─────────────────────
// بدلاً من N+1 queries، نجلب كل المنتجات في query واحدة
async function loadAndValidateItems(items, checkPrice = false) {
  // جلب كل المنتجات في query واحدة بدل N queries
  const ids = items.map((i) => i.productId).filter(Boolean);
  const products = await Product.find({ _id: { $in: ids } }).lean();
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  let calculatedTotal = 0;
  const validatedItems = [];

  for (const item of items) {
    const product = productMap.get(String(item.productId));

    if (!product) {
      return { error: `المنتج ${item.productId} غير موجود`, status: 400 };
    }
    if (!product.inStock) {
      return { error: `المنتج "${product.name}" غير متوفر حالياً`, status: 400 };
    }

    const actualPrice = product.salePrice ?? product.originalPrice;

    if (checkPrice && item.price !== actualPrice) {
      return {
        error: `سعر المنتج "${product.name}" تم تعديله. يرجى تحديث السلة`,
        status: 400,
      };
    }

    const itemTotal = actualPrice * item.quantity;
    calculatedTotal += itemTotal;

    validatedItems.push({
      productId: product._id,
      name: product.name,
      price: actualPrice,
      quantity: item.quantity,
      total: itemTotal,
      image: product.images?.[0] || product.image || null,
    });
  }

  return { validatedItems, calculatedTotal };
}

// ─── Validate cart endpoint ───────────────────────────────────────────────────
router.post("/validate-cart", async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "السلة فارغة" });
    }

    const result = await loadAndValidateItems(items, false);
    if (result.error) {
      return res.status(result.status).json({ ok: false, error: result.error });
    }

    res.json({
      ok: true,
      items: result.validatedItems,
      total: result.calculatedTotal,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST / — إنشاء طلب جديد ─────────────────────────────────────────────────
router.post("/", userRateLimit, async (req, res) => {
  try {
    const { whatsapp, nationalId, shipping: shippingInput, items, total } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "السلة فارغة" });
    }

    // Fix 3: N+1 → single query عبر loadAndValidateItems
    const result = await loadAndValidateItems(items, true);
    if (result.error) {
      return res.status(result.status).json({ ok: false, error: result.error });
    }

    const { validatedItems, calculatedTotal } = result;

    // التحقق من الإجمالي
    const priceDifference = Math.abs(calculatedTotal - total);
    if (priceDifference > 0.01) {
      return res.status(400).json({
        ok: false,
        error: `المجموع الإجمالي غير صحيح. المتوقع: ${calculatedTotal} ر.س، المرسل: ${total} ر.س`,
      });
    }

    // DB-level rate limit check (حماية مضاعفة)
    if (whatsapp || nationalId) {
      const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
      const filter = { createdAt: { $gte: since } };
      if (whatsapp) filter.whatsapp = whatsapp;
      else filter.nationalId = nationalId;
      const recentCount = await Checkout.countDocuments(filter);
      if (recentCount >= RATE_LIMIT_MAX) {
        return res.status(429).json({
          ok: false,
          error: "لقد تجاوزت الحد المسموح به من الطلبات",
          retryAfterMs: RATE_LIMIT_WINDOW_MS,
          retryAfterSeconds: RATE_LIMIT_WINDOW_MS / 1000,
        });
      }
    }

    // التحقق من شركة الشحن
    let shippingSnapshot = null;
    const isValidObjectId = (id) => /^[a-f\d]{24}$/i.test(id);
    if (shippingInput?.companyId && shippingInput?.region && isValidObjectId(shippingInput.companyId)) {
      const verified = await calculateShippingPrice(
        shippingInput.companyId,
        shippingInput.region,
        shippingInput.city || "",
        calculatedTotal
      );
      if (!verified) {
        return res.status(400).json({ ok: false, error: "شركة الشحن المختارة لا تغطي هذا العنوان" });
      }
      shippingSnapshot = {
        companyId: shippingInput.companyId,
        companyName: verified.companyName,
        logo: verified.logo,
        price: verified.price,
        originalPrice: verified.originalPrice,
        isFree: verified.isFree,
        deliveryMinDays: verified.deliveryMinDays,
        deliveryMaxDays: verified.deliveryMaxDays,
        region: shippingInput.region,
        city: shippingInput.city || "",
      };
    } else if (shippingInput?.companyId && shippingInput?.companyName) {
      shippingSnapshot = {
        companyId: shippingInput.companyId,
        companyName: shippingInput.companyName,
        logo: shippingInput.logo || "",
        price: Number(shippingInput.price) || 0,
        originalPrice: Number(shippingInput.originalPrice) || 0,
        isFree: shippingInput.isFree ?? true,
        deliveryMinDays: shippingInput.deliveryMinDays || null,
        deliveryMaxDays: shippingInput.deliveryMaxDays || null,
        region: shippingInput.region || "",
        city: shippingInput.city || "",
      };
    }

    const payload = { ...req.body, items: validatedItems, total: calculatedTotal };
    if (shippingSnapshot) payload.shipping = shippingSnapshot;
    if (payload.customer && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.customer.trim())) {
      payload.customerEmailNormalized = payload.customer.trim().toLowerCase();
    }
    const checkout = new Checkout(payload);
    checkout.statusHistory.push({ status: "pending", changedAt: new Date(), changedBy: "system" });
    await checkout.save();
    res.status(201).json({ ok: true, orderId: checkout.orderId, _id: checkout._id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET / — قائمة الطلبات (admin) ──────────────────────────────────────────
router.get("/", authMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status && ["pending", "confirmed", "processing", "ready_to_ship", "shipped", "out_for_delivery", "delivered", "cancelled"].includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.search) {
      const s = req.query.search.trim();
      if (s) {
        filter.$or = [
          { customer: { $regex: s, $options: "i" } },
          { whatsapp: { $regex: s, $options: "i" } },
          { orderId: { $regex: s, $options: "i" } },
          { nationalId: { $regex: s, $options: "i" } },
        ];
      }
    }
    if (req.query.dateFrom || req.query.dateTo) {
      filter.createdAt = {};
      if (req.query.dateFrom) filter.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const to = new Date(req.query.dateTo);
        to.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = to;
      }
    }

    const sortField = req.query.sortField || "createdAt";
    const sortDir = req.query.sortDir === "asc" ? 1 : -1;
    const allowedSort = ["createdAt", "total", "status", "customer"];
    const sort = { [allowedSort.includes(sortField) ? sortField : "createdAt"]: sortDir };

    const [orders, total] = await Promise.all([
      Checkout.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Checkout.countDocuments(filter),
    ]);

    res.json({ orders, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const VALID_STATUSES = ["pending", "confirmed", "processing", "ready_to_ship", "shipped", "out_for_delivery", "delivered", "cancelled"];
const VALID_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["ready_to_ship", "cancelled"],
  ready_to_ship: ["shipped", "cancelled"],
  shipped: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered", "cancelled"],
  delivered: [],
  cancelled: ["pending"],
};

router.put("/:id/status", authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status))
      return res.status(400).json({ ok: false, error: "حالة غير صحيحة" });
    const order = await Checkout.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    if (!VALID_TRANSITIONS[order.status]?.includes(status))
      return res.status(400).json({ ok: false, error: `لا يمكن التحويل من ${order.status} إلى ${status}` });
    order.status = status;
    order.statusHistory.push({ status, changedAt: new Date(), changedBy: "admin" });
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Public confirm after OTP
router.put("/:id/confirm", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    if (order.status !== "pending")
      return res.status(400).json({ ok: false, error: "الطلب ليس في حالة انتظار" });
    order.status = "confirmed";
    order.statusHistory.push({ status: "confirmed", changedAt: new Date(), changedBy: "system" });
    await order.save();
    res.json({ ok: true, orderId: order.orderId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.put("/:id/financials", authMiddleware, async (req, res) => {
  try {
    const { total, downPayment, months, monthlyPayment } = req.body;
    const order = await Checkout.findByIdAndUpdate(
      req.params.id,
      { total, downPayment, months, monthlyPayment },
      { returnDocument: "after" }
    );
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
