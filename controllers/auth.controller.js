// backend/src/controllers/auth.controller.js
const authService = require('../services/auth.service');

class AuthController {
    /**
     * Register new user
     */
    async register(req, res) {
        try {
            const { email, password, firstName, lastName, role } = req.body;

            if (!email || !password) {
                return res.status(400).json({ 
                    error: 'Email and password required' 
                });
            }

            if (password.length < 8) {
                return res.status(400).json({ 
                    error: 'Password must be at least 8 characters' 
                });
            }

            const user = await authService.register({
                email,
                password,
                firstName,
                lastName,
                role
            });

            // Log registration
            await authService.logAction(
                user.id, 
                'user_registered', 
                'auth', 
                { email: user.email },
                req.ip,
                req.headers['user-agent']
            );

            res.status(201).json({
                message: 'User registered successfully',
                user
            });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * Login
     */
    async login(req, res) {
        try {
            const { email, password } = req.body;

            if (!email || !password) {
                return res.status(400).json({ 
                    error: 'Email and password required' 
                });
            }

            const deviceInfo = {
                ip: req.ip,
                userAgent: req.headers['user-agent'],
                platform: req.headers['sec-ch-ua-platform'] || 'unknown'
            };

            const result = await authService.login(email, password, deviceInfo);
            res.json({
                message: 'Login successful',
                ...result
            });
        } catch (error) {
            res.status(401).json({ error: error.message });
        }
    }

    /**
     * Refresh token
     */
    async refresh(req, res) {
        try {
            const { refreshToken } = req.body;

            if (!refreshToken) {
                return res.status(400).json({ 
                    error: 'Refresh token required' 
                });
            }

            const result = await authService.refreshToken(refreshToken);
            res.json(result);
        } catch (error) {
            res.status(401).json({ error: error.message });
        }
    }

    /**
     * Logout
     */
    async logout(req, res) {
        try {
            const { refreshToken } = req.body;
            await authService.logout(req.user.id, refreshToken);
            
            await authService.logAction(
                req.user.id,
                'logout',
                'auth',
                {},
                req.ip,
                req.headers['user-agent']
            );

            res.json({ message: 'Logged out successfully' });
        } catch (error) {
            res.status(500).json({ error: 'Logout failed' });
        }
    }

    /**
     * Get current user
     */
    async getCurrentUser(req, res) {
        try {
            res.json({ user: req.user });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get user' });
        }
    }

    /**
     * Change password
     */
    async changePassword(req, res) {
        try {
            const { currentPassword, newPassword } = req.body;

            if (!currentPassword || !newPassword) {
                return res.status(400).json({ 
                    error: 'Current and new password required' 
                });
            }

            if (newPassword.length < 8) {
                return res.status(400).json({ 
                    error: 'Password must be at least 8 characters' 
                });
            }

            await authService.changePassword(req.user.id, currentPassword, newPassword);
            
            await authService.logAction(
                req.user.id,
                'password_changed',
                'user',
                {},
                req.ip,
                req.headers['user-agent']
            );

            res.json({ message: 'Password changed successfully' });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * Get all users (admin only)
     */
    async getAllUsers(req, res) {
        try {
            const users = await authService.getAllUsers();
            res.json({ users });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get users' });
        }
    }

    /**
     * Update user (admin only)
     */
    async updateUser(req, res) {
        try {
            const { userId } = req.params;
            const { firstName, lastName, role, isActive } = req.body;

            const user = await authService.updateUser(userId, {
                firstName,
                lastName,
                role,
                isActive
            });

            res.json({ message: 'User updated successfully', user });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * Delete user (admin only)
     */
    async deleteUser(req, res) {
        try {
            const { userId } = req.params;

            if (userId === req.user.id) {
                return res.status(400).json({ 
                    error: 'Cannot delete yourself' 
                });
            }

            await authService.deleteUser(userId);
            res.json({ message: 'User deleted successfully' });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}

module.exports = new AuthController();