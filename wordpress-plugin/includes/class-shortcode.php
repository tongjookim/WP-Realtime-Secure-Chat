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

        ob_start();
        ?>
        <div id="wprc-chat-app" data-height="<?php echo $height; ?>">

            <?php if (!$is_logged_in && !$allow_guests): ?>
                <!-- 게스트 비허용 시 로그인 안내 -->
                <div class="wprc-login-required">
                    <div class="wprc-login-box">
                        <h3>로그인이 필요합니다</h3>
                        <p>채팅에 참여하려면 먼저 로그인해주세요.</p>
                        <a href="<?php echo wp_login_url(get_permalink()); ?>" class="wprc-btn wprc-btn-primary">로그인</a>
                    </div>
                </div>

            <?php elseif (!$is_logged_in && $allow_guests): ?>
                <!-- 게스트 닉네임 입력 폼 -->
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

            <!-- 메인 채팅 인터페이스 (JS에서 활성화) -->
            <div id="wprc-main" class="wprc-main" style="display:none; height:<?php echo $height; ?>px;">

                <!-- 좌측 사이드바: 채팅방/친구 목록 -->
                <aside id="wprc-sidebar" class="wprc-sidebar">
                    <!-- 탭 네비게이션 -->
                    <div class="wprc-tabs">
                        <button class="wprc-tab active" data-tab="rooms">채팅방</button>
                        <button class="wprc-tab" data-tab="friends">접속자</button>
                        <button class="wprc-tab" data-tab="settings">설정</button>
                    </div>

                    <!-- 채팅방 목록 -->
                    <div id="wprc-tab-rooms" class="wprc-tab-content active">
                        <div class="wprc-room-actions">
                            <button id="wprc-create-room" class="wprc-btn wprc-btn-sm">+ 새 채팅방</button>
                        </div>
                        <ul id="wprc-room-list" class="wprc-list"></ul>
                    </div>

                    <!-- 접속자(친구) 목록 -->
                    <div id="wprc-tab-friends" class="wprc-tab-content">
                        <div class="wprc-online-count">
                            접속자: <span id="wprc-online-count">0</span>명
                        </div>
                        <ul id="wprc-user-list" class="wprc-list"></ul>
                    </div>

                    <!-- 환경 설정 -->
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

                <!-- 우측 채팅 영역 -->
                <main id="wprc-chat-area" class="wprc-chat-area">
                    <!-- 채팅방 미선택 시 -->
                    <div id="wprc-no-room" class="wprc-no-room">
                        <div class="wprc-no-room-inner">
                            <h3>🔒 보안 채팅</h3>
                            <p>채팅방을 선택하거나 새로 만들어 대화를 시작하세요.</p>
                            <p class="wprc-note">모든 대화는 완전히 휘발성이며 어디에도 기록되지 않습니다.</p>
                        </div>
                    </div>

                    <!-- 채팅 헤더 -->
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

                    <!-- 메시지 영역 -->
                    <div id="wprc-messages" class="wprc-messages"></div>

                    <!-- 메시지 입력 -->
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

            <!-- 새 채팅방 생성 모달 -->
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
        <?php
        return ob_get_clean();
    }
}
