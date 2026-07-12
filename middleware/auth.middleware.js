// backend/middleware/auth.middleware.js
const pasetoService = require('../services/paseto.service');
const authService = require('../services/auth.service');

class AuthMiddleware {
    /**
     * Require authentication
     */
    async requireAuth(req, res, next) {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({
                    error: 'Authorization header required'
                });
            }

            const token = authHeader.split(' ')[1];
            const payload = await pasetoService.verifyAccessToken(token);

            if (!payload) {
                return res.status(401).json({
                    error: 'Invalid or expired token'
                });
            }

            const user = await authService.getUserById(payload.sub);
            // ✅ FIX: authService.getUserById() returns a user shaped by
            // toPublicUser(), which sets camelCase "isActive" — not the old
            // in-memory snake_case "is_active". Checking is_active here meant
            // this was always undefined (falsy), so EVERY authenticated
            // request failed with "User not found or inactive", even for a
            // genuinely active user right after a fresh login.
            if (!user || !user.isActive) {
                return res.status(401).json({
                    error: 'User not found or inactive'
                });
            }

            req.user = user;
            req.tokenPayload = payload;
            next();
        } catch (error) {
            return res.status(401).json({
                error: 'Authentication failed'
            });
        }
    }

    /**
     * Require specific role(s)
     */
    requireRole(...roles) {
        return (req, res, next) => {
            if (!req.user) {
                return res.status(401).json({
                    error: 'Authentication required'
                });
            }

            if (!roles.includes(req.user.role)) {
                return res.status(403).json({
                    error: 'Insufficient permissions'
                });
            }

            next();
        };
    }

    /**
     * Optional authentication
     */
    async optionalAuth(req, res, next) {
        try {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.split(' ')[1];
                const payload = await pasetoService.verifyAccessToken(token);
                if (payload) {
                    const user = await authService.getUserById(payload.sub);
                    // ✅ FIX: same camelCase correction as requireAuth above.
                    if (user && user.isActive) {
                        req.user = user;
                    }
                }
            }
            next();
        } catch (error) {
            next();
        }
    }
}

module.exports = new AuthMiddleware();