// backend/src/middleware/roles.middleware.js
const ROLES = {
    ADMIN: 'admin',
    OPERATOR: 'operator',
    CLIENT: 'client',
};

const PERMISSIONS = {
    admin: [
        'dashboard', 'analytics', 'reports', 'maintenance',
        'chemical', 'borehole', 'settings', 'user-management',
        'users:read', 'users:write', 'users:delete'
    ],
    operator: [
        'dashboard', 'maintenance', 'reports',
        'chemical', 'borehole'
    ],
    client: [
        'dashboard', 'analytics'
    ],
};

const READ_ONLY = {
    client: ['analytics', 'dashboard'],
};

class RolesMiddleware {
    canAccess(role, resource) {
        return (PERMISSIONS[role] || []).includes(resource);
    }

    isReadOnly(role, resource) {
        return (READ_ONLY[role] || []).includes(resource);
    }

    requirePermission(resource) {
        return (req, res, next) => {
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }

            if (!this.canAccess(req.user.role, resource)) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }

            next();
        };
    }
}

module.exports = new RolesMiddleware();
module.exports.ROLES = ROLES;