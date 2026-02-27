/**
 * 접속 상태 관리자 (순수 메모리 기반)
 *
 * 온라인/오프라인 상태를 추적하며,
 * 서버 재시작 시 모든 데이터가 소멸됩니다.
 */

class PresenceManager {

    constructor() {
        /**
         * onlineUsers: Map<userId, UserPresence>
         * UserPresence = {
         *   userId: string,
         *   displayName: string,
         *   avatarUrl: string,
         *   isGuest: boolean,
         *   socketId: string,
         *   connectedAt: number (timestamp)
         * }
         */
        this.onlineUsers = new Map();

        /**
         * socketToUser: Map<socketId, userId>
         * 소켓 ID → 사용자 ID 역매핑 (disconnect 시 사용)
         */
        this.socketToUser = new Map();
    }

    /**
     * 사용자 접속 등록
     */
    userConnected(socketId, user) {
        const presence = {
            userId:      user.userId,
            displayName: user.displayName,
            avatarUrl:   user.avatarUrl,
            isGuest:     user.isGuest,
            socketId:    socketId,
            connectedAt: Date.now(),
        };

        this.onlineUsers.set(user.userId, presence);
        this.socketToUser.set(socketId, user.userId);

        console.log(`[Presence] Online: ${user.displayName} (${user.userId})`);
        return presence;
    }

    /**
     * 사용자 접속 해제 (소켓 ID 기반)
     */
    userDisconnected(socketId) {
        const userId = this.socketToUser.get(socketId);
        if (!userId) return null;

        const user = this.onlineUsers.get(userId);
        this.onlineUsers.delete(userId);
        this.socketToUser.delete(socketId);

        if (user) {
            console.log(`[Presence] Offline: ${user.displayName} (${userId})`);
        }

        return userId;
    }

    /**
     * 사용자 닉네임 변경
     */
    updateDisplayName(userId, newName) {
        const user = this.onlineUsers.get(userId);
        if (user) {
            user.displayName = newName;
        }
    }

    /**
     * 특정 사용자 정보 조회
     */
    getUser(userId) {
        return this.onlineUsers.get(userId) || null;
    }

    /**
     * 특정 사용자의 소켓 ID 조회
     */
    getSocketId(userId) {
        return this.onlineUsers.get(userId)?.socketId || null;
    }

    /**
     * 사용자 온라인 여부 확인
     */
    isOnline(userId) {
        return this.onlineUsers.has(userId);
    }

    /**
     * 전체 접속자 목록 (직렬화)
     */
    getOnlineUserList() {
        return Array.from(this.onlineUsers.values()).map((u) => ({
            userId:      u.userId,
            displayName: u.displayName,
            avatarUrl:   u.avatarUrl,
            isGuest:     u.isGuest,
        }));
    }

    /**
     * 접속자 수
     */
    getOnlineCount() {
        return this.onlineUsers.size;
    }
}

module.exports = PresenceManager;
