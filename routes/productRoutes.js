const express = require("express");
const router = express.Router();
const {
  getProducts,
  getProduct,
  getFeaturedProducts,
  getProductsByIds,
} = require("../controllers/productController");

// Public read-only routes — write operations (create/update/delete) are in adminRoutes.js behind authMiddleware
// ملاحظة: الـ routes الثابتة يجب أن تأتي قبل /:id لتجنب matching خاطئ

router.get("/", getProducts);
router.get("/featured", getFeaturedProducts);

// Fix 18: endpoint جديد يجلب منتجات بـ IDs متعددة في query واحدة
// بديل الـ 4 requests المنفصلة في MostDemandedSection
// المثال: GET /api/products/by-ids?ids=id1,id2,id3,id4
router.get("/by-ids", getProductsByIds);

router.get("/:id", getProduct); // يجب أن يكون آخر route لتجنب conflict مع /featured و /by-ids

module.exports = router;
