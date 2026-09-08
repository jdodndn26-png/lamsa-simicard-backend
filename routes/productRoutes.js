const express = require("express");
const router = express.Router();
const { getProducts, getProduct, getFeaturedProducts } = require("../controllers/productController");

// Public read-only routes — write operations (create/update/delete) are in adminRoutes.js behind authMiddleware
// Note: Specific routes like /featured must come BEFORE dynamic routes like /:id
router.get("/", getProducts);
router.get("/featured", getFeaturedProducts);
router.get("/:id", getProduct); // Keep this last to avoid matching specific routes

module.exports = router;
