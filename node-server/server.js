/**
 * WP Realtime Secure Chat - Node.js Socket.io 서버
 *
 * ⚠️ 핵심 보안 원칙:
 * - 모든 메시지는 메모리에서만 중계(broadcast)되며, 어떤 DB에도 저장되지 않음
 * - 서버 재시작 시 모든 데이터(방, 접속 정보) 완전 소멸
 * - 클라이언트 새로고침 시 대화 내용 복구 불가
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const { authMiddleware } = require('./auth');
const RoomManager = require('./roomManager');
const PresenceManager = require('./presenceManager');

// ============================================================
// 1. 서버 초기화
// ============================================================

const PORT = process.env.PORT || 3200;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost')
    .split(',')
    .map((s) => s.trim());

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ['GET', 'POST'],
        credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6, // 1MB 메시지 크기 제한
});

// Express 미들웨어
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

// ============================================================
// 2. 메모리 저장소 초기화 (No DB)
// ============================================================

const roomManager = new RoomManager();
const presenceManager = new PresenceManager();

// 기본 로비 채팅방 생성
roomManager.createDefaultRoom();

// ============================================================
// 3. REST API 엔드포인트 (헬스체크 등)
// ============================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        connections: presenceManager.getOnlineCount(),
        rooms: roomManager.rooms.size,
        memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        timestamp: new Date().toISOString(),
    });
});

// ============================================================
// 4. Socket.io 인증 미들웨어
// ============================================================

io.use(authMiddleware);

// ============================================================
// 5. Socket.io 이벤트 핸들러
// ============================================================

io.on('connection', (socket) => {
    const user = socket.user;

    console.log(`[Socket] Connected: ${user.displayName} (${user.userId}) - socket: ${socket.id}`);

    // --- 5.1 접속 등록 ---
    presenceManager.userConnected(socket.id, user);

    // 인증 성공 응답
    socket.emit('auth:success', {
        userId: user.userId,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        isGuest: user.isGuest,
    });

    // 접속자 목록 전송 (본인 포함)
    io.emit('users:list', presenceManager.getOnlineUserList());

    // 새 사용자 접속 알림 (본인 제외)
    socket.broadcast.emit('user:joined', {
        userId: user.userId,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        isGuest: user.isGuest,
    });

    // 방 목록 전송
    socket.emit('rooms:list', roomManager.getUserRooms(user.userId));

    // --- 5.2 채팅방 관리 ---

    /**
     * 방 생성
     */
    socket.on('room:create', (data) => {
        const { name, type } = data || {};
        if (!name || typeof name !== 'string') return;

        const sanitizedName = name.replace(/[<>&"']/g, '').slice(0, 50);
        const room = roomManager.createRoom(sanitizedName, type, user.userId);

        // 생성자 자동 참여
        roomManager.joinRoom(room.id, { ...user, socketId: socket.id });
        socket.join(room.id);

        // 방 생성 알림
        io.emit('room:created', roomManager.serializeRoom(room));
        socket.emit('room:joined', roomManager.serializeRoom(room));
    });

    /**
     * 1:1 DM 방 생성
     */
    socket.on('room:create-dm', (data) => {
        const { targetUserId, targetName } = data || {};
        if (!targetUserId) return;

        const target = presenceManager.getUser(targetUserId);
        if (!target) {
            socket.emit('message:system', '해당 사용자가 오프라인입니다.');
            return;
        }

        const room = roomManager.findOrCreateDM(
            user.userId, user.displayName,
            targetUserId, target.displayName
        );

        // 양쪽 모두 방에 참여
        roomManager.joinRoom(room.id, { ...user, socketId: socket.id });
        socket.join(room.id);

        const targetSocketId = presenceManager.getSocketId(targetUserId);
        if (targetSocketId) {
            roomManager.joinRoom(room.id, { ...target, socketId: targetSocketId });
            io.to(targetSocketId).socketsJoin(room.id);
            io.to(targetSocketId).emit('room:joined', roomManager.serializeRoom(room));
        }

        socket.emit('room:joined', roomManager.serializeRoom(room));
    });

    /**
     * 방 참여
     */
    socket.on('room:join', (data) => {
        const { roomId } = data || {};
        if (!roomId) return;

        const result = roomManager.joinRoom(roomId, { ...user, socketId: socket.id });
        if (!result) {
            socket.emit('message:system', '존재하지 않는 채팅방입니다.');
            return;
        }
        if (result.error) {
            socket.emit('message:system', result.error);
            return;
        }

        socket.join(roomId);
        socket.emit('room:joined', roomManager.serializeRoom(result));

        // 방 참여자에게 알림
        socket.to(roomId).emit('message:system', `${user.displayName}님이 입장했습니다.`);

        // 방 정보 업데이트 브로드캐스트
        io.emit('room:updated', roomManager.serializeRoom(result));
    });

    /**
     * 방 나가기
     */
    socket.on('room:leave', (data) => {
        const { roomId } = data || {};
        if (!roomId) return;

        socket.leave(roomId);
        const result = roomManager.leaveRoom(roomId, user.userId);

        if (result?.deleted) {
            io.emit('room:deleted', roomId);
        } else if (result) {
            socket.to(roomId).emit('message:system', `${user.displayName}님이 퇴장했습니다.`);
            io.emit('room:updated', roomManager.serializeRoom(result));
        }
    });

    /**
     * 사용자 초대
     */
    socket.on('room:invite', (data) => {
        const { roomId, userId: targetId } = data || {};
        if (!roomId || !targetId) return;

        const target = presenceManager.getUser(targetId);
        if (!target) return;

        const targetSocketId = presenceManager.getSocketId(targetId);
        if (!targetSocketId) return;

        const room = roomManager.getRoom(roomId);
        if (!room) return;

        roomManager.joinRoom(roomId, { ...target, socketId: targetSocketId });
        io.to(targetSocketId).socketsJoin(roomId);
        io.to(targetSocketId).emit('room:joined', roomManager.serializeRoom(room));
        io.to(targetSocketId).emit('message:system', `${user.displayName}님이 채팅방에 초대했습니다.`);

        io.to(roomId).emit('message:system', `${target.displayName}님이 초대되었습니다.`);
        io.emit('room:updated', roomManager.serializeRoom(room));
    });

    // --- 5.3 메시지 처리 (핵심: DB 저장 없음) ---

    /**
     * 메시지 전송
     * ⚠️ 메시지는 서버 메모리에 저장하지 않고 즉시 브로드캐스트만 수행
     */
    socket.on('message:send', (data) => {
        const { roomId, text } = data || {};

        // 유효성 검사
        if (!roomId || !text || typeof text !== 'string') return;

        const room = roomManager.getRoom(roomId);
        if (!room || !room.users.has(user.userId)) {
            socket.emit('message:system', '해당 채팅방에 참여하고 있지 않습니다.');
            return;
        }

        // 메시지 길이 제한
        const sanitizedText = text.slice(0, 2000);

        // 메시지 객체 생성 (브로드캐스트용 - 서버에 저장하지 않음)
        const message = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            roomId,
            userId: user.userId,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
            text: sanitizedText,
            timestamp: Date.now(),
        };

        // ✅ 방 참여자에게만 브로드캐스트 후 message 객체는 GC에 의해 자연 소멸
        io.to(roomId).emit('message:receive', message);

        // ❌ 아래와 같은 코드가 절대 존재해서는 안 됨:
        // db.collection('messages').insert(message);
        // redis.lpush('chat:' + roomId, JSON.stringify(message));
        // fs.appendFileSync('chat.log', JSON.stringify(message));
    });

    // --- 5.4 타이핑 인디케이터 ---

    socket.on('typing:start', (data) => {
        const { roomId } = data || {};
        if (!roomId) return;

        socket.to(roomId).emit('typing:show', {
            userId: user.userId,
            displayName: user.displayName,
            roomId,
        });
    });

    socket.on('typing:stop', (data) => {
        const { roomId } = data || {};
        if (!roomId) return;

        socket.to(roomId).emit('typing:hide', {
            userId: user.userId,
            roomId,
        });
    });

    // --- 5.5 사용자 설정 ---

    socket.on('user:change-name', (data) => {
        const { displayName: newName } = data || {};
        if (!newName || typeof newName !== 'string') return;

        const sanitizedName = newName.replace(/[<>&"']/g, '').slice(0, 20);
        const oldName = user.displayName;

        user.displayName = sanitizedName;
        presenceManager.updateDisplayName(user.userId, sanitizedName);

        // 모든 클라이언트에게 접속자 목록 갱신
        io.emit('users:list', presenceManager.getOnlineUserList());

        console.log(`[Socket] Name changed: "${oldName}" → "${sanitizedName}"`);
    });

    // --- 5.6 연결 해제 ---

    socket.on('disconnect', (reason) => {
        console.log(`[Socket] Disconnected: ${user.displayName} (${reason})`);

        // 접속 상태 제거
        presenceManager.userDisconnected(socket.id);

        // 모든 방에서 제거
        const affectedRooms = roomManager.removeUserFromAllRooms(user.userId);

        // 퇴장 알림
        affectedRooms.forEach((roomId) => {
            const room = roomManager.getRoom(roomId);
            if (room) {
                io.to(roomId).emit('message:system', `${user.displayName}님이 퇴장했습니다.`);
                io.emit('room:updated', roomManager.serializeRoom(room));
            } else {
                // 방이 삭제된 경우
                io.emit('room:deleted', roomId);
            }
        });

        // 접속자 목록 갱신
        io.emit('users:list', presenceManager.getOnlineUserList());
        socket.broadcast.emit('user:left', user.userId);
    });
});

// ============================================================
// 6. 서버 시작
// ============================================================

server.listen(PORT, () => {
    console.log('================================================');
    console.log('  WP Realtime Secure Chat - Socket Server');
    console.log('================================================');
    console.log(`  Port:     ${PORT}`);
    console.log(`  Origins:  ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`  Env:      ${process.env.NODE_ENV || 'development'}`);
    console.log(`  Security: NO DATABASE - Memory-Only Broadcast`);
    console.log('================================================');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM received. Shutting down...');
    io.close();
    server.close(() => {
        console.log('[Server] All connections closed. Memory cleared.');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('[Server] SIGINT received. Shutting down...');
    io.close();
    server.close(() => {
        console.log('[Server] All connections closed. Memory cleared.');
        process.exit(0);
    });
});
