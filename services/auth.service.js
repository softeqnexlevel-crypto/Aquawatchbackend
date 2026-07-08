const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pasetoService = require('./paseto.service');

// In-memory database
const users = [];
const refreshTokens = [];

// Add default users with correct passwords
async function initUsers() {
    const salt = await bcrypt.genSalt(10);
    
    users.push({
        id: '1',
        email: 'admin@aquaops.co.ke',
        password_hash: await bcrypt.hash('admin123', salt),
        first_name: 'John',
        last_name: 'Mwangi',
        role: 'admin',
        is_active: true,
        created_at: new Date().toISOString()
    });
    
    users.push({
        id: '2',
        email: 'operator@aquaops.co.ke',
        password_hash: await bcrypt.hash('operator123', salt),
        first_name: 'Grace',
        last_name: 'Wanjiku',
        role: 'operator',
        is_active: true,
        created_at: new Date().toISOString()
    });
    
    users.push({
        id: '3',
        email: 'client@aquaops.co.ke',
        password_hash: await bcrypt.hash('client123', salt),
        first_name: 'Peter',
        last_name: 'Kamau',
        role: 'client',
        is_active: true,
        created_at: new Date().toISOString()
    });
    
    console.log('Default users created');
}

initUsers();

class AuthService {
    async login(email, password) {
        const user = users.find(u => u.email === email.toLowerCase());
        if (!user) throw new Error('Invalid credentials');
        if (!user.is_active) throw new Error('Account disabled');
        
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) throw new Error('Invalid credentials');
        
        const accessToken = await pasetoService.generateAccessToken(user);
        const refreshToken = await pasetoService.generateRefreshToken(user);
        
        // Store refresh token hash
        refreshTokens.push({
            user_id: user.id,
            token_hash: crypto.createHash('sha256').update(refreshToken).digest('hex'),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        });
        
        return {
            user: {
                id: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                role: user.role
            },
            accessToken,
            refreshToken,
            expiresIn: 900
        };
    }
    
    async refreshToken(token) {
        const payload = await pasetoService.verifyRefreshToken(token);
        if (!payload) throw new Error('Invalid refresh token');
        
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        const stored = refreshTokens.find(t => t.token_hash === hash && new Date(t.expires_at) > new Date());
        if (!stored) throw new Error('Invalid refresh token');
        
        const user = users.find(u => u.id === payload.sub);
        if (!user || !user.is_active) throw new Error('User not found');
        
        // Remove old token
        const index = refreshTokens.indexOf(stored);
        refreshTokens.splice(index, 1);
        
        // Generate new tokens
        const accessToken = await pasetoService.generateAccessToken(user);
        const newRefreshToken = await pasetoService.generateRefreshToken(user);
        
        refreshTokens.push({
            user_id: user.id,
            token_hash: crypto.createHash('sha256').update(newRefreshToken).digest('hex'),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        });
        
        return {
            accessToken,
            refreshToken: newRefreshToken,
            expiresIn: 900
        };
    }
    
    async getUserById(id) {
        const user = users.find(u => u.id === id);
        if (!user) return null;
        return {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            role: user.role,
            is_active: user.is_active
        };
    }
    
    async getAllUsers() {
        return users.map(u => ({
            id: u.id,
            email: u.email,
            first_name: u.first_name,
            last_name: u.last_name,
            role: u.role,
            is_active: u.is_active,
            created_at: u.created_at
        }));
    }
    
    async register(userData) {
        const exists = users.find(u => u.email === userData.email.toLowerCase());
        if (exists) throw new Error('User already exists');
        
        const salt = await bcrypt.genSalt(10);
        const user = {
            id: crypto.randomUUID(),
            email: userData.email.toLowerCase(),
            password_hash: await bcrypt.hash(userData.password, salt),
            first_name: userData.firstName,
            last_name: userData.lastName || '',
            role: userData.role || 'operator',
            is_active: true,
            created_at: new Date().toISOString()
        };
        
        users.push(user);
        return {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            role: user.role
        };
    }
    
    async updateUser(id, updates) {
        const user = users.find(u => u.id === id);
        if (!user) throw new Error('User not found');
        
        if (updates.firstName) user.first_name = updates.firstName;
        if (updates.lastName) user.last_name = updates.lastName;
        if (updates.role) user.role = updates.role;
        if (typeof updates.isActive !== 'undefined') user.is_active = updates.isActive;
        
        return {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            role: user.role,
            is_active: user.is_active
        };
    }
    
    async deleteUser(id) {
        const index = users.findIndex(u => u.id === id);
        if (index === -1) throw new Error('User not found');
        users.splice(index, 1);
        return true;
    }
    
    async logout(userId, refreshToken) {
        if (refreshToken) {
            const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
            const index = refreshTokens.findIndex(t => t.token_hash === hash);
            if (index !== -1) refreshTokens.splice(index, 1);
        }
        return true;
    }
}

module.exports = new AuthService();