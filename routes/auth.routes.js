// backend/routes/auth.routes.js
const express = require('express');
const router = express.Router();
const authService = require('../services/auth.service');
const authMiddleware = require('../middleware/auth.middleware');
const rolesMiddleware = require('../middleware/roles.middleware');

const VALID_ROLES = ['admin', 'operator', 'client'];

// ==================== PUBLIC ROUTES ====================

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        const deviceInfo = { ip: req.ip, userAgent: req.headers['user-agent'] };
        const result = await authService.login(email, password, deviceInfo);
        res.json({
            message: 'Login successful',
            ...result,
        });
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(400).json({ error: 'Refresh token required' });
        }
        const result = await authService.refreshToken(refreshToken);
        res.json(result);
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

// ==================== PROTECTED ROUTES ====================

// Get current user
router.get('/me', authMiddleware.requireAuth, async (req, res) => {
    try {
        res.json({ user: req.user });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get user' });
    }
});

// Logout
router.post('/logout', authMiddleware.requireAuth, async (req, res) => {
    try {
        const { refreshToken } = req.body;
        await authService.logout(req.user.id, refreshToken);
        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Logout failed' });
    }
});

// Change password
router.post('/change-password', authMiddleware.requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password required' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        await authService.changePassword(req.user.id, currentPassword, newPassword);
        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ==================== ADMIN ROUTES ====================

// Register new user (admin only)
router.post('/register', 
    authMiddleware.requireAuth, 
    rolesMiddleware.requirePermission('user-management'),
    async (req, res) => {
        try {
            const { email, password, firstName, lastName, role, phone, permissions } = req.body;

            if (!email || !password) {
                return res.status(400).json({ error: 'Email and password required' });
            }
            if (password.length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters' });
            }
            if (role && !VALID_ROLES.includes(role)) {
                return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
            }

            const user = await authService.register({
                email, password, firstName, lastName, phone,
                role: role || 'operator',
                permissions: Array.isArray(permissions) ? permissions : [],
            });

            await authService.logAction(
                req.user.id, 'user_created', 'user', user.id,
                { email: user.email, role: user.role },
                req.ip, req.headers['user-agent']
            );

            res.status(201).json({ message: 'User registered successfully', user });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
);

// Get all users (admin only)
router.get('/users', 
    authMiddleware.requireAuth, 
    rolesMiddleware.requirePermission('user-management'),
    async (req, res) => {
        try {
            const users = await authService.getAllUsers();
            res.json({ users });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get users' });
        }
    }
);

// Update user (admin only)
router.put('/users/:userId', 
    authMiddleware.requireAuth, 
    rolesMiddleware.requirePermission('user-management'),
    async (req, res) => {
        try {
            const { userId } = req.params;
            const { firstName, lastName, role, isActive, phone, permissions } = req.body;

            if (role && !VALID_ROLES.includes(role)) {
                return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
            }
            if (userId === req.user.id && role && role !== 'admin') {
                return res.status(400).json({ error: 'Cannot change your own role' });
            }
            if (userId === req.user.id && isActive === false) {
                return res.status(400).json({ error: 'Cannot deactivate your own account' });
            }

            const user = await authService.updateUser(userId, {
                firstName, lastName, role, isActive, phone,
                ...(Array.isArray(permissions) ? { permissions } : {}),
            });

            await authService.logAction(
                req.user.id, 'user_updated', 'user', userId,
                { role, isActive, phone },
                req.ip, req.headers['user-agent']
            );

            res.json({ message: 'User updated successfully', user });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
);

// Delete user (admin only)
router.delete('/users/:userId', 
    authMiddleware.requireAuth, 
    rolesMiddleware.requirePermission('user-management'),
    async (req, res) => {
        try {
            const { userId } = req.params;
            if (userId === req.user.id) {
                return res.status(400).json({ error: 'Cannot delete yourself' });
            }
            await authService.deleteUser(userId);
            await authService.logAction(
                req.user.id, 'user_deleted', 'user', userId, {},
                req.ip, req.headers['user-agent']
            );
            res.json({ message: 'User deleted successfully' });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
);

// Get audit logs (admin only)
router.get('/audit-logs', 
    authMiddleware.requireAuth, 
    rolesMiddleware.requirePermission('user-management'),
    async (req, res) => {
        try {
            const { userId, limit } = req.query;
            const logs = await authService.getAuditLogs(userId, parseInt(limit) || 50);
            res.json({ logs });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get audit logs' });
        }
    }
);

module.exports = router;