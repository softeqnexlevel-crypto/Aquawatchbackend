// backend/routes/auth.routes.js
const express = require('express');
const router = express.Router();
const authService = require('../services/auth.service');
const authMiddleware = require('../middleware/auth.middleware');

// ==================== PUBLIC ROUTES ====================

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        const deviceInfo = { ip: req.ip, userAgent: req.headers['user-agent'] };
        const result = await authService.login(email, password, deviceInfo);
        res.json({ message: 'Login successful', ...result });
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

// Register — admin-only (was public before, security fix)
router.post('/register', authMiddleware.requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const { email, password, firstName, lastName, role } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        const user = await authService.register({ email, password, firstName, lastName, role: role || 'operator' });
        res.status(201).json({ message: 'User registered successfully', user });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

router.get('/me', authMiddleware.requireAuth, async (req, res) => {
    try {
        res.json({ user: req.user });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get user' });
    }
});

router.post('/logout', authMiddleware.requireAuth, async (req, res) => {
    try {
        const { refreshToken } = req.body;
        await authService.logout(req.user.id, refreshToken);
        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Logout failed' });
    }
});

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

router.get('/users', authMiddleware.requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const users = await authService.getAllUsers();
        res.json({ users });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get users' });
    }
});

router.put('/users/:userId', authMiddleware.requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const { userId } = req.params;
        const { firstName, lastName, role, isActive } = req.body;
        const user = await authService.updateUser(userId, { firstName, lastName, role, isActive });
        res.json({ message: 'User updated successfully', user });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

router.delete('/users/:userId', authMiddleware.requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const { userId } = req.params;
        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete yourself' });
        }
        await authService.deleteUser(userId);
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

router.get('/audit-logs', authMiddleware.requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const { userId, limit } = req.query;
        const logs = await authService.getAuditLogs(userId, parseInt(limit) || 50);
        res.json({ logs });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get audit logs' });
    }
});

module.exports = router;