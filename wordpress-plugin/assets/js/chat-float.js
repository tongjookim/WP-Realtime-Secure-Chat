/**
 * WP Realtime Secure Chat - 플로팅 위젯
 * 버튼 클릭 → CSS 로드 → 모달 HTML 삽입 → WPRC_InitMobileChat(root) 직접 호출
 */
(function () {
    'use strict';

    const config    = window.WPRC_Config || {};
    const pluginUrl = (config.pluginUrl  || '').replace(/\/$/, '');
    const serverUrl = (config.nodeServerUrl || '').replace(/\/$/, '');
    const version   = config.version || '1';

    const floatBtn   = document.getElementById('wprc-float-btn');
    const floatModal = document.getElementById('wprc-float-modal');
    const iconOpen   = document.getElementById('wprc-float-icon-open');
    const iconClose  = document.getElementById('wprc-float-icon-close');
    const badge      = document.getElementById('wprc-float-badge');

    if (!floatBtn || !floatModal) return;

    // 숏코드 풀페이지 채팅 페이지에선 버튼 숨김
    if (document.querySelector('#wprc-chat-app')) {
        const floatWrap = document.getElementById('wprc-float-wrap');
        if (floatWrap) floatWrap.style.display = 'none';
        return;
    }

    let isOpen    = false;
    let isMounted = false;
    let unread    = 0;

    function loadCSS(href, id) {
        if (document.getElementById(id)) return Promise.resolve();
        return new Promise((res) => {
            const link  = document.createElement('link');
            link.id     = id;
            link.rel    = 'stylesheet';
            link.href   = href;
            link.onload = res;
            link.onerror = res; // 실패해도 진행
            document.head.appendChild(link);
        });
    }

    function loadScript(src, id) {
        if (document.getElementById(id)) return Promise.resolve();
        return new Promise((res, rej) => {
            const s   = document.createElement('script');
            s.id      = id;
            s.src     = src;
            s.onload  = res;
            s.onerror = rej;
            document.body.appendChild(s);
        });
    }

    function buildModalHTML() {
        floatModal.innerHTML = `
            <div class="wprc-is-mobile"
                 style="position:relative;width:100%;height:100%;overflow:hidden;">
                <div class="wprc-mobile-wrapper"
                     style="display:flex;flex-direction:column;height:100%;">
                    <div class="wprc-mob-tab-header active"
                         style="display:flex;align-items:center;padding:14px 18px;
                                border-bottom:1px solid #f0f0f0;gap:10px;">
                        <h2 style="font-size:20px;font-weight:700;margin:0;
                                   color:#1a1a2e;flex:1;">채팅</h2>
                        <button id="wprc-float-close-inner"
                            style="background:none;border:none;cursor:pointer;
                                   padding:4px;color:#6b7280;font-size:20px;
                                   line-height:1;" aria-label="닫기">&#x2715;</button>
                    </div>
                    <div id="wprc-mobile-main"
                         style="flex:1;overflow-y:auto;background:#fff;">
                        <div id="wprc-mob-tab-friends"
                             class="wprc-mobile-tab-content active"></div>
                        <div id="wprc-mob-tab-rooms"
                             class="wprc-mobile-tab-content"></div>
                        <div id="wprc-mob-tab-settings"
                             class="wprc-mobile-tab-content"></div>
                    </div>
                    <nav class="wprc-mobile-nav" id="wprc-mobile-nav"></nav>
                </div>
            </div>`;

        document.getElementById('wprc-float-close-inner')
            ?.addEventListener('click', closeModal);
    }

    async function mountChat() {
        if (isMounted) return;
        isMounted = true;

        try {
            // 1) CSS 로드
            await Promise.all([
                loadCSS('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css', 'wprc-fa-css'),
                loadCSS(pluginUrl + '/assets/css/chat.css?v=' + version, 'wprc-chat-css'),
            ]);

            // 2) 모달 HTML 삽입 (.wprc-is-mobile 이 DOM에 생김)
            buildModalHTML();
            const root = floatModal.querySelector('.wprc-is-mobile');

            // 3) Socket.io 없으면 로드
            if (typeof io === 'undefined') {
                await loadScript(serverUrl + '/socket.io/socket.io.js', 'wprc-socketio');
            }

            // 4) mobile JS 없으면 로드 (이미 있으면 바로 전역 함수 호출)
            if (typeof WPRC_InitMobileChat === 'undefined') {
                await loadScript(pluginUrl + '/assets/js/chat-client-mobile.js?v=' + version, 'wprc-mobile-js');
            }

            // 5) 전역 함수로 직접 초기화 — rootEl 전달
            if (typeof WPRC_InitMobileChat === 'function') {
                WPRC_InitMobileChat(root);
            } else {
                throw new Error('WPRC_InitMobileChat 함수를 찾을 수 없습니다.');
            }

        } catch (e) {
            console.error('[WPRC Float] 초기화 실패:', e);
            floatModal.innerHTML = '<p style="padding:20px;color:#ef4444;">채팅을 불러오지 못했습니다.</p>';
        }
    }

    function openModal() {
        isOpen = true;
        floatModal.style.display = 'block';
        iconOpen.style.display   = 'none';
        iconClose.style.display  = 'block';
        resetBadge();
        mountChat();
    }

    function closeModal() {
        isOpen = false;
        floatModal.style.display = 'none';
        iconOpen.style.display   = 'block';
        iconClose.style.display  = 'none';
    }

    floatBtn.addEventListener('click', () => isOpen ? closeModal() : openModal());

    function resetBadge() {
        unread = 0;
        if (badge) badge.style.display = 'none';
    }

    document.addEventListener('wprc:unread', (e) => {
        if (isOpen) return;
        unread += (e.detail?.count || 1);
        if (badge) {
            badge.textContent   = unread > 99 ? '99+' : unread;
            badge.style.display = 'block';
        }
    });

})();
