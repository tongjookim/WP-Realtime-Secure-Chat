/**
 * WP Realtime Secure Chat - 프론트엔드 클라이언트
 * Socket.io 기반 실시간 채팅 + UI 로직
 */

(function () {
    'use strict';

    // ============================================================
    // 1. 설정 & 상태 관리
    // ============================================================
    const config = window.WPRC_Config || {};
    let socket = null;

    const state = {
        token: config.token || '',
        userId: config.userId || '',
        displayName: config.displayName || '',
        isGuest: !config.isLoggedIn,
        currentRoom: null,
        rooms: new Map(),         // roomId -> { name, type, users[] }
        onlineUsers: new Map(),   // odrinuserId -> { displayName, avatarUrl, isGuest }
        soundEnabled: true,
        typingTimer: null,
    };

    // ============================================================
    // 2. DOM 요소 캐싱
    // ============================================================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const dom = {
        app:            $('#wprc-chat-app'),
        main:           $('#wprc-main'),
        guestForm:      $('#wprc-guest-form'),
        guestNickname:  $('#wprc-guest-nickname'),
        guestJoinBtn:   $('#wprc-guest-join'),

        // 탭
        tabs:           $$('.wprc-tab'),
        tabContents:    $$('.wprc-tab-content'),

        // 채팅방
        roomList:       $('#wprc-room-list'),
        createRoomBtn:  $('#wprc-create-room'),

        // 접속자
        userList:       $('#wprc-user-list'),
        onlineCount:    $('#wprc-online-count'),

        // 설정
        settingNickname:  $('#wprc-setting-nickname'),
        saveNicknameBtn:  $('#wprc-save-nickname'),
        settingSound:     $('#wprc-setting-sound'),

        // 채팅
        noRoom:         $('#wprc-no-room'),
        chatHeader:     $('#wprc-chat-header'),
        currentRoomName:  $('#wprc-current-room-name'),
        currentRoomUsers: $('#wprc-current-room-users'),
        messages:       $('#wprc-messages'),
        inputArea:      $('#wprc-input-area'),
        messageInput:   $('#wprc-message-input'),
        sendBtn:        $('#wprc-send-btn'),
        leaveRoomBtn:   $('#wprc-leave-room'),
        inviteUserBtn:  $('#wprc-invite-user'),
        typingEl:       $('#wprc-typing'),

        // 모달
        modalCreateRoom:     $('#wprc-modal-create-room'),
        newRoomName:         $('#wprc-new-room-name'),
        newRoomType:         $('#wprc-new-room-type'),
        confirmCreateRoom:   $('#wprc-confirm-create-room'),
    };

    // ============================================================
    // 3. 초기화
    // ============================================================
    function init() {
        if (!dom.app) return;

        // 게스트 사용자: 닉네임 입력 후 참여
        if (state.isGuest && dom.guestForm) {
            dom.guestJoinBtn?.addEventListener('click', handleGuestJoin);
            dom.guestNickname?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') handleGuestJoin();
            });
            return;
        }

        // 로그인 사용자: 즉시 연결
        if (state.token) {
            connectSocket();
        }
    }

    /**
     * 게스트 참여 처리
     */
    async function handleGuestJoin() {
        const nickname = dom.guestNickname?.value?.trim();
        if (!nickname) {
            dom.guestNickname.focus();
            return;
        }

        dom.guestJoinBtn.disabled = true;
        dom.guestJoinBtn.textContent = '접속 중...';

        try {
            const resp = await fetch(config.restUrl + 'guest-token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-WP-Nonce': config.nonce,
                },
                body: JSON.stringify({ nickname }),
            });

            const data = await resp.json();

            if (!data.success) {
                alert(data.message || '접속에 실패했습니다.');
                dom.guestJoinBtn.disabled = false;
                dom.guestJoinBtn.textContent = '참여하기';
                return;
            }

            state.token = data.token;
            state.displayName = nickname;
            connectSocket();
        } catch (err) {
            console.error('[WPRC] Guest join error:', err);
            alert('서버 연결에 실패했습니다.');
            dom.guestJoinBtn.disabled = false;
            dom.guestJoinBtn.textContent = '참여하기';
        }
    }

    // ============================================================
    // 4. Socket.io 연결
    // ============================================================
    function connectSocket() {
        if (!config.nodeServerUrl || !state.token) return;

        socket = io(config.nodeServerUrl, {
            auth: { token: state.token },
            transports: ['websocket', 'polling'],
            reconnectionAttempts: 5,
            reconnectionDelay: 2000,
        });

        // 연결 성공
        socket.on('connect', () => {
            console.log('[WPRC] Connected:', socket.id);
            showMainUI();
        });

        // 인증 완료 + 사용자 정보 수신
        socket.on('auth:success', (userData) => {
            state.userId = userData.userId;
            state.displayName = userData.displayName;
            state.isGuest = userData.isGuest;

            if (dom.settingNickname) {
                dom.settingNickname.value = state.displayName;
            }
        });

        // 인증 실패
        socket.on('auth:error', (msg) => {
            console.error('[WPRC] Auth error:', msg);
            alert('인증에 실패했습니다: ' + msg);
            socket.disconnect();
        });

        // 접속자 목록 업데이트
        socket.on('users:list', (users) => {
            state.onlineUsers.clear();
            users.forEach((u) => state.onlineUsers.set(u.userId, u));
            renderUserList();
        });

        // 사용자 접속/퇴장
        socket.on('user:joined', (user) => {
            state.onlineUsers.set(user.userId, user);
            renderUserList();
        });

        socket.on('user:left', (userId) => {
            state.onlineUsers.delete(userId);
            renderUserList();
        });

        // 채팅방 목록
        socket.on('rooms:list', (rooms) => {
            state.rooms.clear();
            rooms.forEach((r) => state.rooms.set(r.id, r));
            renderRoomList();
        });

        // 채팅방 생성/업데이트
        socket.on('room:created', (room) => {
            state.rooms.set(room.id, room);
            renderRoomList();
        });

        socket.on('room:updated', (room) => {
            state.rooms.set(room.id, room);
            renderRoomList();
            if (state.currentRoom === room.id) {
                updateChatHeader(room);
            }
        });

        socket.on('room:deleted', (roomId) => {
            state.rooms.delete(roomId);
            renderRoomList();
            if (state.currentRoom === roomId) {
                leaveCurrentRoom();
            }
        });

        // 메시지 수신
        socket.on('message:receive', (msg) => {
            appendMessage(msg);
            if (state.soundEnabled && msg.userId !== state.userId) {
                playNotificationSound();
            }
        });

        // 시스템 메시지
        socket.on('message:system', (text) => {
            appendSystemMessage(text);
        });

        // 타이핑 인디케이터
        socket.on('typing:show', (data) => {
            if (data.userId !== state.userId && data.roomId === state.currentRoom) {
                dom.typingEl.textContent = `${data.displayName}님이 입력 중...`;
            }
        });

        socket.on('typing:hide', (data) => {
            if (data.userId !== state.userId) {
                dom.typingEl.textContent = '';
            }
        });

        // 방 참여 완료
        socket.on('room:joined', (room) => {
            state.currentRoom = room.id;
            state.rooms.set(room.id, room);
            activateRoom(room);
        });

        // 연결 해제
        socket.on('disconnect', (reason) => {
            console.log('[WPRC] Disconnected:', reason);
        });

        // 에러 처리
        socket.on('connect_error', (err) => {
            console.error('[WPRC] Connection error:', err.message);
        });
    }

    // ============================================================
    // 5. UI 렌더링
    // ============================================================

    function showMainUI() {
        if (dom.guestForm) dom.guestForm.style.display = 'none';
        if (dom.main) dom.main.style.display = 'flex';
        bindUIEvents();
    }

    /**
     * 채팅방 목록 렌더링
     */
    function renderRoomList() {
        if (!dom.roomList) return;

        dom.roomList.innerHTML = '';

        if (state.rooms.size === 0) {
            dom.roomList.innerHTML = '<li class="wprc-empty-hint" style="color:#94a3b8;font-size:12px;padding:16px;text-align:center;">채팅방이 없습니다. 새로 만들어보세요!</li>';
            return;
        }

        state.rooms.forEach((room, roomId) => {
            const li = document.createElement('li');
            li.dataset.roomId = roomId;
            if (state.currentRoom === roomId) li.classList.add('active');

            const icon = room.type === 'private' ? '🔒' : '💬';
            const userCount = room.users?.length || 0;

            li.innerHTML = `
                <div class="wprc-room-icon">${icon}</div>
                <div class="wprc-room-info">
                    <div class="wprc-room-name">${escapeHtml(room.name)}</div>
                    <div class="wprc-room-meta">${userCount}명 참여 중</div>
                </div>
            `;

            li.addEventListener('click', () => joinRoom(roomId));
            dom.roomList.appendChild(li);
        });
    }

    /**
     * 접속자 목록 렌더링
     */
    function renderUserList() {
        if (!dom.userList) return;

        dom.userList.innerHTML = '';
        dom.onlineCount.textContent = state.onlineUsers.size;

        state.onlineUsers.forEach((user, userId) => {
            if (userId === state.userId) return; // 자기 자신 제외

            const li = document.createElement('li');
            li.dataset.userId = userId;

            li.innerHTML = `
                <img class="wprc-user-avatar" src="${escapeHtml(user.avatarUrl || '')}" alt="" />
                <span class="wprc-user-name">${escapeHtml(user.displayName)}${user.isGuest ? ' <small style="color:#94a3b8;">(게스트)</small>' : ''}</span>
                <span class="wprc-status-dot online"></span>
            `;

            // 클릭 시 1:1 대화 시작
            li.addEventListener('click', () => startDirectMessage(userId, user.displayName));
            dom.userList.appendChild(li);
        });
    }

    /**
     * 방 참여 후 채팅 영역 활성화
     */
    function activateRoom(room) {
        dom.noRoom.style.display = 'none';
        dom.chatHeader.style.display = 'flex';
        dom.inputArea.style.display = 'block';
        dom.messages.innerHTML = ''; // 이전 메시지 클리어 (휘발성)
        dom.typingEl.textContent = '';

        updateChatHeader(room);
        renderRoomList(); // active 상태 갱신
        dom.messageInput.focus();
    }

    function updateChatHeader(room) {
        dom.currentRoomName.textContent = room.name;
        dom.currentRoomUsers.textContent = `${room.users?.length || 0}명 참여`;
    }

    /**
     * 메시지 렌더링 (수신)
     */
    function appendMessage(msg) {
        if (!dom.messages) return;

        const isMine = msg.userId === state.userId;
        const div = document.createElement('div');
        div.classList.add('wprc-msg');
        if (isMine) div.classList.add('wprc-msg-mine');

        const time = new Date(msg.timestamp).toLocaleTimeString('ko-KR', {
            hour: '2-digit',
            minute: '2-digit',
        });

        div.innerHTML = `
            <img class="wprc-msg-avatar" src="${escapeHtml(msg.avatarUrl || '')}" alt="" />
            <div class="wprc-msg-body">
                <span class="wprc-msg-sender">${escapeHtml(msg.displayName)}</span>
                <div class="wprc-msg-bubble">${escapeHtml(msg.text)}</div>
                <span class="wprc-msg-time">${time}</span>
            </div>
        `;

        dom.messages.appendChild(div);
        dom.messages.scrollTop = dom.messages.scrollHeight;
    }

    function appendSystemMessage(text) {
        if (!dom.messages) return;

        const div = document.createElement('div');
        div.classList.add('wprc-msg-system');
        div.textContent = text;

        dom.messages.appendChild(div);
        dom.messages.scrollTop = dom.messages.scrollHeight;
    }

    // ============================================================
    // 6. 소켓 이벤트 발송
    // ============================================================

    /**
     * 메시지 전송
     */
    function sendMessage() {
        const text = dom.messageInput?.value?.trim();
        if (!text || !state.currentRoom || !socket) return;

        socket.emit('message:send', {
            roomId: state.currentRoom,
            text: text,
        });

        dom.messageInput.value = '';
        dom.messageInput.focus();

        // 타이핑 중지 알림
        socket.emit('typing:stop', { roomId: state.currentRoom });
    }

    /**
     * 방 참여
     */
    function joinRoom(roomId) {
        if (!socket) return;
        if (state.currentRoom === roomId) return;

        // 이전 방에서 나가기
        if (state.currentRoom) {
            socket.emit('room:leave', { roomId: state.currentRoom });
        }

        socket.emit('room:join', { roomId });
    }

    /**
     * 방 생성
     */
    function createRoom(name, type) {
        if (!socket) return;
        socket.emit('room:create', { name, type });
    }

    /**
     * 1:1 대화 시작
     */
    function startDirectMessage(targetUserId, targetName) {
        if (!socket) return;
        socket.emit('room:create-dm', {
            targetUserId,
            targetName,
        });
    }

    /**
     * 현재 방 나가기
     */
    function leaveCurrentRoom() {
        if (state.currentRoom && socket) {
            socket.emit('room:leave', { roomId: state.currentRoom });
        }

        state.currentRoom = null;
        dom.noRoom.style.display = 'flex';
        dom.chatHeader.style.display = 'none';
        dom.inputArea.style.display = 'none';
        dom.messages.innerHTML = '';
        renderRoomList();
    }

    // ============================================================
    // 7. UI 이벤트 바인딩
    // ============================================================

    function bindUIEvents() {
        // 탭 전환
        dom.tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                dom.tabs.forEach((t) => t.classList.remove('active'));
                dom.tabContents.forEach((c) => c.classList.remove('active'));
                tab.classList.add('active');
                const target = tab.dataset.tab;
                $(`#wprc-tab-${target}`)?.classList.add('active');
            });
        });

        // 메시지 전송
        dom.sendBtn?.addEventListener('click', sendMessage);
        dom.messageInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // 타이핑 인디케이터
        dom.messageInput?.addEventListener('input', () => {
            if (!socket || !state.currentRoom) return;

            socket.emit('typing:start', { roomId: state.currentRoom });

            clearTimeout(state.typingTimer);
            state.typingTimer = setTimeout(() => {
                socket.emit('typing:stop', { roomId: state.currentRoom });
            }, 1500);
        });

        // 방 생성 모달
        dom.createRoomBtn?.addEventListener('click', () => {
            dom.modalCreateRoom.style.display = 'flex';
            dom.newRoomName.value = '';
            dom.newRoomName.focus();
        });

        dom.confirmCreateRoom?.addEventListener('click', () => {
            const name = dom.newRoomName.value.trim();
            const type = dom.newRoomType.value;
            if (!name) return;
            createRoom(name, type);
            dom.modalCreateRoom.style.display = 'none';
        });

        // 모달 닫기
        $$('.wprc-modal-close').forEach((btn) => {
            btn.addEventListener('click', () => {
                btn.closest('.wprc-modal').style.display = 'none';
            });
        });

        dom.modalCreateRoom?.addEventListener('click', (e) => {
            if (e.target === dom.modalCreateRoom) {
                dom.modalCreateRoom.style.display = 'none';
            }
        });

        // 방 나가기
        dom.leaveRoomBtn?.addEventListener('click', leaveCurrentRoom);

        // 1:1 대화 초대
        dom.inviteUserBtn?.addEventListener('click', () => {
            // 간단한 프롬프트 방식 (추후 모달로 개선 가능)
            const userId = prompt('초대할 사용자 ID를 입력하세요:');
            if (userId && state.currentRoom) {
                socket.emit('room:invite', { roomId: state.currentRoom, userId });
            }
        });

        // 닉네임 변경
        dom.saveNicknameBtn?.addEventListener('click', () => {
            const newName = dom.settingNickname.value.trim();
            if (!newName || !socket) return;
            socket.emit('user:change-name', { displayName: newName });
            state.displayName = newName;
        });

        // 알림음 토글
        dom.settingSound?.addEventListener('change', (e) => {
            state.soundEnabled = e.target.checked;
        });
    }

    // ============================================================
    // 8. 유틸리티
    // ============================================================

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function playNotificationSound() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.setValueAtTime(800, ctx.currentTime);
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
        } catch (e) {
            // 알림음 재생 실패 무시
        }
    }

    // ============================================================
    // 9. 앱 시작
    // ============================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
