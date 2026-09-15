function requireApiSecret(req, res, next) {
  const apiSecret = req.headers["x-api-secret"];
  if (!process.env.API_SECRET) {
    return res.status(500).json({
      success: false,
      message: "API_SECRET is not configured",
    });
  }
  if (!apiSecret || apiSecret !== process.env.API_SECRET) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }
  return next();
}

module.exports = { requireApiSecret };
