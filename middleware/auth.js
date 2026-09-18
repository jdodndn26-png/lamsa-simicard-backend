/**
 * Shared admin auth middleware — كان مكرراً في adminRoutes.js + checkoutRoutes.js + shippingRoutes.js
 * الآن يُعرَّف مرة واحدة هنا ويُستورد من كل الملفات
 */
const jwt = require("jsonwebtoken");

function authMiddleware(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ error: "غير مصرح" });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "غير مصرح" });
  }
}

module.exports = authMiddleware;
