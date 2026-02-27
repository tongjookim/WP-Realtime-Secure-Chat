/**
 * 채팅방 관리자 (순수 메모리 기반 - DB 저장 없음)
 *
 * 모든 데이터는 Node.js 프로세스 메모리에만 존재하며,
 * 서버 재시작 시 모든 방과 데이터가 완전히 소멸됩니다.
 */

const { v4: uuidv4 } = require('uuid');

class RoomManager {

    constructor() {
        /**
         * rooms: Map<roomId, RoomData>
         * RoomData = {
         *   id: string,
         *   name: string,
         *   type: 'public' | 'private' | 'dm',
         *   createdBy: string (userId),
         *   users: Map<userId, { userId, displayName, avatarUrl, socketId }>,
         *   createdAt: number (timestamp)
         * }
         */
        this.rooms = new Map();
        this.maxRoomUsers = parseInt(process.env.MAX_ROOM_USERS) || 50;
    }

    /**
     * 기본 채팅방 생성
     */
    createDefaultRoom() {
        const defaultName = process.env.DEFAULT_ROOM_NAME || '일반 채팅';
        const roomId = 'default-lobby';

        this.rooms.set(roomId, {
            id: roomId,
            name: defaultName,
            type: 'public',
            createdBy: 'system',
            users: new Map(),
            createdAt: Date.now(),
        });

        console.log(`[RoomManager] Default room created: "${defaultName}" (${roomId})`);
        return roomId;
    }

    /**
     * 채팅방 생성
     */
    createRoom(name, type, createdBy) {
        const roomId = 'room_' + uuidv4().slice(0, 8);

        const room = {
            id: roomId,
            name: name.slice(0, 50),
            type: type || 'public',
            createdBy,
            users: new Map(),
            createdAt: Date.now(),
        };

        this.rooms.set(roomId, room);
        console.log(`[RoomManager] Room created: "${name}" (${roomId}) by ${createdBy}`);
        return room;
    }

    /**
     * 1:1 DM 방 생성 또는 기존 방 반환
     */
    findOrCreateDM(userId1, userName1, userId2, userName2) {
        // 기존 DM 방 검색
        for (const [roomId, room] of this.rooms) {
            if (room.type === 'dm') {
                const userIds = Array.from(room.users.keys());
                // 현재 방의 생성 기준 사용자 확인
                if (room.dmPair && room.dmPair.includes(userId1) && room.dmPair.includes(userId2)) {
                    return room;
                }
            }
        }

        // 새 DM 방 생성
        const roomId = 'dm_' + uuidv4().slice(0, 8);
        const room = {
            id: roomId,
            name: `${userName1} ↔ ${userName2}`,
            type: 'dm',
            createdBy: userId1,
            dmPair: [userId1, userId2],
            users: new Map(),
            createdAt: Date.now(),
        };

        this.rooms.set(roomId, room);
        console.log(`[RoomManager] DM room created: ${roomId} (${userName1} ↔ ${userName2})`);
        return room;
    }

    /**
     * 방에 사용자 추가
     */
    joinRoom(roomId, user) {
        const room = this.rooms.get(roomId);
        if (!room) return null;

        if (room.users.size >= this.maxRoomUsers) {
            return { error: '방 최대 인원을 초과했습니다.' };
        }

        room.users.set(user.userId, {
            userId: user.userId,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
            socketId: user.socketId,
        });

        return room;
    }

    /**
     * 방에서 사용자 제거
     */
    leaveRoom(roomId, userId) {
        const room = this.rooms.get(roomId);
        if (!room) return null;

        room.users.delete(userId);

        // 빈 방 자동 삭제 (기본 로비 제외)
        if (room.users.size === 0 && roomId !== 'default-lobby') {
            this.rooms.delete(roomId);
            console.log(`[RoomManager] Empty room deleted: ${roomId}`);
            return { deleted: true, roomId };
        }

        return room;
    }

    /**
     * 특정 사용자를 모든 방에서 제거
     */
    removeUserFromAllRooms(userId) {
        const affectedRooms = [];

        for (const [roomId, room] of this.rooms) {
            if (room.users.has(userId)) {
                room.users.delete(userId);
                affectedRooms.push(roomId);

                // 빈 방 자동 삭제
                if (room.users.size === 0 && roomId !== 'default-lobby') {
                    this.rooms.delete(roomId);
                }
            }
        }

        return affectedRooms;
    }

    /**
     * 방 정보 조회
     */
    getRoom(roomId) {
        return this.rooms.get(roomId) || null;
    }

    /**
     * 공개 방 목록 (직렬화)
     */
    getPublicRooms() {
        const result = [];
        for (const [, room] of this.rooms) {
            if (room.type !== 'dm') {
                result.push(this.serializeRoom(room));
            }
        }
        return result;
    }

    /**
     * 사용자가 참여 중인 방 목록
     */
    getUserRooms(userId) {
        const result = [];
        for (const [, room] of this.rooms) {
            if (room.users.has(userId) || room.type === 'public') {
                result.push(this.serializeRoom(room));
            }
        }
        return result;
    }

    /**
     * 방 데이터 직렬화 (클라이언트 전송용)
     */
    serializeRoom(room) {
        return {
            id: room.id,
            name: room.name,
            type: room.type,
            createdBy: room.createdBy,
            users: Array.from(room.users.values()),
            createdAt: room.createdAt,
        };
    }
}

module.exports = RoomManager;
