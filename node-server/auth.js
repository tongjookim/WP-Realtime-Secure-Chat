/**
 * JWT 인증 미들웨어 - Socket.io 연결 시 토큰 검증
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-key';

/**
 * Socket.io 연결 인증 미들웨어
 * 클라이언트의 auth.token에서 JWT를 검증하여 사용자 정보를 socket.user에 할당
 */
function authMiddleware(socket, next) {
    const token = socket.handshake.auth?.token;

    if (!token) {
        return next(new Error('인증 토큰이 필요합니다.'));
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);

        // 토큰에서 사용자 정보 추출
        const userData = decoded.data || {};

        socket.user = {
            userId:      String(userData.user_id || decoded.sub),
            username:    userData.username || 'unknown',
            displayName: userData.display_name || '익명',
            email:       userData.email || '',
            avatarUrl:   userData.avatar_url || '',
            isGuest:     userData.is_guest === true,
        };

        next();
    } catch (err) {
        console.error('[Auth] JWT verification failed:', err.message);

        if (err.name === 'TokenExpiredError') {
            return next(new Error('토큰이 만료되었습니다. 페이지를 새로고침하세요.'));
        }

        return next(new Error('유효하지 않은 인증 토큰입니다.'));
    }
}

/**
 * JWT 토큰 생성 유틸 (테스트용)
 */
function generateTestToken(userData) {
    return jwt.sign(
        {
            sub: userData.userId,
            iss: 'wprc-test',
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 86400,
            data: {
                user_id:      userData.userId,
                username:     userData.username,
                display_name: userData.displayName,
                email:        userData.email || '',
                avatar_url:   userData.avatarUrl || '',
                is_guest:     userData.isGuest || false,
            },
        },
        JWT_SECRET
    );
}

module.exports = { authMiddleware, generateTestToken };
