const Product = require("../models/Product");

// In-memory cache — TTL 60 ثانية
const cache = new Map();
const CACHE_TTL = 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCached(key, data) {
  cache.set(key, { data, ts: Date.now() });
}
const invalidateCache = () => cache.clear();
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
  const featured = await Product.find({ inStock: true, isFeatured: true }).sort({ sortOrder: 1, originalPrice: -1 }).limit(6);
  if (featured.length > 0) return res.json(featured);
  // fallback: legacy behaviour
  const [stc, mobily] = await Promise.all([
    Product.find({ inStock: true, brand: { $regex: /^stc/i } }).sort({ originalPrice: -1 }).limit(2),
    Product.find({ inStock: true, brand: { $regex: /موبايلي/ } }).sort({ originalPrice: -1 }).limit(2),
  ]);
  res.json([...stc, ...mobily]);
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
  invalidateCache();
  res.status(201).json(product);
};

exports.updateProduct = async (req, res) => {
  const data = pickAllowed(req.body);
  if (data.originalPrice !== undefined && (typeof data.originalPrice !== "number" || data.originalPrice < 0))
    return res.status(400).json({ message: "originalPrice must be a non-negative number" });
  const product = await Product.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true });
  if (!product) return res.status(404).json({ message: "Product not found" });
  invalidateCache();
  res.json(product);
};

exports.deleteProduct = async (req, res) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) return res.status(404).json({ message: "Product not found" });
  invalidateCache();
  res.json({ message: "Product deleted" });
};
