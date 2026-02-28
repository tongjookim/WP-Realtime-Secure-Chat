<?php
/**
 * 숏코드 처리 - 채팅 UI 렌더링
 * 사용법: [realtime_chat] 또는 [realtime_chat height="600"]
 */

class WPRC_Shortcode {

    private $jwt_handler;

    public function __construct(WPRC_JWT_Handler $jwt_handler) {
        $this->jwt_handler = $jwt_handler;
        add_shortcode('realtime_chat', [$this, 'render']);
    }

    public function render($atts) {
        $atts = shortcode_atts([
            'height' => '650',
        ], $atts, 'realtime_chat');

        $is_logged_in  = is_user_logged_in();
        $allow_guests  = get_option('wprc_allow_guests', true);
        $height        = intval($atts['height']);
        $node_url      = rtrim(get_option('wprc_node_server_url', 'https://chat.swn.kr'), '/');

        // ============================================================
        // ✅ 에셋 강제 로드 (숏코드 실행 시점에 직접 로드 → 페이지빌더 호환)
        // ============================================================
        wp_enqueue_style(
            'wprc-chat-style',
            WPRC_PLUGIN_URL . 'assets/css/chat.css',
            [],
            WPRC_VERSION
        );

        wp_enqueue_script(
            'socket-io-client',
            $node_url . '/socket.io/socket.io.js',
            [],
            '4.7.0',
            true
        );

        wp_enqueue_script(
            'wprc-chat-client',
            WPRC_PLUGIN_URL . 'assets/js/chat-client.js',
            ['socket-io-client'],
            WPRC_VERSION,
            true
        );

        // JS 설정값 전달
        $current_user = wp_get_current_user();
        $token = '';
        //if ($is_logged_in && defined('WPRC_HAS_JWT_LIB') && WPRC_HAS_JWT_LIB) {
        //    $token = $this->jwt_handler->generate_token($current_user);
        //}
        if ($is_logged_in) {
            $token = $this->jwt_handler->generate_token($current_user);
        }

        wp_localize_script('wprc-chat-client', 'WPRC_Config', [
            'nodeServerUrl' => $node_url,
            'restUrl'       => rest_url('wprc/v1/'),
            'nonce'         => wp_create_nonce('wp_rest'),
            'isLoggedIn'    => $is_logged_in,
            'userId'        => $is_logged_in ? $current_user->ID : 0,
            'displayName'   => $is_logged_in ? $current_user->display_name : '',
            'token'         => $token,
            'allowGuests'   => (bool) $allow_guests,
        ]);

        // ============================================================
        // HTML 출력
        // ============================================================
        ob_start();
        ?>
        <div id="wprc-chat-app" data-height="<?php echo $height; ?>" style="min-height:200px;">

            <div id="wprc-connection-status" style="padding:12px;background:#fff3cd;border:1px solid #ffc107;border-radius:8px;margin-bottom:12px;font-size:13px;display:none;">
                ⏳ 채팅 서버에 연결 중...
            </div>

            <?php if (!$is_logged_in && !$allow_guests): ?>
                <div class="wprc-login-required">
                    <div class="wprc-login-box">
                        <h3>로그인이 필요합니다</h3>
                        <p>채팅에 참여하려면 먼저 로그인해주세요.</p>
                        <a href="<?php echo wp_login_url(get_permalink()); ?>" class="wprc-btn wprc-btn-primary">로그인</a>
                    </div>
                </div>

            <?php elseif (!$is_logged_in && $allow_guests): ?>
                <div id="wprc-guest-form" class="wprc-guest-form">
                    <div class="wprc-login-box">
                        <h3>채팅 참여</h3>
                        <p>닉네임을 입력하고 채팅에 참여하세요.</p>
                        <div class="wprc-form-group">
                            <input type="text" id="wprc-guest-nickname" placeholder="닉네임 (최대 20자)"
                                   maxlength="20" autocomplete="off" />
                        </div>
                        <button type="button" id="wprc-guest-join" class="wprc-btn wprc-btn-primary">참여하기</button>
                        <p class="wprc-note">또는 <a href="<?php echo wp_login_url(get_permalink()); ?>">로그인</a>하여 참여</p>
                    </div>
                </div>
            <?php endif; ?>

            <div id="wprc-main" class="wprc-main" style="display:none; height:<?php echo $height; ?>px;">
                <aside id="wprc-sidebar" class="wprc-sidebar">
                    <div class="wprc-tabs">
                        <button class="wprc-tab active" data-tab="rooms">채팅방</button>
                        <button class="wprc-tab" data-tab="friends">접속자</button>
                        <button class="wprc-tab" data-tab="settings">설정</button>
                    </div>

                    <div id="wprc-tab-rooms" class="wprc-tab-content active">
                        <div class="wprc-room-actions">
                            <button id="wprc-create-room" class="wprc-btn wprc-btn-sm">+ 새 채팅방</button>
                        </div>
                        <ul id="wprc-room-list" class="wprc-list"></ul>
                    </div>

                    <div id="wprc-tab-friends" class="wprc-tab-content">
                        <div class="wprc-online-count">
                            접속자: <span id="wprc-online-count">0</span>명
                        </div>
                        <ul id="wprc-user-list" class="wprc-list"></ul>
                    </div>

                    <div id="wprc-tab-settings" class="wprc-tab-content">
                        <div class="wprc-settings-panel">
                            <div class="wprc-form-group">
                                <label>표시 닉네임</label>
                                <input type="text" id="wprc-setting-nickname" maxlength="20" />
                                <button id="wprc-save-nickname" class="wprc-btn wprc-btn-sm">변경</button>
                            </div>
                            <div class="wprc-form-group">
                                <label>알림음</label>
                                <label class="wprc-toggle">
                                    <input type="checkbox" id="wprc-setting-sound" checked />
                                    <span>새 메시지 알림음</span>
                                </label>
                            </div>
                            <div class="wprc-security-notice">
                                <strong>🔒 보안 안내</strong>
                                <p>모든 대화 내용은 서버에 저장되지 않습니다. 페이지를 나가면 대화 기록이 완전히 사라집니다.</p>
                            </div>
                        </div>
                    </div>
                </aside>

                <main id="wprc-chat-area" class="wprc-chat-area">
                    <div id="wprc-no-room" class="wprc-no-room">
                        <div class="wprc-no-room-inner">
                            <h3>🔒 보안 채팅</h3>
                            <p>채팅방을 선택하거나 새로 만들어 대화를 시작하세요.</p>
                            <p class="wprc-note">모든 대화는 완전히 휘발성이며 어디에도 기록되지 않습니다.</p>
                        </div>
                    </div>

                    <div id="wprc-chat-header" class="wprc-chat-header" style="display:none;">
                        <div class="wprc-chat-header-info">
                            <h4 id="wprc-current-room-name"></h4>
                            <span id="wprc-current-room-users" class="wprc-room-user-count"></span>
                        </div>
                        <div class="wprc-chat-header-actions">
                            <button id="wprc-invite-user" class="wprc-btn wprc-btn-sm" title="사용자 초대">👤+</button>
                            <button id="wprc-leave-room" class="wprc-btn wprc-btn-sm wprc-btn-danger" title="나가기">나가기</button>
                        </div>
                    </div>

                    <div id="wprc-messages" class="wprc-messages"></div>

                    <div id="wprc-input-area" class="wprc-input-area" style="display:none;">
                        <div class="wprc-typing-indicator" id="wprc-typing"></div>
                        <div class="wprc-input-row">
                            <input type="text" id="wprc-message-input" placeholder="메시지를 입력하세요..."
                                   autocomplete="off" maxlength="2000" />
                            <button id="wprc-send-btn" class="wprc-btn wprc-btn-primary">전송</button>
                        </div>
                    </div>
                </main>
            </div>

            <div id="wprc-modal-create-room" class="wprc-modal" style="display:none;">
                <div class="wprc-modal-content">
                    <h3>새 채팅방 만들기</h3>
                    <div class="wprc-form-group">
                        <label>채팅방 이름</label>
                        <input type="text" id="wprc-new-room-name" placeholder="채팅방 이름" maxlength="50" />
                    </div>
                    <div class="wprc-form-group">
                        <label>유형</label>
                        <select id="wprc-new-room-type">
                            <option value="public">공개 채팅방</option>
                            <option value="private">비공개 채팅방</option>
                        </select>
                    </div>
                    <div class="wprc-modal-actions">
                        <button id="wprc-confirm-create-room" class="wprc-btn wprc-btn-primary">만들기</button>
                        <button class="wprc-btn wprc-modal-close">취소</button>
                    </div>
                </div>
            </div>
        </div>

        <script>
        (function() {
            var statusEl = document.getElementById('wprc-connection-status');
            setTimeout(function() {
                if (typeof io === 'undefined') {
                    if (statusEl) {
                        statusEl.style.display = 'block';
                        statusEl.style.background = '#f8d7da';
                        statusEl.style.borderColor = '#f5c6cb';
                        statusEl.style.color = '#721c24';
                        statusEl.innerHTML = '❌ 채팅 서버(<?php echo esc_js($node_url); ?>)에 연결할 수 없습니다.<br>' +
                            '<small>서버가 실행 중인지 확인하세요.</small>';
                    }
                }
            }, 3000);
        })();
        </script>
        <?php
        return ob_get_clean();
    }
}
