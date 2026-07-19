// קונפיגורציית ההתחברות - קובץ נפרד כדי למנוע תלות מעגלית בין authRoutes ל-middleware
module.exports = {
  JWT_SECRET: process.env.JWT_SECRET || 'change-me-please-set-in-env',
  COOKIE_NAME: 'quiz_auth',
  THIRTY_DAYS_MS: 30 * 24 * 60 * 60 * 1000
};
