/**
 * WP Realtime Secure Chat - 프론트엔드 클라이언트
 * Socket.io 기반 실시간 채팅 + 3단 UI 로직 (세션 스토리지 적용 완료)
 */

(function () {
    'use strict';

    // ============================================================
    // 1. 설정 & 상태 관리
    // ============================================================
    const config = window.WPRC_Config || {};
    let socket = null;

    // 🚀 [추가된 부분] 새로고침 전 저장된 게스트 정보와 마지막 방 ID 불러오기
    const _guestAuth = JSON.parse(sessionStorage.getItem('wprc_guest') || '{}');
    const _lastRoomId = sessionStorage.getItem('wprc_last_room') || null;

    const state = {
        token: config.token || '',
        userId: config.userId || '',
        displayName: config.displayName || '',
        isGuest: !config.isLoggedIn,
        currentRoom: null,
        lastRoomId: _lastRoomId,  // 🚀 [추가된 부분]
        rooms: new Map(),         // roomId -> { name, type, users[] }
        onlineUsers: new Map(),   // userId -> { displayName, avatarUrl, isGuest }
        soundEnabled: true,
        typingTimer: null,
    };

    // ============================================================
    // 2. DOM 요소 캐싱
    // ============================================================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    let dom = {}; 

    // ============================================================
    // 3. 초기화
    // ============================================================
    function init() {
        dom = {
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

            // 중앙 채팅
            noRoom:         $('#wprc-no-room'),
            chatHeader:     $('#wprc-chat-header'),
            currentRoomName:  $('#wprc-current-room-name'),
            currentRoomUsers: $('#wprc-current-room-users'),
            messages:       $('#wprc-messages'),
            inputArea:      $('#wprc-input-area'),
            messageInput:   $('#wprc-message-input'),
            sendBtn:        $('#wprc-send-btn'),
            typingEl:       $('#wprc-typing'),

            // 우측 패널 추가 요소
            rightSidebar:     $('#wprc-right-sidebar'),
            infoToggleBtn:    $('#wprc-info-toggle'),
            rightRoomName:    $('#wprc-right-room-name-display'),
            leaveRoomBtn:     $('#wprc-leave-room'),
            inviteUserBtn:    $('#wprc-invite-user'), // 필요시 사용

            // 모달
            modalCreateRoom:     $('#wprc-modal-create-room'),
            newRoomName:         $('#wprc-new-room-name'),
            newRoomType:         $('#wprc-new-room-type'),
            confirmCreateRoom:   $('#wprc-confirm-create-room'),
        };

        if (!dom.app) return;

        // 게스트 사용자
        if (state.isGuest && dom.guestForm) {
            dom.guestJoinBtn?.addEventListener('click', handleGuestJoin);
            dom.guestNickname?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') handleGuestJoin();
            });
            return;
        }

        // 로그인 사용자
        if (state.token) {
            connectSocket();
        }
    }

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

            // 🚀 [추가된 부분] 게스트 토큰을 세션에 저장하여 페이지 이동 시 유지
            sessionStorage.setItem('wprc_guest', JSON.stringify({
                token: data.token,
                displayName: nickname
            }));

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

        socket.on('connect', () => {
            console.log('[WPRC] Connected:', socket.id);
            showMainUI();
        });

        socket.on('auth:success', (userData) => {
            state.userId = userData.userId;
            state.displayName = userData.displayName;
            state.isGuest = userData.isGuest;

            // 🚀 [추가된 부분] 게스트인 경우 서버가 발급한 userId까지 세션에 완벽히 저장
            if (state.isGuest) {
                const guestData = JSON.parse(sessionStorage.getItem('wprc_guest') || '{}');
                guestData.userId = userData.userId;
                sessionStorage.setItem('wprc_guest', JSON.stringify(guestData));
            }

            if (dom.settingNickname) {
                dom.settingNickname.value = state.displayName;
            }
        });

        socket.on('auth:error', (msg) => {
            console.error('[WPRC] Auth error:', msg);
            alert('인증에 실패했습니다: ' + msg);
            socket.disconnect();
        });

        socket.on('users:list', (users) => {
            state.onlineUsers.clear();
            users.forEach((u) => state.onlineUsers.set(u.userId, u));
            renderUserList();
        });

        socket.on('user:joined', (user) => {
            state.onlineUsers.set(user.userId, user);
            renderUserList();
        });

        socket.on('user:left', (userId) => {
            state.onlineUsers.delete(userId);
            renderUserList();
        });

        socket.on('rooms:list', (rooms) => {
            state.rooms.clear();
            rooms.forEach((r) => state.rooms.set(r.id, r));
            renderRoomList();

            // 🚀 [추가된 부분] 페이지 이동/새로고침 시 마지막으로 보던 방에 자동 재입장
            if (state.lastRoomId && state.rooms.has(state.lastRoomId)) {
                socket.emit('room:join', { roomId: state.lastRoomId });
            }
        });

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

        socket.on('message:receive', (msg) => {
            appendMessage(msg);
            
            // 세션 스토리지에 메시지 저장
            saveMessageToLocal(msg);

            if (state.soundEnabled && msg.userId !== state.userId) {
                playNotificationSound();
            }
        });

        socket.on('message:system', (text) => {
            appendSystemMessage(text);
        });

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

        socket.on('room:joined', (room) => {
            state.currentRoom = room.id;
            state.rooms.set(room.id, room);

            // 🚀 [추가된 부분] 방에 입장하면 해당 방 ID를 세션에 기록
            state.lastRoomId = room.id;
            sessionStorage.setItem('wprc_last_room', room.id);

            
            activateRoom(room);
        });

        socket.on('disconnect', (reason) => {
            console.log('[WPRC] Disconnected:', reason);
        });

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

            // 첫 글자를 아바타로 사용 (디자인 참고)
            const initial = room.name ? room.name.charAt(0) : '방';
            const userCount = room.users?.length || 0;

            li.innerHTML = `
                <div class="wprc-room-icon" style="background:#d1d5db; color:#4b5563; font-weight:bold;">${initial}</div>
                <div class="wprc-room-info">
                    <div class="wprc-room-name">${escapeHtml(room.name)}</div>
                    <div class="wprc-room-meta">${userCount}명 참여 중</div>
                </div>
            `;

            li.addEventListener('click', () => joinRoom(roomId));
            dom.roomList.appendChild(li);
        });
    }

    function renderUserList() {
        if (!dom.userList) return;

        dom.userList.innerHTML = '';
        dom.onlineCount.textContent = state.onlineUsers.size;

        state.onlineUsers.forEach((user, userId) => {
            if (userId === state.userId) return;

            const li = document.createElement('li');
            li.dataset.userId = userId;
            const initial = user.displayName ? user.displayName.charAt(0) : 'U';

            li.innerHTML = `
                <div class="wprc-user-avatar" style="background:#d1d5db; color:#4b5563; display:flex; align-items:center; justify-content:center; font-weight:bold;">${initial}</div>
                <span class="wprc-user-name">${escapeHtml(user.displayName)}${user.isGuest ? ' <small style="color:#94a3b8;">(게스트)</small>' : ''}</span>
                <span class="wprc-status-dot online"></span>
            `;

            li.addEventListener('click', () => startDirectMessage(userId, user.displayName));
            dom.userList.appendChild(li);
        });
    }

    function activateRoom(room) {
        dom.noRoom.style.display = 'none';
        dom.chatHeader.style.display = 'flex';
        dom.inputArea.style.display = 'flex'; 
        dom.messages.innerHTML = '';

        loadMessagesFromLocal(room);

        dom.typingEl.textContent = '';

        dom.currentRoomName.textContent = room.name;
        dom.currentRoomUsers.textContent = `${room.users?.length || 0}명 참여`;

        // 우측 패널: 방 입장 시 자동으로 표시
        if (dom.rightSidebar) {
            dom.rightSidebar.classList.add('active');
            dom.rightSidebar.style.display = 'flex';
        }
        if (dom.rightRoomName) {
            dom.rightRoomName.textContent = config.displayName || '';
        }

        renderRoomList();
        dom.messageInput.focus();
    }

    function updateChatHeader(room) {
        dom.currentRoomName.textContent = room.name;
        dom.currentRoomUsers.textContent = `${room.users?.length || 0}명 참여`;
        
        // 우측 패널의 아바타 이름도 동시에 업데이트
        //if(dom.rightRoomName) {
        //    dom.rightRoomName.textContent = room.name;
        //}
    }

    function appendMessage(msg) {
        if (!dom.messages) return;

        const isMine = msg.userId === state.userId;
        const div = document.createElement('div');
        div.classList.add('wprc-msg');
        if (isMine) div.classList.add('wprc-msg-mine');

        const initial = msg.displayName ? msg.displayName.charAt(0) : 'U';

        div.innerHTML = `
            <div class="wprc-msg-avatar" style="display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:bold; color:#6b7280;">${initial}</div>
            <div class="wprc-msg-body">
                <span class="wprc-msg-sender">${escapeHtml(msg.displayName)}</span>
                <div class="wprc-msg-bubble">${escapeHtml(msg.text)}</div>
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
    function sendMessage() {
        const text = dom.messageInput?.value?.trim();
        if (!text || !state.currentRoom || !socket) return;

        socket.emit('message:send', {
            roomId: state.currentRoom,
            text: text,
        });

        dom.messageInput.value = '';
        dom.messageInput.focus();
        socket.emit('typing:stop', { roomId: state.currentRoom });
    }

    function joinRoom(roomId) {
        if (!socket) return;
        if (state.currentRoom === roomId) return;

        if (state.currentRoom) {
            socket.emit('room:leave', { roomId: state.currentRoom });
        }
        socket.emit('room:join', { roomId });
    }

    function createRoom(name, type) {
        if (!socket) return;
        socket.emit('room:create', { name, type });
    }

    function startDirectMessage(targetUserId, targetName) {
        if (!socket) return;
        socket.emit('room:create-dm', { targetUserId, targetName });
    }

    function leaveCurrentRoom() {
        if (state.currentRoom && socket) {
            socket.emit('room:leave', { roomId: state.currentRoom });
        }

        state.currentRoom = null;

        // 🚀 [추가된 부분] 방을 완전히 나갔으므로 기억된 기록 삭제
        state.lastRoomId = null;
        sessionStorage.removeItem('wprc_last_room');

        
        dom.noRoom.style.display = 'flex';
        dom.chatHeader.style.display = 'none';
        dom.inputArea.style.display = 'none';
        dom.messages.innerHTML = '';
        
        // 방 나가면 우측 패널 무조건 닫기
        if (dom.rightSidebar) { dom.rightSidebar.classList.remove('active'); dom.rightSidebar.style.display = 'none'; }
        
        renderRoomList();
    }

    // ============================================================
    // 7. UI 이벤트 바인딩
    // ============================================================
    function bindUIEvents() {
        
        // 👇 [핵심 추가] 우측 정보 탭 토글 기능
        if (dom.infoToggleBtn && dom.rightSidebar) {
            dom.infoToggleBtn.addEventListener('click', () => {
                const _isActive = dom.rightSidebar.classList.toggle('active');
                    dom.rightSidebar.style.display = _isActive ? 'flex' : 'none';
            });
        }
        
        // 탭 기능
        dom.tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                dom.tabs.forEach((t) => t.classList.remove('active'));
                dom.tabContents.forEach((c) => c.classList.remove('active'));
                tab.classList.add('active');
                const target = tab.dataset.tab;
                $(`#wprc-tab-${target}`)?.classList.add('active');
            });
        });

        dom.sendBtn?.addEventListener('click', sendMessage);
        dom.messageInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        dom.messageInput?.addEventListener('input', () => {
            if (!socket || !state.currentRoom) return;

            socket.emit('typing:start', { roomId: state.currentRoom });

            clearTimeout(state.typingTimer);
            state.typingTimer = setTimeout(() => {
                socket.emit('typing:stop', { roomId: state.currentRoom });
            }, 1500);
        });

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

        dom.leaveRoomBtn?.addEventListener('click', leaveCurrentRoom);

        dom.inviteUserBtn?.addEventListener('click', () => {
            const userId = prompt('초대할 사용자 ID를 입력하세요:');
            if (userId && state.currentRoom) {
                socket.emit('room:invite', { roomId: state.currentRoom, userId });
            }
        });

        dom.saveNicknameBtn?.addEventListener('click', () => {
            const newName = dom.settingNickname.value.trim();
            if (!newName || !socket) return;
            socket.emit('user:change-name', { displayName: newName });
            state.displayName = newName;
        });

        dom.settingSound?.addEventListener('change', (e) => {
            state.soundEnabled = e.target.checked;
        });
    }

    // ============================================================
    // 8. 유틸리티 & 스토리지 관리 
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
        } catch (e) {}
    }

    function saveMessageToLocal(msg) {
        if (!msg || !msg.roomId) return;
        
        const room = state.rooms.get(msg.roomId);
        const roomName = room ? room.name : msg.roomId;
        const storageKey = 'wprc_hist_' + roomName;
        
        try {
            let history = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
            history.push(msg);
            
            if (history.length > 100) history = history.slice(-100);
            
            sessionStorage.setItem(storageKey, JSON.stringify(history));
            console.log(`🟢 [저장완료] ${roomName} 방 (${history.length}개)`);
        } catch (e) { console.error('🔴 저장 에러:', e); }
    }

    function loadMessagesFromLocal(room) {
        if (!room || !room.name) return;
        
        const storageKey = 'wprc_hist_' + room.name;
        
        try {
            let history = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
            console.log(`🔵 [불러오기] ${room.name} 방 (${history.length}개 복구)`);
            
            history.forEach(msg => appendMessage(msg));
        } catch (e) { console.error('🔴 불러오기 에러:', e); }
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