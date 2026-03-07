/**
 * WP Realtime Secure Chat - 모바일 전용 클라이언트
 * .wprc-is-mobile 컨테이너 감지 시에만 동작
 * chat-client-v2.js 와 병렬 로드 가능 (PC/모바일 자동 분기)
 * @version 2026-03-07-v5
 */

// 전역 초기화 함수 — float.js가 rootEl 삽입 후 직접 호출
// 숏코드 페이지에서는 DOMContentLoaded 시 자동 호출
function WPRC_InitMobileChat(rootEl) {

(function (mobileRoot) {
    'use strict';

    if (!mobileRoot) return;

    // ============================================================
    // 1. 설정 & 상태 관리
    // ============================================================
    const config = window.WPRC_Config || {};

    // ── localStorage 영속 키 (탭 유지 중 새로고침해도 복원) ──
    const LS_KEY        = 'wprc_mob_persist_' + (config.userId || 'guest');
    const SS_ROOMS_KEY  = 'wprc_mob_rooms_'   + (config.userId || 'guest');

    // ── sessionStorage 방 목록 (탭 살아있는 동안만 유지, 창 닫으면 자동 삭제) ──
    function _ssRoomsSave(roomsMap) {
        try {
            const arr = Array.from(roomsMap.values());
            sessionStorage.setItem(SS_ROOMS_KEY, JSON.stringify(arr));
        } catch { /* 무시 */ }
    }
    function _ssRoomsLoad() {
        try {
            const arr = JSON.parse(sessionStorage.getItem(SS_ROOMS_KEY) || '[]');
            const map = new Map();
            arr.forEach((r) => map.set(r.id, r));
            return map;
        } catch { return new Map(); }
    }

    function _lsLoad() {
        try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
    }
    function _lsSave(patch) {
        try {
            const cur = _lsLoad();
            localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...patch }));
        } catch { /* 무시 */ }
    }
    function _lsClear() {
        try { localStorage.removeItem(LS_KEY); } catch { /* 무시 */ }
    }

    // ── 다른 유저 상태 메시지 캐시 (별도 키, 유저 ID → statusMessage) ──
    const LS_STATUS_KEY = 'wprc_mob_user_status';
    function _statusCacheLoad() {
        try { return JSON.parse(localStorage.getItem(LS_STATUS_KEY) || '{}'); } catch { return {}; }
    }
    function _statusCacheSave(userId, statusMessage) {
        try {
            const cache = _statusCacheLoad();
            if (statusMessage) {
                cache[userId] = statusMessage;
            } else {
                delete cache[userId]; // 빈 문자열이면 캐시에서도 삭제
            }
            localStorage.setItem(LS_STATUS_KEY, JSON.stringify(cache));
        } catch { /* 무시 */ }
    }
    function _statusCacheGet(userId) {
        return _statusCacheLoad()[userId] || '';
    }

    const _persisted = _lsLoad(); // 새로고침 전 저장된 데이터
    const _guestAuth = JSON.parse(sessionStorage.getItem('wprc_mob_guest') || '{}');

    const state = {
        token:         config.token || _guestAuth.token || '',
        userId:        config.userId || _guestAuth.userId || '',
        displayName:   config.displayName || _guestAuth.displayName || '',
        statusMessage: _persisted.statusMessage || '',   // ← localStorage 복원
        isGuest:       !config.isLoggedIn,
        currentRoom:   null,
        lastRoomId:    _persisted.lastRoomId || null,    // ← localStorage 복원
        rooms:         _ssRoomsLoad(),   // ← sessionStorage 복원 (창 닫으면 자동 삭제)
        onlineUsers:   new Map(),
        soundEnabled:  true,
        typingTimer:   null,
        socket:        null,
    };

    // ============================================================
    // 2. DOM 캐싱 (모바일 전용 ID/클래스)
    // ============================================================
    const $m  = (sel) => mobileRoot.querySelector(sel);
    const $$m = (sel) => mobileRoot.querySelectorAll(sel);

    const dom = {
        // 헤더
        title:          $m('#wprc-mobile-title'),
        actionBtn:      $m('#wprc-mobile-action'),

        // 메인 컨텐츠 & 탭
        main:           $m('#wprc-mobile-main'),
        navItems:       $$m('.wprc-nav-item'),
        tabFriends:     $m('#wprc-mob-tab-friends'),
        tabRooms:       $m('#wprc-mob-tab-rooms'),
        tabSettings:    $m('#wprc-mob-tab-settings'),

        // 리스트
        userListMob:    $m('#wprc-user-list-mob'),
        roomListMob:    $m('#wprc-room-list-mob'),
        onlineCountMob: $m('#wprc-online-count-mob'),

        // 채팅 오버레이
        chatView:       $m('#wprc-mobile-chat-view'),
        backBtn:        $m('#wprc-mobile-back'),
        chatName:       $m('#wprc-mobile-chat-name'),
        infoBtn:        $m('#wprc-mobile-info'),

        // 메시지
        messages:       $m('#wprc-messages-mob'),
        msgInput:       $m('#wprc-message-input-mob'),
        sendBtn:        $m('#wprc-send-btn-mob'),
        typingEl:       null, // 동적 생성
    };

    // ============================================================
    // 3. 초기화
    // ============================================================
    // ── 실제 모바일 뷰포트 높이 측정 → CSS 변수 주입 ──
    // 100vh는 주소창/하단바 포함 높이라 실제 보이는 영역보다 큼
    // visualViewport API 또는 window.innerHeight로 정확한 값을 --wprc-vh에 주입
    function _setViewportHeight() {
        const h = (window.visualViewport?.height || window.innerHeight) + 'px';
        document.documentElement.style.setProperty('--wprc-vh', h);
    }
    _setViewportHeight();
    // 주소창 숨김/표시, 화면 회전 시 재측정
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', _setViewportHeight);
    } else {
        window.addEventListener('resize', _setViewportHeight);
    }

    function init() {
        // ── 타이핑 인디케이터 동적 생성 ──
        const typingDiv = document.createElement('div');
        typingDiv.id = 'wprc-typing-mob';
        typingDiv.style.cssText = 'font-size:12px; color:#8b5cf6; padding:0 15px 4px; min-height:16px;';
        const inputArea = $m('.wprc-mobile-input-area');
        if (inputArea) inputArea.insertBefore(typingDiv, inputArea.firstChild);
        dom.typingEl = typingDiv;

        // ── localStorage 복원값 즉시 UI에 반영 (소켓 연결 전) ──
        if (state.statusMessage) {
            _updateMyProfileStatus(state.statusMessage);
            _updateStatusPreview(state.statusMessage);
            const statusInput = $m('#wprc-setting-status-mob');
            if (statusInput) statusInput.value = state.statusMessage;
        }

        // ── UI 탭/헤더 초기화 ──
        _initTabUI();
        _bindTabNavEvents();

        // 🚀 [추가된 부분] 이전 페이지에서 보던 채팅방이 세션에 남아있다면 소켓 연결 전이라도 즉시 화면에 띄움
        if (state.lastRoomId && state.rooms.has(state.lastRoomId)) {
            const roomToRestore = state.rooms.get(state.lastRoomId);
            switchTab('rooms');
            activateChatOverlay(roomToRestore);
        }

        if (state.isGuest && !state.token) {
            _showGuestOverlay();
            return;
        }

        if (state.token) connectSocket();
    }

    /** 탭 초기 상태를 JS로 강제 세팅 (CSS 캐시 문제 방어) */
    function _initTabUI() {
        // 탭 헤더: 친구만 표시
        $$m('.wprc-mob-tab-header').forEach((el) => {
            el.style.display = 'none';
        });
        const firstHeader = $m('#wprc-mob-header-friends');
        if (firstHeader) firstHeader.style.display = 'flex';

        // 탭 콘텐츠: 친구만 표시
        $$m('.wprc-mobile-tab-content').forEach((el) => {
            el.style.display = 'none';
        });
        const firstTab = $m('#wprc-mob-tab-friends');
        if (firstTab) firstTab.style.display = 'block';

        // 내비 active 초기화
        $$m('.wprc-nav-item').forEach((btn) => btn.classList.remove('active'));
        const firstNav = mobileRoot.querySelector('.wprc-nav-item[data-tab="friends"]');
        if (firstNav) firstNav.classList.add('active');
    }

    /** 탭 내비게이션 이벤트 — 소켓 연결 전부터 동작해야 함 */
    function _bindTabNavEvents() {
        dom.navItems.forEach((btn) => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        // 채팅탭 "+ 새 채팅방" 버튼
        $m('#wprc-mobile-action')?.addEventListener('click', _showCreateRoomModal);
    }

    // ============================================================
    // 3-1. 게스트 오버레이 (모바일 전용 간이 닉네임 입력)
    // ============================================================
    function _showGuestOverlay() {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position:fixed; inset:0; background:#f3e8ff;
            display:flex; align-items:center; justify-content:center;
            z-index:200000; flex-direction:column; gap:16px; padding:30px;
        `;
        overlay.innerHTML = `
            <h2 style="margin:0;font-size:22px;color:#1a1a2e;">채팅 참여</h2>
            <p style="margin:0;color:#64748b;">닉네임을 입력하고 채팅에 참여하세요.</p>
            <input id="wprc-mob-guest-input" type="text" maxlength="20" placeholder="닉네임"
                style="width:100%;max-width:280px;padding:12px 18px;border:1px solid #e2e8f0;
                       border-radius:22px;font-size:16px;outline:none;background:#fff;">
            <button id="wprc-mob-guest-join"
                style="width:100%;max-width:280px;padding:14px;background:#8b5cf6;color:#fff;
                       border:none;border-radius:14px;font-size:16px;font-weight:700;cursor:pointer;">
                참여하기
            </button>
        `;
        mobileRoot.appendChild(overlay);

        const input = overlay.querySelector('#wprc-mob-guest-input');
        const btn   = overlay.querySelector('#wprc-mob-guest-join');

        async function doJoin() {
            const nickname = input.value.trim();
            if (!nickname) { input.focus(); return; }

            btn.disabled   = true;
            btn.textContent = '접속 중...';

            try {
                const resp = await fetch(config.restUrl + 'guest-token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': config.nonce },
                    body: JSON.stringify({ nickname }),
                });
                const data = await resp.json();

                if (!data.success) {
                    alert(data.message || '접속에 실패했습니다.');
                    btn.disabled    = false;
                    btn.textContent = '참여하기';
                    return;
                }

                state.token       = data.token;
                state.displayName = nickname;

                // 게스트 토큰을 세션에 저장하여 페이지 이동 시에도 유지
                sessionStorage.setItem('wprc_mob_guest', JSON.stringify({
                    token: data.token,
                    displayName: nickname
                }));

                overlay.remove();
                connectSocket();

            } catch (err) {
                console.error('[WPRC Mobile] Guest join error:', err);
                alert('서버 연결에 실패했습니다.');
                btn.disabled    = false;
                btn.textContent = '참여하기';
            }
        }

        btn.addEventListener('click', doJoin);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
        input.focus();
    }

    // ============================================================
    // 4. Socket.io 연결
    // ============================================================
    function connectSocket() {
        if (!config.nodeServerUrl || !state.token) return;

        state.socket = io(config.nodeServerUrl, {
            auth:                { token: state.token },
            transports:          ['websocket', 'polling'],
            reconnectionAttempts: 5,
            reconnectionDelay:    2000,
        });

        const socket = state.socket;

        socket.on('connect', () => {
            console.log('[WPRC Mobile] Connected:', socket.id);
            bindUIEvents();
        });

        socket.on('auth:success', (userData) => {
            state.userId        = userData.userId;
            state.displayName   = userData.displayName;
            state.isGuest       = userData.isGuest;

            // 🚀 [추가된 부분] 게스트인 경우 서버가 발급한 userId까지 세션에 완벽히 저장
            if (state.isGuest) {
                const guestData = JSON.parse(sessionStorage.getItem('wprc_mob_guest') || '{}');
                guestData.userId = userData.userId;
                sessionStorage.setItem('wprc_mob_guest', JSON.stringify(guestData));
            }

            // 서버에서 statusMessage를 내려주면 우선 사용, 없으면 localStorage 복원값 사용
            state.statusMessage = userData.statusMessage || state.statusMessage;

            // 상태 메시지가 있으면 서버에 복원 emit
            if (state.statusMessage) {
                socket.emit('user:set-status', { statusMessage: state.statusMessage });
            }

            // 설정창 입력 초기값 세팅
            const statusInput = $m('#wprc-setting-status-mob');
            if (statusInput && !statusInput.value) statusInput.value = state.statusMessage;
            _updateMyProfileStatus(state.statusMessage);
            _updateStatusPreview(state.statusMessage);
        });

        // 다른 유저의 상태 메시지 변경 수신
        socket.on('user:status-changed', (data) => {
            // data: { userId, statusMessage }
            // 1) localStorage 캐시에 저장 → 새로고침 후에도 복원 가능
            _statusCacheSave(data.userId, data.statusMessage);

            // 2) 현재 메모리의 onlineUsers 즉시 업데이트
            const user = state.onlineUsers.get(data.userId);
            if (user) {
                user.statusMessage = data.statusMessage;
                renderUserList();
            }
        });

        socket.on('auth:error', (msg) => {
            console.error('[WPRC Mobile] Auth error:', msg);
            alert('인증에 실패했습니다: ' + msg);
            socket.disconnect();
        });

        // ── 접속자 목록 ──
        socket.on('users:list', (users) => {
            state.onlineUsers.clear();
            users.forEach((u) => {
                const cached = _statusCacheGet(u.userId);
                const statusMessage = u.statusMessage || cached;
                if (u.statusMessage) _statusCacheSave(u.userId, u.statusMessage);
                state.onlineUsers.set(u.userId, { ...u, statusMessage });
            });
            renderUserList();

            // 서버가 users:list에 statusMessage를 포함하지 않는 경우를 대비해
            // 현재 온라인 유저 전체의 최신 상태 메시지를 별도 요청
            socket.emit('users:request-statuses');
        });

        // 서버가 users:request-statuses 응답으로 { userId: statusMessage, ... } 맵을 내려줌
        socket.on('users:statuses', (statusMap) => {
            // statusMap = { "userId1": "상태메시지", "userId2": "..." }
            let changed = false;
            Object.entries(statusMap).forEach(([userId, statusMessage]) => {
                if (!statusMessage) return;
                _statusCacheSave(userId, statusMessage); // 캐시 갱신
                const user = state.onlineUsers.get(userId);
                if (user && user.statusMessage !== statusMessage) {
                    user.statusMessage = statusMessage;
                    changed = true;
                }
            });
            if (changed) renderUserList();
        });

        socket.on('user:joined', (user) => {
            const cached = _statusCacheGet(user.userId);
            const statusMessage = user.statusMessage || cached;
            if (user.statusMessage) _statusCacheSave(user.userId, user.statusMessage);
            state.onlineUsers.set(user.userId, { ...user, statusMessage });
            renderUserList();
        });

        socket.on('user:left', (userId) => {
            state.onlineUsers.delete(userId);
            renderUserList();
        });

        // ── 채팅방 목록 ──
        socket.on('rooms:list', (rooms) => {
            if (rooms.length > 0) {
                // 서버에 방이 있으면 서버 데이터가 정답 → 그대로 반영
                state.rooms.clear();
                rooms.forEach((r) => state.rooms.set(r.id, r));
                _ssRoomsSave(state.rooms);
            } else if (state.rooms.size > 0) {
                // 서버는 비어있지만 캐시에 방이 있음
                // → 페이지 이동 후 재접속으로 소켓이 바뀐 경우
                // → 캐시 방들을 서버에 재생성 요청
                state.rooms.forEach((room) => {
                    socket.emit('room:create', { name: room.name, type: room.type || 'group' });
                });
                // rooms:list 응답이 다시 올 때까지 현재 캐시 유지 (덮어쓰지 않음)
                return;
            }
            renderRoomList();

            // 새로고침/재접속 후 마지막 방 자동 재입장
            if (state.lastRoomId && state.rooms.has(state.lastRoomId)) {
                socket.emit('room:join', { roomId: state.lastRoomId });
            }
        });

        socket.on('room:created', (room) => {
            state.rooms.set(room.id, room);
            _ssRoomsSave(state.rooms);
            renderRoomList();
        });

        socket.on('room:updated', (room) => {
            state.rooms.set(room.id, room);
            _ssRoomsSave(state.rooms);
            renderRoomList();
            if (state.currentRoom === room.id) {
                if (dom.chatName) dom.chatName.textContent = room.name;
            }
        });

        socket.on('room:deleted', (roomId) => {
            // 히스토리 삭제 (rooms에서 제거 전에 이름 조회)
            const deletedRoom = state.rooms.get(roomId);
            sessionStorage.removeItem('wprc_hist_' + roomId);

            state.rooms.delete(roomId);
            _ssRoomsSave(state.rooms);
            renderRoomList();
            if (state.currentRoom === roomId) {
                // 서버에서 삭제 완료 통보 → UI만 정리 (emit 불필요)
                state.currentRoom = null;
                state.lastRoomId  = null;
                _lsSave({ lastRoomId: null });
                if (dom.messages) dom.messages.innerHTML = '';
                closeChatOverlay();
            }
        });

        // ── 메시지 ──
        socket.on('message:receive', (msg) => {
            const IMG_PREFIX = '__IMG__';

            // !msg.type 조건 제거 — 서버가 type:'text' 등을 함께 보내도 항상 파싱
            if (typeof msg.text === 'string' && msg.text.startsWith(IMG_PREFIX)) {
                msg = { ...msg, type: 'image', imageUrl: msg.text.slice(IMG_PREFIX.length) };
            }

            // 본인이 보낸 이미지는 낙관적 렌더로 이미 표시됨 → 에코 skip
            if (msg.type === 'image' && String(msg.userId) === String(state.userId)) {
                return;
            }

            appendMessage(msg);
            saveMessageToLocal(msg);
            if (state.soundEnabled && msg.userId !== state.userId) playNotificationSound();
        });

        socket.on('message:system', (text) => appendSystemMessage(text));

        // ── 타이핑 ──
        socket.on('typing:show', (data) => {
            if (data.userId !== state.userId && data.roomId === state.currentRoom) {
                if (dom.typingEl) dom.typingEl.textContent = `${data.displayName}님이 입력 중...`;
            }
        });

        socket.on('typing:hide', (data) => {
            if (data.userId !== state.userId) {
                if (dom.typingEl) dom.typingEl.textContent = '';
            }
        });

        // ── 방 입장 완료 ──
        socket.on('room:joined', (room) => {
            state.currentRoom = room.id;
            state.lastRoomId  = room.id;
            state.rooms.set(room.id, room);
            _lsSave({ lastRoomId: room.id }); // 새로고침 복원용 저장

            if (Array.isArray(room.messages) && room.messages.length > 0) {
                if (dom.messages) dom.messages.innerHTML = '';
                room.messages.forEach((msg) => {
                    appendMessage(msg);
                    saveMessageToLocal(msg);
                });
                activateChatOverlay({ ...room, _skipLoad: true });
            } else {
                activateChatOverlay(room);
            }
        });

        // 서버가 message:history 이벤트를 별도로 보내는 경우 처리
        socket.on('message:history', (msgs) => {
            if (!Array.isArray(msgs) || !dom.messages) return;
            dom.messages.innerHTML = '';
            msgs.forEach((msg) => {
                appendMessage(msg);
                saveMessageToLocal(msg);
            });
            dom.messages.scrollTop = dom.messages.scrollHeight;
        });

        socket.on('disconnect', (reason) => console.log('[WPRC Mobile] Disconnected:', reason));
        socket.on('connect_error', (err) => console.error('[WPRC Mobile] Connection error:', err.message));
    }

    // ============================================================
    // 5. UI 렌더링
    // ============================================================

    /** 하단 탭 전환 — 인라인 style 직접 제어로 CSS 캐시 문제 완전 방어 */
    function switchTab(tabName) {
        // 탭 콘텐츠
        $$m('.wprc-mobile-tab-content').forEach((el) => { el.style.display = 'none'; });
        const targetTab = $m(`#wprc-mob-tab-${tabName}`);
        if (targetTab) targetTab.style.display = 'block';

        // 탭별 헤더
        $$m('.wprc-mob-tab-header').forEach((el) => { el.style.display = 'none'; });
        const targetHeader = $m(`#wprc-mob-header-${tabName}`);
        if (targetHeader) targetHeader.style.display = 'flex';

        // 내비 active
        dom.navItems.forEach((btn) => btn.classList.remove('active'));
        mobileRoot.querySelector(`.wprc-nav-item[data-tab="${tabName}"]`)?.classList.add('active');
    }

    /** 채팅방 목록 렌더링 */
    function renderRoomList() {
        if (!dom.roomListMob) return;
        dom.roomListMob.innerHTML = '';

        if (state.rooms.size === 0) {
            const li = document.createElement('li');
            li.style.cssText = 'color:#94a3b8;font-size:13px;padding:20px;text-align:center;list-style:none;';
            li.textContent = '채팅방이 없습니다. 새 채팅방 버튼으로 만들어보세요!';
            dom.roomListMob.appendChild(li);
            return;
        }

        state.rooms.forEach((room, roomId) => {
            const li = document.createElement('li');
            const initial    = room.name ? room.name.charAt(0) : '방';
            const isActive   = state.currentRoom === roomId;
            const lastMsg    = room.lastMessage || '메시지를 보냈습니다';

            li.style.cssText = 'cursor:pointer;';
            li.innerHTML = `
                <div style="width:48px;height:48px;border-radius:14px;
                            background:${isActive ? '#8b5cf6' : '#f1f5f9'};
                            color:${isActive ? '#fff' : '#64748b'};
                            display:flex;align-items:center;justify-content:center;
                            font-weight:700;font-size:18px;flex-shrink:0;">
                    ${escapeHtml(initial)}
                </div>
                <div style="flex:1;min-width:0;">
                    <div class="wprc-mob-item-name">${escapeHtml(room.name)}</div>
                    <div class="wprc-mob-item-sub">${escapeHtml(lastMsg)}</div>
                </div>
            `;

            li.addEventListener('click', () => joinRoom(roomId));
            dom.roomListMob.appendChild(li);
        });
    }

    /** 접속자 목록 렌더링 */
    function renderUserList() {
        if (!dom.userListMob) return;
        dom.userListMob.innerHTML = '';

        if (dom.onlineCountMob) dom.onlineCountMob.textContent = state.onlineUsers.size;

        state.onlineUsers.forEach((user, userId) => {
            if (userId === state.userId) return;

            const li      = document.createElement('li');
            const initial = user.displayName ? user.displayName.charAt(0) : 'U';
            const statusMsg = user.statusMessage || '상태 메시지를 입력하세요';

            li.innerHTML = `
                <div style="width:48px;height:48px;border-radius:14px;background:#f1f5f9;
                            color:#64748b;display:flex;align-items:center;justify-content:center;
                            font-weight:700;font-size:18px;flex-shrink:0;position:relative;">
                    ${escapeHtml(initial)}
                    <span style="position:absolute;bottom:2px;right:2px;width:10px;height:10px;
                                 background:#22c55e;border-radius:50%;border:2px solid #fff;"></span>
                </div>
                <div style="flex:1;min-width:0;">
                    <div class="wprc-mob-item-name">
                        ${escapeHtml(user.displayName)}
                        ${user.isGuest ? '<small style="color:#94a3b8;font-weight:400;"> (게스트)</small>' : ''}
                    </div>
                    <div class="wprc-mob-item-sub">${escapeHtml(statusMsg)}</div>
                </div>
                <button class="wprc-mob-dm-btn"
                    style="padding:6px 14px;background:#8b5cf6;color:#fff;border:none;
                           border-radius:12px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;">
                    DM
                </button>
            `;

            li.querySelector('.wprc-mob-dm-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                startDirectMessage(userId, user.displayName);
            });

            dom.userListMob.appendChild(li);
        });
    }

    /** 채팅 오버레이 열기 */
    function activateChatOverlay(room) {
        if (dom.chatName)  dom.chatName.textContent = room.name;
        if (dom.typingEl)  dom.typingEl.textContent  = '';

        // 서버 히스토리로 이미 채워진 경우 로컬 로드 건너뜀
        if (!room._skipLoad) {
            if (dom.messages) dom.messages.innerHTML = '';
            loadMessagesFromLocal(room);
        }

        if (dom.chatView)  dom.chatView.classList.add('active');
        setTimeout(() => dom.msgInput?.focus(), 300);
    }

    /**
     * 채팅 오버레이 닫기 — 방은 유지, 화면만 뒤로 이동
     * 뒤로가기 버튼 / 스와이프에서 호출
     */
    function closeChatOverlay() {
        if (dom.chatView) dom.chatView.classList.remove('active');
        // ❌ room:leave 를 emit하지 않음 → 방 멤버십 유지
        // currentRoom 도 유지 → 재진입 시 히스토리 그대로
    }

    /**
     * 실제 채팅방 퇴장 — 드로어 "채팅 나가기" 버튼에서만 호출
     */
    function leaveRoom() {
        if (state.currentRoom && state.socket) {
            // 삭제 전 메시지 히스토리 키 미리 수집 (room:deleted 수신 전에 rooms에서 사라질 수 있으므로)
            const room = state.rooms.get(state.currentRoom);
            if (room) {
                sessionStorage.removeItem('wprc_hist_' + state.currentRoom);
            }
            state.socket.emit('room:delete', { roomId: state.currentRoom });
        }
        state.currentRoom = null;
        state.lastRoomId  = null;
        _lsSave({ lastRoomId: null });
        _ssRoomsSave(state.rooms);
        if (dom.messages) dom.messages.innerHTML = '';
        closeChatOverlay();
        renderRoomList();
    }

    /** 메시지 말풍선 추가 */
    function appendMessage(msg) {
        if (!dom.messages) return;

        // __IMG__ 접두사 파싱 — type/imageUrl 유무와 무관하게 항상 실행
        const IMG_PREFIX = '__IMG__';
        if (typeof msg.text === 'string' && msg.text.startsWith(IMG_PREFIX)) {
            msg = { ...msg, type: 'image', imageUrl: msg.text.slice(IMG_PREFIX.length) };
        }

        // imageUrl은 있는데 type이 누락된 경우 보정
        if (msg.imageUrl && msg.type !== 'image') {
            msg = { ...msg, type: 'image' };
        }

        const isMine  = String(msg.userId) === String(state.userId);
        const now     = new Date();
        const time    = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: true });

        // ── 날짜 구분선: 오늘 날짜와 다르거나, 이전 메시지 날짜와 다를 때 삽입 ──
        const dateKey = now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
        const lastSep = dom.messages.dataset.lastDate;
        if (lastSep !== dateKey) {
            const sep = document.createElement('div');
            sep.className = 'wprc-mob-date-separator';
            sep.innerHTML = `<span>${dateKey}</span>`;
            dom.messages.appendChild(sep);
            dom.messages.dataset.lastDate = dateKey;
        }

        const initial = msg.displayName ? msg.displayName.charAt(0) : 'U';

        const div = document.createElement('div');
        div.className = `wprc-msg ${isMine ? 'wprc-msg-mine' : ''}`;

        // 말풍선 콘텐츠: 이미지 타입이면 빈 img 태그 자리 확보, 아니면 텍스트
        const isImage = msg.type === 'image' && msg.imageUrl;
        const bubbleContent = isImage
            ? `<img class="wprc-chat-img" alt="이미지" loading="lazy">`
            : escapeHtml(msg.text);

        div.innerHTML = `
            ${!isMine ? `
                <div class="wprc-msg-avatar"
                    style="background:#e5e7eb;color:#4b5563;display:flex;align-items:center;
                           justify-content:center;font-size:13px;font-weight:700;
                           width:40px;height:40px;border-radius:50%;flex-shrink:0;">
                    ${escapeHtml(initial)}
                </div>
            ` : ''}
            <div class="wprc-msg-body"
                style="display:flex;flex-direction:column;${isMine ? 'align-items:flex-end;' : 'align-items:flex-start;'}">
                ${!isMine ? `
                    <span style="font-size:11px;margin-left:8px;margin-bottom:2px;color:#64748b;">
                        ${escapeHtml(msg.displayName)}
                    </span>
                ` : ''}
                <div style="display:flex;${isMine ? 'flex-direction:row-reverse;' : 'flex-direction:row;'}align-items:flex-end;gap:5px;">
                    <div class="wprc-msg-bubble">${bubbleContent}</div>
                    <span style="font-size:10px;color:#94a3b8;margin-bottom:2px;white-space:nowrap;">${time}</span>
                </div>
            </div>
        `;

        dom.messages.appendChild(div);

        // img src를 DOM API로 직접 세팅 (escapeHtml이 URL 특수문자 깨뜨리는 것 방지)
        if (isImage) {
            const imgEl = div.querySelector('.wprc-chat-img');
            if (imgEl) {
                imgEl.src = msg.imageUrl;
                imgEl.addEventListener('click', () => _showLightbox(msg.imageUrl));
            }
        }

        dom.messages.scrollTop = dom.messages.scrollHeight;
    }
    function appendSystemMessage(text) {
        if (!dom.messages) return;

        const div = document.createElement('div');
        div.style.cssText = 'text-align:center;font-size:12px;color:#94a3b8;padding:4px 0;';
        div.textContent   = text;

        dom.messages.appendChild(div);
        dom.messages.scrollTop = dom.messages.scrollHeight;
    }

    // ============================================================
    // 6. 소켓 이벤트 발송
    // ============================================================
    function sendMessage() {
        // 이미지가 선택된 상태면 이미지 먼저 전송
        const fileInput = $m('#wprc-mob-file-input');
        if (fileInput?.files?.length > 0) {
            _uploadAndSend(fileInput.files[0]);
            return;
        }

        const text = dom.msgInput?.value?.trim();
        if (!text || !state.currentRoom || !state.socket) return;

        state.socket.emit('message:send', { roomId: state.currentRoom, text });
        dom.msgInput.value = '';
        dom.msgInput.focus();
        state.socket.emit('typing:stop', { roomId: state.currentRoom });
    }

    function joinRoom(roomId) {
        if (!state.socket) return;
        if (state.currentRoom === roomId) {
            // 이미 입장한 방이면 그냥 오버레이만 열기
            const room = state.rooms.get(roomId);
            if (room) activateChatOverlay(room);
            return;
        }

        if (state.currentRoom) {
            state.socket.emit('room:leave', { roomId: state.currentRoom });
        }
        state.socket.emit('room:join', { roomId });
    }

    function startDirectMessage(targetUserId, targetName) {
        if (!state.socket) return;
        state.socket.emit('room:create-dm', { targetUserId, targetName });
        // room:created 또는 room:joined 이벤트로 자동으로 오버레이가 열립니다
    }

    function createRoom(name, type) {
        if (!state.socket) return;
        state.socket.emit('room:create', { name, type });
    }

    // ============================================================
    // 7. UI 이벤트 바인딩 (소켓 연결 후 추가 바인딩)
    // ============================================================
    function bindUIEvents() {
        // 탭 내비는 _bindTabNavEvents()에서 이미 처리됨

        // ── 뒤로가기 ──
        dom.backBtn?.addEventListener('click', closeChatOverlay);

        // ── 파일 첨부 버튼 → hidden input 클릭 ──
        $m('#wprc-mob-attach-btn')?.addEventListener('click', () => {
            $m('#wprc-mob-file-input')?.click();
        });

        // ── 파일 선택 → 미리보기 ──
        $m('#wprc-mob-file-input')?.addEventListener('change', _handleFileSelect);

        // ── 미리보기 취소 버튼 ──
        $m('#wprc-mob-img-cancel')?.addEventListener('click', _clearFileSelection);

        // ── 전송 ──
        dom.sendBtn?.addEventListener('click', sendMessage);
        dom.msgInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });

        // ── 타이핑 감지 ──
        dom.msgInput?.addEventListener('input', () => {
            if (!state.socket || !state.currentRoom) return;
            state.socket.emit('typing:start', { roomId: state.currentRoom });
            clearTimeout(state.typingTimer);
            state.typingTimer = setTimeout(() => {
                state.socket.emit('typing:stop', { roomId: state.currentRoom });
            }, 1500);
        });

        // ── 정보 드로어 ──
        dom.infoBtn?.addEventListener('click', _showRoomInfoDrawer);

        // ── 설정: 닉네임 저장 ──
        $m('#wprc-save-nickname-mob')?.addEventListener('click', () => {
            const newName = $m('#wprc-setting-nickname-mob')?.value?.trim();
            if (!newName || !state.socket) return;
            state.socket.emit('user:change-name', { displayName: newName });
            state.displayName = newName;
            _showToast('닉네임이 변경되었습니다');
        });

        // ── 설정: 상태 메시지 저장 ──
        $m('#wprc-save-status-mob')?.addEventListener('click', _saveStatusMessage);
        $m('#wprc-setting-status-mob')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); _saveStatusMessage(); }
        });

        // ── 설정: 알림음 토글 ──
        $m('#wprc-setting-sound-mob')?.addEventListener('change', (e) => {
            state.soundEnabled = e.target.checked;
        });

        // ── 스와이프로 오버레이 닫기 ──
        _bindSwipeClose();

        // ── iOS 키보드 올라올 때 스크롤 보정 ──
        dom.msgInput?.addEventListener('focus', () => {
            setTimeout(() => {
                if (dom.messages) dom.messages.scrollTop = dom.messages.scrollHeight;
            }, 300);
        });
    }

    // ============================================================
    // 7-1. 채팅방 생성 모달 (모바일 바텀시트)
    // ============================================================
    function _showCreateRoomModal() {
        const sheet = document.createElement('div');
        sheet.style.cssText = `
            position:fixed; inset:0; z-index:300000;
            background:rgba(0,0,0,0.4);
            display:flex; align-items:flex-end; justify-content:center;
        `;
        sheet.innerHTML = `
            <div style="width:100%;max-width:480px;background:#fff;border-radius:20px 20px 0 0;
                        padding:24px 20px 40px;animation:slideUp 0.3s ease;">
                <div style="width:40px;height:4px;background:#e5e7eb;border-radius:2px;margin:0 auto 20px;"></div>
                <h3 style="margin:0 0 20px;font-size:18px;">새 채팅방</h3>
                <input id="_mob-room-name" type="text" maxlength="50" placeholder="채팅방 이름"
                    style="width:100%;padding:12px 16px;border:1px solid #e2e8f0;border-radius:12px;
                           font-size:15px;outline:none;box-sizing:border-box;margin-bottom:12px;">
                <select id="_mob-room-type"
                    style="width:100%;padding:12px 16px;border:1px solid #e2e8f0;border-radius:12px;
                           font-size:15px;outline:none;box-sizing:border-box;margin-bottom:20px;">
                    <option value="public">공개 채팅방</option>
                    <option value="private">비공개 채팅방</option>
                </select>
                <button id="_mob-room-confirm"
                    style="width:100%;padding:14px;background:#8b5cf6;color:#fff;
                           border:none;border-radius:14px;font-size:16px;font-weight:700;cursor:pointer;">
                    만들기
                </button>
            </div>
            <style>@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}</style>
        `;

        mobileRoot.appendChild(sheet);

        const nameInput = sheet.querySelector('#_mob-room-name');
        const typeSelect = sheet.querySelector('#_mob-room-type');
        const confirmBtn = sheet.querySelector('#_mob-room-confirm');

        nameInput.focus();

        confirmBtn.addEventListener('click', () => {
            const name = nameInput.value.trim();
            const type = typeSelect.value;
            if (!name) { nameInput.focus(); return; }
            createRoom(name, type);
            sheet.remove();
        });

        sheet.addEventListener('click', (e) => {
            if (e.target === sheet) sheet.remove();
        });
    }

    // ============================================================
    // 7-2. 방 정보 드로어 (i 버튼)
    // ============================================================
    function _showRoomInfoDrawer() {
        if (!state.currentRoom) return;
        const room = state.rooms.get(state.currentRoom);
        if (!room) return;

        const existing = mobileRoot.querySelector('#_mob-info-drawer');
        if (existing) { existing.remove(); return; }

        const drawer = document.createElement('div');
        drawer.id = '_mob-info-drawer';
        const users = room.users || [];

        drawer.style.cssText = `
            position:fixed; top:60px; right:0; bottom:0; width:260px;
            background:#fff; z-index:200001;
            box-shadow:-4px 0 20px rgba(0,0,0,0.1);
            padding:20px; overflow-y:auto;
            animation:slideInRight 0.25s ease;
        `;
        drawer.innerHTML = `
            <style>@keyframes slideInRight{from{transform:translateX(100%)}to{transform:translateX(0)}}</style>
            <h3 style="margin:0 0 16px;font-size:16px;color:#1f2937;">${escapeHtml(room.name)}</h3>
            <p style="font-size:12px;color:#94a3b8;margin:0 0 12px;">참여자 ${users.length}명</p>
            <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;">
                ${users.map(u => `
                    <li style="display:flex;align-items:center;gap:10px;">
                        <div style="width:36px;height:36px;border-radius:50%;background:#e5e7eb;
                                    color:#4b5563;display:flex;align-items:center;justify-content:center;
                                    font-weight:700;flex-shrink:0;">
                            ${escapeHtml((u.displayName || 'U').charAt(0))}
                        </div>
                        <span style="font-size:14px;color:#1f2937;">${escapeHtml(u.displayName || '')}</span>
                    </li>
                `).join('')}
            </ul>
            <hr style="margin:20px 0;border:none;border-top:1px solid #f3f4f6;">
            <button id="_mob-leave-room"
                style="width:100%;padding:12px;background:none;border:1px solid #fca5a5;
                       color:#dc2626;border-radius:12px;font-size:14px;cursor:pointer;">
                채팅 나가기
            </button>
        `;

        mobileRoot.appendChild(drawer);

        drawer.querySelector('#_mob-leave-room')?.addEventListener('click', () => {
            const roomName = state.rooms.get(state.currentRoom)?.name || '이 채팅방';
            if (!confirm(`"${roomName}"을(를) 삭제하시겠습니까?\n\n채팅방과 모든 대화가 삭제됩니다.`)) return;
            drawer.remove();
            leaveRoom();
        });
    }

    // ============================================================
    // 7-3. 스와이프 제스처 (오른쪽 스와이프 → 오버레이 닫기)
    // ============================================================
    function _bindSwipeClose() {
        if (!dom.chatView) return;

        let startX = 0;
        let startY = 0;

        dom.chatView.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }, { passive: true });

        dom.chatView.addEventListener('touchend', (e) => {
            const dx = e.changedTouches[0].clientX - startX;
            const dy = Math.abs(e.changedTouches[0].clientY - startY);

            // 오른쪽으로 80px 이상, 수직 이동이 작을 때 → 닫기
            if (dx > 80 && dy < 60) {
                closeChatOverlay();
            }
        }, { passive: true });
    }

    // ============================================================
    // 8. 상태 메시지 & 유틸리티
    // ============================================================

    /** 상태 메시지 저장 — localStorage + 소켓 emit + 프로필 카드 즉시 반영 */
    function _saveStatusMessage() {
        const input = $m('#wprc-setting-status-mob');
        const newStatus = input?.value?.trim() ?? '';

        // 로컬 상태 즉시 반영
        state.statusMessage = newStatus;

        // localStorage에 저장 (새로고침 복원용)
        _lsSave({ statusMessage: newStatus });

        // 내 프로필 카드 즉시 업데이트
        _updateMyProfileStatus(newStatus);

        // 설정창 프리뷰 업데이트
        _updateStatusPreview(newStatus);

        // 소켓 전송 (서버 브로드캐스트 → 다른 사람 화면에도 반영)
        if (state.socket) {
            state.socket.emit('user:set-status', { statusMessage: newStatus });
        }

        _showToast(newStatus ? '상태 메시지가 저장되었습니다' : '상태 메시지가 삭제되었습니다');
    }

    /** 친구탭 내 프로필 카드의 상태 메시지 텍스트 업데이트 */
    function _updateMyProfileStatus(msg) {
        const el = $m('#wprc-mob-my-status-display');
        if (!el) return;
        if (msg) {
            el.textContent = msg;
            el.classList.add('has-status');
        } else {
            el.textContent = '상태 메시지를 입력하세요';
            el.classList.remove('has-status');
        }
    }

    /** 설정창 프리뷰 텍스트 업데이트 */
    function _updateStatusPreview(msg) {
        const preview = $m('#wprc-status-preview');
        if (!preview) return;
        preview.innerHTML = msg
            ? `현재: <em>${escapeHtml(msg)}</em>`
            : `현재: <em>없음</em>`;
    }

    /** 하단 토스트 알림 */
    function _showToast(message) {
        // 기존 토스트 제거
        mobileRoot.querySelector('.wprc-mob-toast')?.remove();

        const toast = document.createElement('div');
        toast.className = 'wprc-mob-toast';
        toast.textContent = message;
        mobileRoot.appendChild(toast);

        // 애니메이션
        requestAnimationFrame(() => {
            requestAnimationFrame(() => toast.classList.add('show'));
        });

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 250);
        }, 2000);
    }

    // ============================================================
    // 파일 첨부 & 이미지 업로드
    // ============================================================

    /** 파일 선택 → 미리보기 표시 */
    function _handleFileSelect(e) {
        const file = e.target.files?.[0];
        if (!file) return;

        // HEIC/HEIF 차단 (iOS 기본 포맷 — 서버 GD/Imagick 미지원으로 500 에러)
        const blockedTypes = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];
        if (blockedTypes.includes(file.type.toLowerCase())) {
            _showToast('HEIC 형식은 지원되지 않습니다. 카메라 설정에서 JPEG로 변경해 주세요.');
            e.target.value = '';
            return;
        }

        // 지원 포맷 검사
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowed.includes(file.type)) {
            _showToast('JPEG, PNG, GIF, WEBP 형식만 첨부할 수 있습니다');
            e.target.value = '';
            return;
        }

        // 20MB 초과는 압축 전에도 차단
        if (file.size > 20 * 1024 * 1024) {
            _showToast('20MB 이하 이미지만 첨부 가능합니다');
            e.target.value = '';
            return;
        }

        // 미리보기 렌더 (원본 파일로)
        const reader = new FileReader();
        reader.onload = (ev) => {
            const previewArea = $m('#wprc-mob-img-preview');
            const previewImg  = $m('#wprc-mob-img-preview-img');
            if (previewImg) previewImg.src = ev.target.result;
            if (previewArea) previewArea.style.display = 'block';
            $m('#wprc-mob-attach-btn')?.classList.add('has-file');
        };
        reader.readAsDataURL(file);
    }

    /** 파일 선택 초기화 */
    function _clearFileSelection() {
        const fileInput  = $m('#wprc-mob-file-input');
        const previewArea = $m('#wprc-mob-img-preview');
        const previewImg  = $m('#wprc-mob-img-preview-img');

        if (fileInput)   fileInput.value = '';
        if (previewImg)  previewImg.src  = '';
        if (previewArea) previewArea.style.display = 'none';
        $m('#wprc-mob-attach-btn')?.classList.remove('has-file');
    }

    /**
     * WordPress REST API로 이미지 업로드 후 소켓으로 URL 전송
     * 업로드 실패 시 base64 fallback (소규모 이미지)
     */
    /**
     * Canvas API로 이미지 압축
     * - 최대 1600px로 리사이징 (모바일 4000x3000 → 서버 메모리 사용량 1/6 수준)
     * - JPEG quality 0.85로 재인코딩
     * - 원본이 이미 작으면 그대로 반환
     */
    function _compressImage(file) {
        return new Promise((resolve) => {
            // GIF는 Canvas 변환 시 애니메이션 손실 → 원본 그대로
            if (file.type === 'image/gif') { resolve(file); return; }

            const MAX_PX   = 1600;  // 긴 쪽 최대 픽셀
            const QUALITY  = 0.85;
            const MAX_BYTES = 1.5 * 1024 * 1024; // 1.5MB 이하면 압축 스킵

            if (file.size <= MAX_BYTES) { resolve(file); return; }

            const img    = new Image();
            const objUrl = URL.createObjectURL(file);

            img.onload = () => {
                URL.revokeObjectURL(objUrl);

                let { width, height } = img;
                const ratio = Math.min(MAX_PX / width, MAX_PX / height, 1);
                width  = Math.round(width  * ratio);
                height = Math.round(height * ratio);

                const canvas  = document.createElement('canvas');
                canvas.width  = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);

                canvas.toBlob(
                    (blob) => {
                        if (!blob) { resolve(file); return; }
                        // 원본보다 커지면 원본 사용
                        resolve(blob.size < file.size
                            ? new File([blob], file.name, { type: 'image/jpeg' })
                            : file
                        );
                    },
                    'image/jpeg',
                    QUALITY
                );
            };

            img.onerror = () => { URL.revokeObjectURL(objUrl); resolve(file); };
            img.src = objUrl;
        });
    }

    async function _uploadAndSend(originalFile) {
        if (!state.currentRoom || !state.socket) return;

        // 업로드 중 오버레이
        const previewInner = $m('.wprc-mob-img-preview-inner');
        let loadingEl = null;
        if (previewInner) {
            loadingEl = document.createElement('div');
            loadingEl.className = 'wprc-mob-uploading';
            loadingEl.textContent = '압축 중...';
            previewInner.appendChild(loadingEl);
        }
        const attachBtn = $m('#wprc-mob-attach-btn');
        const sendBtn   = $m('#wprc-send-btn-mob');
        if (attachBtn) attachBtn.disabled = true;
        if (sendBtn)   sendBtn.disabled   = true;

        try {
            // ① Canvas로 클라이언트 사이드 압축 (모바일 고해상도 → 서버 메모리 절약)
            if (loadingEl) loadingEl.textContent = '압축 중...';
            const file = await _compressImage(originalFile);
            const savedMB = ((originalFile.size - file.size) / 1024 / 1024).toFixed(1);
            if (file !== originalFile) {
                console.log(`[WPRC] 이미지 압축: ${(originalFile.size/1024/1024).toFixed(1)}MB → ${(file.size/1024/1024).toFixed(1)}MB (${savedMB}MB 절약)`);
            }
            if (loadingEl) loadingEl.textContent = '업로드 중...';
            let imageUrl = '';

            // 플러그인 전용 업로드 엔드포인트 (JWT 인증)
            const baseEndpoint = (config.restUrl || '') + 'upload-image';
            const token = config.token;

            if (!token) {
                _showToast('이미지 전송은 로그인 후 이용 가능합니다');
                return;
            }

            // Apache가 Authorization 헤더를 PHP에 전달하지 않는 경우가 있어
            // 쿼리 파라미터로도 동시에 전송 (PHP에서 4가지 방법으로 수신 시도)
            const uploadEndpoint = baseEndpoint + '?_wprc_token=' + encodeURIComponent(token);

            const formData = new FormData();
            formData.append('file', file, file.name);

            const res = await fetch(uploadEndpoint, {
                method:  'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,  // nginx / 설정된 Apache
                    'X-WPRC-Token':  token,               // Apache Authorization 차단 우회
                },
                body: formData,
            });

            if (!res.ok) {
                let errMsg = `이미지 업로드 실패 (${res.status})`;
                try {
                    const errJson = await res.json();
                    // WP_Error 응답: { code, message, data }
                    if (errJson.message) errMsg = errJson.message;
                } catch { /* JSON 파싱 실패 시 기본 메시지 사용 */ }
                console.error('[WPRC] 업로드 실패:', res.status, errMsg);
                _showToast(errMsg);
                return;
            }

            const data = await res.json();
            imageUrl = data.source_url || data.guid?.rendered || '';

            if (!imageUrl) {
                _showToast('이미지 URL을 받지 못했습니다');
                return;
            }

            // 소켓 전송: text 필드에 __IMG__ 접두사로 URL 인코딩
            const IMG_PREFIX = '__IMG__';
            const imgMsg = {
                roomId:      state.currentRoom,
                text:        IMG_PREFIX + imageUrl,
                type:        'image',
                imageUrl:    imageUrl,
                userId:      state.userId,
                displayName: state.displayName,
                timestamp:   Date.now(),
            };

            state.socket.emit('message:send', imgMsg);

            // 낙관적 렌더 (서버 에코 대기 없이 즉시 표시)
            appendMessage(imgMsg);
            saveMessageToLocal(imgMsg);

            _clearFileSelection();

        } catch (err) {
            console.error('[WPRC] 이미지 업로드 오류:', err);
            _showToast('이미지 전송 중 오류가 발생했습니다');
        } finally {
            loadingEl?.remove();
            if (attachBtn) attachBtn.disabled = false;
            if (sendBtn)   sendBtn.disabled   = false;
        }
    }

    /** File → base64 DataURL 변환 */
    function _fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    /** 이미지 라이트박스 */
    function _showLightbox(src) {
        const box = document.createElement('div');
        box.className = 'wprc-mob-lightbox';
        box.innerHTML = `
            <button class="wprc-mob-lightbox-close"><i class="fas fa-times"></i></button>
            <img src="${escapeHtml(src)}" alt="이미지">
        `;
        mobileRoot.appendChild(box);

        box.querySelector('.wprc-mob-lightbox-close').addEventListener('click', () => box.remove());
        box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function playNotificationSound() {
        try {
            const ctx  = new (window.AudioContext || window.webkitAudioContext)();
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.setValueAtTime(800, ctx.currentTime);
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
        } catch (e) { /* 자동 재생 정책 무시 */ }
    }

    function saveMessageToLocal(msg) {
        if (!msg?.roomId) return;
        const key  = 'wprc_hist_' + msg.roomId; // roomId로 고정 (room.name은 비동기 타이밍 문제로 불일치 가능)
        try {
            let history = JSON.parse(sessionStorage.getItem(key) || '[]');
            // 중복 방지: 같은 타임스탬프+userId 메시지는 저장 안 함
            const isDuplicate = history.some(
                (m) => m.timestamp === msg.timestamp && m.userId === msg.userId && m.text === msg.text
            );
            if (!isDuplicate) {
                history.push(msg);
                if (history.length > 100) history = history.slice(-100);
                sessionStorage.setItem(key, JSON.stringify(history));
            }
        } catch (e) { /* 무시 */ }
    }

    function loadMessagesFromLocal(room) {
        if (!room?.id) return;
        const key = 'wprc_hist_' + room.id;
        try {
            const history = JSON.parse(sessionStorage.getItem(key) || '[]');
            history.forEach((msg) => appendMessage(msg));
        } catch (e) { /* 무시 */ }
    }

    // ============================================================
    // 9. 앱 시작
    // ============================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})(mobileRoot); // IIFE에 rootEl 전달

} // end WPRC_InitMobileChat

// 숏코드 페이지 자동 실행
(function() {
    const root = document.querySelector('.wprc-is-mobile');
    if (root) WPRC_InitMobileChat(root);
})();