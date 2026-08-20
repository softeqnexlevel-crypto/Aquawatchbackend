// backend/middleware/roles.middleware.js
const ROLES = {
    ADMIN: 'admin',
    OPERATOR: 'operator',
    CLIENT: 'client',
};

const PERMISSIONS = {
    admin: [
        'dashboard', 'analytics', 'reports', 'maintenance',
        'chemical', 'borehole', 'settings', 'user-management'
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
    // Returns the effective permission set for a user
    effectivePermissions(user) {
        if (Array.isArray(user.permissions) && user.permissions.length > 0) {
            return user.permissions;
        }
        return PERMISSIONS[user.role] || [];
    }

    canAccess(user, resource) {
        if (typeof user === 'string') {
            return (PERMISSIONS[user] || []).includes(resource);
        }
        return this.effectivePermissions(user).includes(resource);
    }

    isReadOnly(role, resource) {
        return (READ_ONLY[role] || []).includes(resource);
    }

    requirePermission(resource) {
        return (req, res, next) => {
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }

            if (!this.canAccess(req.user, resource)) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }

            next();
        };
    }
}

module.exports = new RolesMiddleware();
module.exports.ROLES = ROLES;
module.exports.PERMISSIONS = PERMISSIONS;