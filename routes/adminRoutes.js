const express = require("express");

const authRoutes     = require("./admin/authRoutes");
const userRoutes     = require("./admin/userRoutes");
const companyRoutes  = require("./admin/companyRoutes");
const categoryRoutes = require("./admin/categoryRoutes");
const brandRoutes    = require("./admin/brandRoutes");
const orderRoutes    = require("./admin/orderRoutes");
const reviewRoutes   = require("./admin/reviewRoutes");
const productRoutes  = require("./admin/productRoutes");
const bankRoutes     = require("./admin/bankRoutes");
const settingsRoutes = require("./admin/settingsRoutes");

const router = express.Router();

// Auth (login / logout / verify) — routes defined with full paths e.g. /login
router.use("/", authRoutes);

// Admin users CRUD — mounted at /users
router.use("/users", userRoutes);

// Company info, images, footer — mounted at /company
router.use("/company", companyRoutes);

// Categories (main + sub) and brands — flat paths, router handles prefix internally
router.use("/", categoryRoutes);
router.use("/brands", brandRoutes);

// Orders — mounted at /orders
router.use("/orders", orderRoutes);

// Reviews — mounted at /reviews
router.use("/reviews", reviewRoutes);

// Products — mounted at /products
router.use("/products", productRoutes);

// Banks — mounted at /banks
router.use("/banks", bankRoutes);

// Card field settings + maintenance — flat paths, router handles prefix internally
router.use("/", settingsRoutes);

module.exports = router;
