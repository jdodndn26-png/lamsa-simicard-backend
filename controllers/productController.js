const Product = require("../models/Product");

// ─── In-memory cache محدودة الحجم مع TTL و LRU-style eviction ────────────────
// الحد الأقصى 200 مدخلة — يمنع نمو الـ cache بلا حد في الـ server الدائم
const CACHE_TTL = 60 * 1000;
const CACHE_MAX_SIZE = 200;
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  // LRU: نحرك الـ entry للنهاية عند الوصول إليها
  cache.delete(key);
  cache.set(key, entry);
  return entry.data;
}

function setCached(key, data) {
  // إذا امتلأ الـ cache، احذف الأقدم (أول عنصر)
  if (cache.size >= CACHE_MAX_SIZE) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, { data, ts: Date.now() });
}

// إبطال cache مُستهدف بدل مسح الكل — يمسح فقط مدخلات products
// مع إبقاء مدخلات أخرى محتملة سليمة
function invalidateCache(productId) {
  if (productId) {
    // احذف المدخلات التي تحتوي على هذا الـ ID
    for (const key of cache.keys()) {
      if (key.includes(String(productId))) cache.delete(key);
    }
    // احذف أيضاً كل مدخلات قوائم المنتجات (تتأثر بالتغيير)
    for (const key of cache.keys()) {
      if (key.startsWith("products:")) cache.delete(key);
    }
  } else {
    // invalidate كامل عند الحاجة (مثل حذف product)
    cache.clear();
  }
}
exports.invalidateCache = invalidateCache;

function normalizeArabic(str) {
  return str
    .replace(/[أإآا]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

exports.getProducts = async (req, res) => {
  try {
    const { q, brand, category, limit, sort } = req.query;
    const query = {};
    if (brand) query.brand = { $regex: new RegExp(`^${brand}$`, "i") };
    if (category) query.category = category;

    const sortObj = sort === "duration_desc" ? { warrantyYears: -1 } : { createdAt: -1 };

    const pageLimit = limit ? parseInt(limit) : 100;

    if (!q) {
      const cacheKey = `products:${brand||''}:${category||''}:${pageLimit}:${sort||''}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      let result;
      if (sort === "price_desc") {
        result = await Product.aggregate([
          { $match: query },
          { $addFields: { effectivePrice: { $ifNull: ["$salePrice", "$originalPrice"] } } },
          { $sort: { effectivePrice: -1 } },
          { $limit: pageLimit },
        ]);
      } else {
        result = await Product.find(query).sort(sortObj).limit(pageLimit).lean();
      }
      setCached(cacheKey, result);
      return res.json(result);
    }

    const normalized = normalizeArabic(q);
    query.name = { $regex: normalizeArabic(q), $options: "i" };
    const filtered = await Product.find(query).sort(sortObj).limit(pageLimit).lean();
    res.json(filtered.filter((p) => normalizeArabic(p.name).includes(normalized)));
  } catch (err) {
    console.error("getProducts error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.getFeaturedProducts = async (req, res) => {
  // cache key ثابت للـ featured
  const cacheKey = "products:featured";
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const featured = await Product.find({ inStock: true, isFeatured: true })
    .sort({ sortOrder: 1, originalPrice: -1 })
    .limit(6)
    .lean();

  if (featured.length > 0) {
    setCached(cacheKey, featured);
    return res.json(featured);
  }

  // fallback: legacy behaviour
  const [stc, mobily] = await Promise.all([
    Product.find({ inStock: true, brand: { $regex: /^stc/i } }).sort({ originalPrice: -1 }).limit(2).lean(),
    Product.find({ inStock: true, brand: { $regex: /موبايلي/ } }).sort({ originalPrice: -1 }).limit(2).lean(),
  ]);
  const result = [...stc, ...mobily];
  setCached(cacheKey, result);
  res.json(result);
};

// جلب منتجات بـ IDs محددة — بديل الـ 4 requests المنفصلة في MostDemandedSection
exports.getProductsByIds = async (req, res) => {
  try {
    const { ids } = req.query;
    if (!ids) return res.status(400).json({ message: "ids query param required" });

    const idList = ids.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 20); // حد أقصى 20

    // cache key بناءً على الـ IDs المرتبة — نفس النتيجة بغض النظر عن الترتيب
    const cacheKey = `products:ids:${[...idList].sort().join(",")}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const mongoose = require("mongoose");
    const validIds = idList.filter((id) => mongoose.Types.ObjectId.isValid(id));
    const products = await Product.find({ _id: { $in: validIds } }).lean();

    // نُرتب النتائج بنفس ترتيب الـ IDs المطلوبة
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));
    const ordered = idList.map((id) => productMap.get(id)).filter(Boolean);

    setCached(cacheKey, ordered);
    res.json(ordered);
  } catch (err) {
    console.error("getProductsByIds error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};


exports.getProduct = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !require("mongoose").Types.ObjectId.isValid(id))
      return res.status(404).json({ message: "Product not found" });
    const product = await Product.findById(id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json(product);
  } catch (err) {
    console.error("getProduct error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

const ALLOWED_PRODUCT_FIELDS = [
  "name", "brief", "originalPrice", "salePrice", "description", "image", "images",
  "network", "simType", "dataSpeed", "storage", "specifications", "rating",
  "freeDelivery", "deliveryTime", "warrantyYears", "installment", "taxIncluded",
  "category", "subCategory", "brand", "inStock", "isFeatured", "sortOrder",
];

function pickAllowed(body) {
  return ALLOWED_PRODUCT_FIELDS.reduce((acc, f) => {
    if (body[f] !== undefined) acc[f] = body[f];
    return acc;
  }, {});
}

exports.createProduct = async (req, res) => {
  const data = pickAllowed(req.body);
  if (!data.name || data.originalPrice == null)
    return res.status(400).json({ message: "name and originalPrice are required" });
  if (typeof data.originalPrice !== "number" || data.originalPrice < 0)
    return res.status(400).json({ message: "originalPrice must be a non-negative number" });
  const product = await Product.create(data);
  invalidateCache(); // منتج جديد يؤثر على قوائم المنتجات كلها
  res.status(201).json(product);
};

exports.updateProduct = async (req, res) => {
  const data = pickAllowed(req.body);
  if (data.originalPrice !== undefined && (typeof data.originalPrice !== "number" || data.originalPrice < 0))
    return res.status(400).json({ message: "originalPrice must be a non-negative number" });
  const product = await Product.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true });
  if (!product) return res.status(404).json({ message: "Product not found" });
  invalidateCache(req.params.id); // invalidate مُستهدف بالـ ID
  res.json(product);
};

exports.deleteProduct = async (req, res) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) return res.status(404).json({ message: "Product not found" });
  invalidateCache(); // حذف يؤثر على الكل
  res.json({ message: "Product deleted" });
};
